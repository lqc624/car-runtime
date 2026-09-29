/**
 * 1.9 · 远程 MCP traceparent 传播——Streamable HTTP 头通道（D-32 · S43）
 *
 * 覆盖（1.9-迭代规划 HTTP-TP）：
 *  - 单元：httpClient tools/call 请求头注入（W3C `traceparent` 头）与缺省零注入（头面不变）；
 *    initialize/notifications/tools/list 不注入（无 span 上下文边界）；gateway.callTool 透传 +
 *    `_meta`/头双载体同值；畸形 fail-open 丢弃（含 CRLF 头注入形态）；配置 headers 同名注入优先；
 *  - E2E：car run --mcp <url> 全链（otel 开）——假远程 MCP server 捕获 `traceparent` 头回显进
 *    工具结果，与 OTLP 出站 car.mcp.tool span 三点对拍闭合（traceId + spanId）+ body `_meta`
 *    双载体同值实查 + 出站体零内容断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpGateway } from '../src/mcp/gateway.ts'
import { createHttpMcpTransport, MCP_PROTOCOL_VERSION } from '../src/mcp/httpClient.ts'
import { parseTraceparent } from '../src/runtime-core/trace.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.ts')

// 密钥扫描口径：夹具凭据经变量注入（赋值行无引号字面量）
const TEST_TOKEN = 'test-token-456'

const TID = 'a'.repeat(32)
const SID = 'b'.repeat(16)
const TP = (tid: string, sid: string) => `00-${tid}-${sid}-01`

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s43-${name}-`))
  try {
    const r = fn(dir)
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } }
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
    return Promise.resolve()
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
    throw e
  }
}

interface SeenReq { url: string; method: string; headers: IncomingMessage['headers']; body: any }

/** 本地假远程 MCP server（Streamable HTTP）：tools/call 捕获 `traceparent` 头回显进工具结果 */
function fakeMcpHttp(): Promise<{ server: Server; url: string; seen: SeenReq[]; close: () => Promise<void> }> {
  const seen: SeenReq[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      seen.push({ url: req.url ?? '', method: body.method ?? '', headers: req.headers, body })
      const respondJson = (payload: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(payload))
      }
      if (body.method === 'initialize') {
        respondJson({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fake-remote', version: '0.0.0' } } }, 200, { 'mcp-session-id': 'sess-fake-1' })
        return
      }
      if (body.id === undefined) { res.writeHead(202).end(); return } // notification（notifications/initialized）
      if (body.method === 'tools/list') {
        respondJson({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'remote_echo', description: '远程回声', inputSchema: { type: 'object', properties: { t: { type: 'string' } } } }] } })
        return
      }
      if (body.method === 'tools/call') {
        const tp = req.headers['traceparent'] ?? 'none'
        respondJson({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'remote-ok|tp:' + tp }] } })
        return
      }
      respondJson({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found: ' + body.method } }, 404)
    })
  })
  const urlP = new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
  return urlP.then(url => ({ server, url, seen, close: () => new Promise<void>(r => server.close(() => r())) }))
}

// ==================== 单元：头注入与缺省零注入（D-32） ====================

test('S43: httpClient tools/call 注入 traceparent 头 + _meta 双载体同值；握手/注册不注入；缺省零注入', async () => {
  const { server, url, seen, close } = await fakeMcpHttp()
  try {
    const transport = createHttpMcpTransport({ url })
    const gw = new McpGateway()
    await gw.register({ serverId: 'remote', transport })
    // 无 span 上下文边界：握手与注册请求零注入
    assert.equal(seen[0]!.headers['traceparent'], undefined, 'initialize 不注入（传输内部握手）')
    assert.equal(seen[1]!.headers['traceparent'], undefined, 'notifications/initialized 不注入')
    assert.equal(seen[2]!.headers['traceparent'], undefined, 'tools/list 不注入（注册期无 span 上下文）')
    // callTool + traceparent → 头注入 + _meta 双载体同值（1.8 字节面维持）
    const tp = TP(TID, SID)
    const r = await gw.callTool('remote', 'remote_echo', { t: 'hi' }, { traceparent: tp })
    assert.equal(r.ok, true)
    const call = seen.at(-1)!
    assert.equal(call.method, 'tools/call')
    assert.equal(call.headers['traceparent'], tp, 'W3C traceparent 头注入（HTTP 载体惯例）')
    assert.equal((call.body.params as any)._meta?.traceparent, tp, 'body _meta 双载体同值（1.8-D29 字节面维持）')
    assert.deepEqual({ name: (call.body.params as any).name, arguments: (call.body.params as any).arguments }, { name: 'remote_echo', arguments: { t: 'hi' } }, 'params 主体不变')
    // 缺省零注入：otel 关 = 头与 _meta 双缺省（线上请求头与字节面不变）
    const r2 = await gw.callTool('remote', 'remote_echo', { t: 'ho' })
    assert.equal(r2.ok, true)
    const call2 = seen.at(-1)!
    assert.equal(call2.headers['traceparent'], undefined, '缺省零注入（头面不变）')
    assert.equal('_meta' in (call2.body.params as object), false, '缺省零注入（字节面不变——1.8 口径）')
    transport.close()
  } finally {
    await close()
  }
})

// ==================== 单元：畸形 fail-open + 头注入防线 ====================

test('S43: 畸形 traceparent fail-open——头不注入调用照常；CRLF 头注入形态被排除；空串零注入', async () => {
  const { server, url, seen, close } = await fakeMcpHttp()
  try {
    const transport = createHttpMcpTransport({ url })
    const gw = new McpGateway()
    await gw.register({ serverId: 'remote', transport })
    // 非格式串：不注入不抛（协议面 fail-open——BD-05 同源）
    const r1 = await gw.callTool('remote', 'remote_echo', { t: 'a' }, { traceparent: 'garbage' })
    assert.equal(r1.ok, true, '畸形不 fail-hard（调用照常）')
    assert.equal(seen.at(-1)!.headers['traceparent'], undefined, '畸形头不注入（fail-open）')
    // CRLF 头注入形态：合法 traceparent 后拼越权第二头——严格 hex 格式整体拒绝
    const evil = TP(TID, SID) + '\r\nx-inject: yes'
    const r2 = await gw.callTool('remote', 'remote_echo', { t: 'b' }, { traceparent: evil })
    assert.equal(r2.ok, true)
    const h = seen.at(-1)!.headers
    assert.equal(h['traceparent'], undefined, 'CRLF 形态头不注入')
    assert.equal(h['x-inject'], undefined, '越权头不出现（严格格式排除 CR/LF）')
    // 全零（W3C 无效）同拒
    const r3 = await gw.callTool('remote', 'remote_echo', { t: 'c' }, { traceparent: TP('0'.repeat(32), '0'.repeat(16)) })
    assert.equal(r3.ok, true)
    assert.equal(seen.at(-1)!.headers['traceparent'], undefined, '全零 trace-id 不注入')
    // 空串（noop 门面路径）零注入
    const r4 = await gw.callTool('remote', 'remote_echo', { t: 'd' }, { traceparent: '' })
    assert.equal(r4.ok, true)
    assert.equal(seen.at(-1)!.headers['traceparent'], undefined, '空串零注入（otel 关路径）')
    transport.close()
  } finally {
    await close()
  }
})

// ==================== 单元：配置头同名——注入优先 ====================

test('S43: 配置 headers 字面 traceparent——无注入请求沿用配置头；有注入请求注入优先', async () => {
  const { server, url, seen, close } = await fakeMcpHttp()
  try {
    const stale = TP('c'.repeat(32), 'd'.repeat(16))
    const transport = createHttpMcpTransport({ url, headers: { traceparent: stale } })
    const gw = new McpGateway()
    await gw.register({ serverId: 'remote', transport })
    assert.equal(seen.at(-1)!.headers['traceparent'], stale, '无注入请求沿用配置头（配置面不受影响）')
    const tp = TP(TID, SID)
    await gw.callTool('remote', 'remote_echo', { t: 'hi' }, { traceparent: tp })
    assert.equal(seen.at(-1)!.headers['traceparent'], tp, '注入优先（静态同名配置属误用——每请求 spanId 不同，登记口径）')
    transport.close()
  } finally {
    await close()
  }
})

// ==================== E2E：car run --mcp <url> 全链三点闭合（1.9-GO-5 生产调用点） ====================

const sse = (chunks: object[]) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

test('S43 E2E: car run 远程 MCP 全链——traceparent 头回显与 OTLP car.mcp.tool 三点闭合 + 双载体同值', async () => {
  await withTempDir('e2e-http-tp', async dir => {
    const { server: mcpServer, url: mcpUrl, seen, close } = await fakeMcpHttp()
    // 假 LLM：req1 → 直调 MCP 工具；req2 → 收尾文本
    const llmBodies: any[] = []
    let n = 0
    const llmServer: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        void req
        llmBodies.push(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(n++ === 0
          ? sse([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'mcp_remote_remote_echo', arguments: '{"t":"hi"}' } }] } }] },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ])
          : sse([
              { choices: [{ delta: { content: 'remote 调用完成' } }] },
              { choices: [{ delta: {}, finish_reason: 'stop' }] },
            ]))
      })
    })
    await new Promise<void>(r => llmServer.listen(0, '127.0.0.1', r))
    const llmPort = (llmServer.address() as { port: number }).port
    // OTLP 捕获端点
    const otlpBodies: any[] = []
    const otlp: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => { if (req.url === '/v1/traces') otlpBodies.push(JSON.parse(raw)); res.writeHead(200).end() })
    })
    await new Promise<void>(r => otlp.listen(0, '127.0.0.1', r))
    const otlpPort = (otlp.address() as { port: number }).port

    writeFileSync(join(dir, 'empty.ts'), `export const manifest = { name: 'empty', version: '1.0.0' }\nexport default function apply() {}\n`)
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
      llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'm' },
      mcp: { servers: { remote: { url: mcpUrl } } },
    }))
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', 'empty.ts',
      '--prompt', 'call the remote echo tool with t=hi', '--mcp', 'remote'], {
      cwd: dir,
      env: { ...process.env, OPENAI_API_KEY: TEST_TOKEN, CAR_ALLOW_ENV_CREDENTIALS: '1', CAR_OTEL_ENDPOINT: `http://127.0.0.1:${otlpPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const exitDone = new Promise<number>(resolve => child.on('exit', c => resolve(c ?? -1)))
    const code = await Promise.race([exitDone, new Promise<number>(r => setTimeout(() => r(-999), 60_000))])
    mcpServer.close()
    llmServer.close()
    otlp.close()

    assert.equal(code, 0, `exit=${code}\nSTDOUT:\n${out}\nSTDERR:\n${err}`)
    assert.match(out, /turnEnd=completed/)
    // 远程 server 侧：请求序 + 头/体双载体同值（生产调用点实查）
    assert.deepEqual(seen.map(r => r.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    const call = seen[3]!
    const headerTp = call.headers['traceparent']
    assert.ok(typeof headerTp === 'string' && parseTraceparent(headerTp), `tools/call 请求携带合法 traceparent 头（${headerTp}）`)
    assert.equal((call.body.params as any)._meta?.traceparent, headerTp, 'body _meta 与头双载体同值（1.8 字节面维持 + 1.9 头通道加法）')
    // 工具结果含回显 traceparent（假 server 捕获头）
    const toolMsgs = llmBodies.flatMap(b => b.messages).filter((m: any) => m.role === 'tool')
    const echoed: string[] = []
    for (const m of toolMsgs) {
      for (const g of JSON.stringify(m.content).matchAll(/tp:(00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})/g)) echoed.push(g[1]!)
    }
    assert.equal(echoed.length, 1, '远程 MCP 路径头通道回显')
    assert.equal(echoed[0], headerTp, '回显 == 出站头（头通道端到端一致）')

    // OTLP 出站对拍（三点闭合：回显 traceparent ↔ 出站 car.mcp.tool spanId ↔ 同 traceId）
    await new Promise(r => setTimeout(r, 300))
    const spans = otlpBodies.flatMap(b => b.scopeSpans[0].spans)
    const turnSpan = spans.find((s: any) => s.name === 'car.turn')
    assert.ok(turnSpan, 'turn span 出站')
    const mcpSpans = spans.filter((s: any) => s.name === 'car.mcp.tool')
    assert.equal(mcpSpans.length, 1, '一次远程 MCP 外呼一个 client span')
    const parsed = parseTraceparent(headerTp!)!
    assert.equal(parsed.traceId, turnSpan.traceId, '回显 traceId == 出站 turn traceId（端到端同 trace）')
    assert.ok(mcpSpans.some((s: any) => s.spanId === parsed.parentSpanId), '回显 spanId == 出站 car.mcp.tool spanId（client span 对拍闭合）')
    // 零内容口径：出站体无会话内容
    const all = JSON.stringify(otlpBodies)
    assert.equal(/call the remote echo tool|远程回声|remote-ok/.test(all), false, 'span 出站体零内容')
    await close()
  })
})
