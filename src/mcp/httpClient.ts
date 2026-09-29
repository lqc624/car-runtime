/**
 * 1.5-S2 · MCP 远程传输客户端（D-21）：Streamable HTTP（2025-06-18 spec 单轨）
 *
 * 口径：
 *  - CAR → 远程 MCP Server 方向（gateway.ts ClientTransport 的第二真实通道——与 stdio 并列）；
 *  - 懒 initialize 握手：首次 send 前自动 initialize → notifications/initialized；
 *    响应 `Mcp-Session-Id` 头存在则后续请求回传（无会话头的 server 容许）；
 *  - 响应形态双兼容：application/json 单响应 / text/event-stream 逐事件取本请求 id
 *    （SSE 命中即收口，流显式 destroy——悬挂 socket 是 1.4-BUG-2 同源教训）；
 *  - **出站走 node:http(s) 不用 undici fetch**（1.4-BUG-2 已验证口径：win32 退出 libuv
 *    断言 0xC0000409 与 undici socket 相关，telemetry 出站同此先例）；TLS 门复用
 *    assertTlsOrLoopback（D-12a：http 仅豁免 loopback——本地假 server 与本地 MCP）；
 *  - send 内建 30s 超时（与 stdio 同口径；gateway BD-02 外层 race 不变）；
 *  - headers 凭据规则（CR-05 经配置通道执行）：值支持 `${ENV_VAR}` 引用（env 缺席显式报错）；
 *    字面值疑似明文凭据（containsPlaintextCredential 同款模式）直接拒绝——env 引用注入
 *    才是登记合规通道（展开后值不复查：引注入即目的，展开值是凭据本身）；
 *  - legacy HTTP+SSE（2024-11-05）不做（1.5 规划 D-21 登记不追溯）；
 *  - 1.9（D-32 远程 MCP 头通道）：send 加法可选第二参 opts.traceparent → tools/call 请求头
 *    加法 `traceparent`（W3C Trace Context HTTP 载体惯例——第三方 OTel 接入面主消费通道）；
 *    注入前 parseTraceparent 校验，畸形**不注入不抛**（协议面 fail-open——严格格式天然排除
 *    CR/LF，兼防头注入越权面）；otel 关 = 双载体零注入（头与 JSON-RPC 字节面不变）；
 *    initialize/notifications/tools/list 不注入（无 span 上下文——1.8 tools/list 口径延伸）；
 *    配置 headers 含字面 `traceparent` 时注入优先（动态 span 上下文为请求级事实，登记）。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ClientTransport, JsonRpcRequest, JsonRpcResponse } from './gateway.ts'
import { containsPlaintextCredential } from './gateway.ts'
import { assertTlsOrLoopback } from '../runtime-core/llm.ts'
import { parseTraceparent } from '../runtime-core/trace.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface HttpMcpServerSpec {
  url: string
  /** 已展开的请求头（明文禁令与 ${ENV} 展开由 resolveMcpHeaders 承担——直接传入者自证合规） */
  headers?: Record<string, string>
  /** 测试注入；缺省 30s（send 内建超时，与 stdio 同口径） */
  timeoutMs?: number
}

/** node:http(s) 响应的最小面（真实 res 兼容；测试可注入替身） */
export interface RawHttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** 流式响应体（node:http res 本身即 AsyncIterable<Uint8Array>；destroy 显式丢弃） */
  body: AsyncIterable<Uint8Array> & { destroy(): void }
}

/** node:http(s) POST 单发（1.4-BUG-2 口径：出站不走 undici；TLS 门由 createHttpMcpTransport 把守） */
export function rawPost(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<RawHttpResponse> {
  const u = new URL(url)
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(u, { method: 'POST', headers }, res => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: res as unknown as RawHttpResponse['body'],
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`CAR-E-MCP: http transport timeout (${timeoutMs}ms)`)))
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * ${ENV_VAR} 头引用展开（D-21）：值内任意位置的 `${NAME}` 均替换为 env.NAME（如
 * `Bearer ${TOKEN}`）；env 缺席显式报错（fail-visible，禁静默空值）；字面值疑似明文凭据
 * 直接拒绝（按原始值检查——展开值是凭据本身，引注入即目的）。
 */
export function resolveMcpHeaders(raw: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const cred = containsPlaintextCredential({ [k]: v })
    if (cred) throw new Error(`CAR-E-MCP: headers.${k}——${cred}（配置明文禁令 CR-05；请改用 \`\${ENV_VAR}\` 引用注入）`)
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => {
      const val = env[name]
      if (val === undefined || val === '') {
        throw new Error(`CAR-E-MCP: headers.${k} 引用的环境变量 ${name} 未设置（fail-visible，禁静默空值）`)
      }
      return val
    })
  }
  return out
}

export function createHttpMcpTransport(spec: HttpMcpServerSpec): ClientTransport {
  // D-12a TLS 门（与 LLM 适配器同款）：https 直接通过；http 仅豁免 loopback
  assertTlsOrLoopback(spec.url.replace(/\/+$/, ''))
  const timeoutMs = spec.timeoutMs ?? 30_000
  let sessionId: string | null = null
  let initialized = false
  let initPromise: Promise<void> | null = null
  let closed = false

  const baseHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...spec.headers,
  })

  /** 流全读（JSON 响应） */
  async function readAll(res: RawHttpResponse): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const chunk of res.body) parts.push(Buffer.from(chunk))
    return Buffer.concat(parts)
  }

  /** SSE 响应逐事件取本请求 id（data JSON 自带 id；命中即收口，流显式 destroy） */
  async function readSseForId(res: RawHttpResponse, id: number): Promise<JsonRpcResponse> {
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          let evt: any
          try { evt = JSON.parse(data) } catch { continue }
          if (evt?.id === id) return evt as JsonRpcResponse
        }
      }
    } finally {
      try { res.body.destroy() } catch { /* 流已自然结束 */ }
    }
    throw new Error('CAR-E-MCP: SSE 流结束未见本请求响应（阶段：read-response）')
  }

  async function postAndRead(body: unknown, matchId: number | null, phase: string, extraHeaders: Record<string, string> = {}): Promise<JsonRpcResponse> {
    // 1.9-D32：extraHeaders 展开在 baseHeaders 之后——配置头同名时注入优先（登记口径）
    const res = await rawPost(spec.url, { ...baseHeaders(), ...extraHeaders }, JSON.stringify(body), timeoutMs)
    const sid = res.headers['mcp-session-id']
    if (typeof sid === 'string') sessionId = sid
    if (res.status < 200 || res.status >= 300) {
      try { res.body.destroy() } catch { /* 已结束 */ }
      throw new Error(`CAR-E-MCP: HTTP ${res.status}（阶段：${phase}——server 拒绝或不可达）`)
    }
    const ct = String(res.headers['content-type'] ?? '')
    if (ct.includes('text/event-stream')) return readSseForId(res, matchId ?? Number.NaN)
    const json = JSON.parse((await readAll(res)).toString('utf-8')) as JsonRpcResponse
    return json
  }

  /** 懒 initialize 握手（首次 send 前恰好一次）：initialize → 会话头捕获 → notifications/initialized */
  async function doInitialize(): Promise<void> {
    const initRes = await postAndRead({
      jsonrpc: '2.0', id: -1, method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'car-runtime', version: '0.0.0' } },
    }, -1, 'initialize')
    if (initRes.error) {
      throw new Error(`CAR-E-MCP: initialize 被拒：${initRes.error.message}（阶段：initialize）`)
    }
    // notifications/initialized：无 id 通知——2xx/202 即视为送达（无响应体，显式丢弃）
    const res = await rawPost(spec.url, baseHeaders(), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), timeoutMs)
    try { res.body.destroy() } catch { /* 已结束 */ }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`CAR-E-MCP: notifications/initialized HTTP ${res.status}（阶段：initialized）`)
    }
  }

  /**
   * 1.9-D32：tools/call 请求的 `traceparent` 头（W3C Trace Context HTTP 载体惯例）——
   * parseTraceparent 校验 fail-open（畸形/空 = {} 不注入不抛；严格 hex 格式排除 CR/LF 头注入面）；
   * 与 body params._meta.traceparent 双载体同值并存（1.8-D29 `_meta` 面维持，头为主消费面）。
   */
  function callHeaders(tp: string | undefined): Record<string, string> {
    if (!tp || !parseTraceparent(tp)) return {}
    return { traceparent: tp }
  }

  const transport: ClientTransport = {
    send(req: JsonRpcRequest, opts?: { traceparent?: string }): Promise<JsonRpcResponse> {
      return (async (): Promise<JsonRpcResponse> => {
        if (closed) throw new Error('CAR-E-MCP: http transport closed（server 已收口）')
        if (!initialized) {
          initPromise ??= doInitialize().then(() => { initialized = true })
          try { await initPromise } catch (e) { initPromise = null; throw e }
        }
        return postAndRead(req, req.id, 'request', callHeaders(opts?.traceparent))
      })()
    },
    alive: () => !closed,
    close: () => { closed = true },
  }
  return transport
}
