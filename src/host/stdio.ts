/**
 * T-1 · stdio ServerTransport 实装（M3-S12）：宿主 → CAR 的 JSON-RPC over stdin/stdout
 *
 * 口径（M3系统设计增补 T-1 / M3部署设计增补 §4 多宿主拓扑：stdio 为 M3 主形态）：
 *  - 换行分隔 JSON-RPC 2.0（与 M1 client 侧 gateway 同帧格式）；
 *  - 方法面：initialize/notifications 握手（MCP 协议兼容）+ tools/list（10 tool 能力发现）+ tools/call（分发到 HostGateway.handle）；
 *  - 所有到达请求与响应均经 HostGateway 审计（无旁路）；未登记宿主在 handle 层拒绝；
 *  - stdin 结束（宿主退出）→ 通道关闭，进程内状态由审计日志承载（BD-02 等价：不静默丢数据）。
 *
 * 1.8（D-30 W3C traceparent server 侧提取）：tools/call params._meta 原样透传 dispatch 第三参——
 * 解析/校验归装配层（trace.ts parseTraceparent fail-open），传输层保持无协议语义；未知键对端
 * 忽略（MCP `_meta` 保留扩展点），缺席 = meta 缺省 undefined（既有调用方零改动）。
 */
import { createInterface } from 'node:readline'
import { HOST_TOOLS, type HostTool } from './hostGateway.ts'

export interface StdioDispatcher {
  (tool: string, args: Record<string, unknown>, meta?: { traceparent?: string }): Promise<{ ok: boolean; result?: unknown; error?: string }>
}

export interface StdioServer {
  /** 消费 stdin 行直到结束；返回处理请求数（供测试断言） */
  serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<number>
}

export function createStdioServer(dispatch: StdioDispatcher): StdioServer {
  let nextId = 0
  // 1.6-S2：tools/call 按请求序串行派发（会话态依赖 + 响应序确定性——JSON-RPC 允许乱序，
  // 但 stdio 宿主与测试按序解析；tools/list 等同步方法不受此链影响）
  let callChain: Promise<void> = Promise.resolve()
  return {
    async serve(input, output) {
      let count = 0
      const rl = createInterface({ input })
      const done = new Promise<void>(resolve => rl.on('close', resolve))
      rl.on('line', line => {
        const trimmed = line.trim()
        if (!trimmed) return
        count++
        let req: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
        try { req = JSON.parse(trimmed) } catch {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
          return
        }
        nextId++
        const respond = (result: unknown, error?: { code: number; message: string }) => {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: req.id ?? nextId, ...(error ? { error } : { result }) }) + '\n')
        }
        // MCP 协议握手（E-6 实连前置）：真实宿主客户端先发 initialize → 回 serverInfo；
        // notifications/initialized 为无 id 通知，不响应（协议规定）
        if (req.method === 'initialize') {
          respond({
            protocolVersion: (req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'car-runtime', version: '0.3.0' },
          })
          return
        }
        if (req.method === 'notifications/initialized' || (req.method ?? '').startsWith('notifications/')) {
          return // 通知无响应
        }
        if (req.method === 'tools/list') {
          respond({ tools: HOST_TOOLS.map((t: HostTool) => ({ name: t })) })
          return
        }
        if (req.method === 'tools/call') {
          const name = req.params?.name ?? ''
          const args = req.params?.arguments ?? {}
          // 1.8-D30：_meta 原样透传（解析归装配层）；缺席 = undefined
          const meta = (req.params as { _meta?: { traceparent?: string } } | undefined)?._meta
          callChain = callChain
            .then(() => dispatch(name, args, meta))
            .then(r => {
              if (r.ok) respond({ content: [{ type: 'text', text: JSON.stringify(r.result ?? {}) }], carOk: true })
              else respond(undefined, { code: -32000, message: r.error ?? 'host call failed' })
            })
            .catch(e => respond(undefined, { code: -32000, message: String(e) }))
          return
        }
        respond(undefined, { code: -32601, message: `unknown method "${req.method}"（支持 initialize / tools/list / tools/call）` })
      })
      await done
      await callChain // 串行链收口：进程退出前最后一批调用响应写完（win32 退出断言同源教训）
      return count
    },
  }
}
