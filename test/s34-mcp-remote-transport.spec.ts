/**
 * 1.5-S2 · 远程 MCP 传输（S34）：Streamable HTTP 客户端（D-21）
 *
 * 覆盖：
 *  - 懒 initialize 握手：首次 send 前 initialize → notifications/initialized（恰好一次）；
 *    Mcp-Session-Id 捕获与回传；无会话头 server 容许
 *  - 响应形态双兼容：application/json 单响应 / text/event-stream 逐事件取本请求 id
 *  - McpGateway 注册回路：tools/list → 声明面（T-22 缺省 write 不变）；tools/call 往返
 *  - resolveMcpHeaders：${ENV} 插值（值内任意位置）/ env 缺席显式报错 / 字面明文凭据拒绝
 *  - config 校验：command/url 互斥恰好其一 / url 形态 / 通道专属键（args/env 仅 command、headers 仅 url）
 *  - spawn CLI 全链：car run --mcp <url server>（1.5-GO-5 生产调用点——真 initialize→tools/list→tools/call）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpGateway, type JsonRpcRequest } from '../src/mcp/gateway.ts'
import { createHttpMcpTransport, resolveMcpHeaders, MCP_PROTOCOL_VERSION } from '../src/mcp/httpClient.ts'
import { loadCarConfig } from '../src/load/config.ts'

// 密钥扫描口径（generic-secret-assign）：夹具凭据经变量注入；值非真实凭据
const TEST_TOKEN = 'test-token-456'
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s34-${name}-`))
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

/** 本地假远程 MCP server（Streamable HTTP）：记录请求，按 method 分派；tools/list 可选 SSE 形态 */
function fakeMcpHttp(opts: { sseToolsList?: boolean; sessionId?: string | null; rejectAll?: boolean } = {}): Promise<{
  server: Server; url: string; seen: SeenReq[]; close: () => Promise<void>
}> {
  const seen: SeenReq[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      seen.push({ url: req.url ?? '', method: body.method ?? '', headers: req.headers, body })
      if (opts.rejectAll) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      const respondJson = (payload: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(payload))
      }
      const respondSse = (payload: unknown) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify(payload)}\n\n`)
      }
      if (body.method === 'initialize') {
        respondJson({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fake-remote', version: '0.0.0' } } }, 200, opts.sessionId === null ? {} : { 'mcp-session-id': opts.sessionId ?? 'sess-fake-1' })
        return
      }
      if (body.id === undefined) { res.writeHead(202).end(); return } // notification（notifications/initialized）
      if (body.method === 'tools/list') {
        const result = { tools: [{ name: 'remote_echo', description: '远程回声', inputSchema: { type: 'object', properties: { t: { type: 'string' } } } }] }
        opts.sseToolsList ? respondSse({ jsonrpc: '2.0', id: body.id, result }) : respondJson({ jsonrpc: '2.0', id: body.id, result })
        return
      }
      if (body.method === 'tools/call') {
        respondJson({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'remote-ok:' + JSON.stringify(body.params.arguments) }] } })
        return
      }
      respondJson({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found: ' + body.method } }, 404)
    })
  })
  const urlP = new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
  return urlP.then(url => ({ server, url, seen, close: () => new Promise<void>(r => server.close(() => r())) }))
}

// ==================== 传输客户端 ====================

test('S34: 懒 initialize 握手——首次 send 前 initialize→initialized 恰好一次 + 会话头捕获回传 + tools/list 注册', async () => {
  const { server, url, seen, close } = await fakeMcpHttp()
  try {
    const transport = createHttpMcpTransport({ url })
    const gw = new McpGateway()
    const tools = await gw.register({ serverId: 'remote', transport })
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.name, 'remote_echo')
    assert.equal(tools[0]!.declaredSideEffect, 'write', 'T-22：未声明 sideEffect 注册时强制 write（远程与 stdio 同口径）')
    // 请求序：initialize → notifications/initialized → tools/list
    assert.deepEqual(seen.map(r => r.method), ['initialize', 'notifications/initialized', 'tools/list'])
    assert.equal(seen[0]!.body.params.protocolVersion, MCP_PROTOCOL_VERSION)
    assert.equal(seen[0]!.body.params.clientInfo.name, 'car-runtime')
    // 会话头：initialize 请求无（尚未捕获）→ 后续请求回传
    assert.equal(seen[0]!.headers['mcp-session-id'], undefined)
    assert.equal(seen[2]!.headers['mcp-session-id'], 'sess-fake-1')
    // accept 双形态声明 + 二次 send 不再握手
    assert.match(String(seen[0]!.headers.accept), /application\/json/)
    assert.match(String(seen[0]!.headers.accept), /text\/event-stream/)
    const r = await gw.callTool('remote', 'remote_echo', { t: 'hi' })
    assert.equal(r.ok, true)
    assert.deepEqual(seen.map(m => m.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'], 'initialize 恰好一次')
    // 声明面=授权面：gateway 声明面含远程工具
    assert.equal(gw.listTools().some(t => t.serverId === 'remote' && t.name === 'remote_echo'), true)
    transport.close()
  } finally {
    await close()
  }
})

test('S34: SSE 响应形态——tools/list 以 text/event-stream 回包逐事件取本请求 id；无会话头 server 容许', async () => {
  const { server, url, seen, close } = await fakeMcpHttp({ sseToolsList: true, sessionId: null })
  try {
    const transport = createHttpMcpTransport({ url })
    const gw = new McpGateway()
    const tools = await gw.register({ serverId: 'r2', transport })
    assert.equal(tools.length, 1, 'SSE 流内 tools/list 响应正确解析')
    assert.equal(seen[2]!.headers['mcp-session-id'], undefined, '无会话头 server 不回传（容许）')
    transport.close()
  } finally {
    await close()
  }
})

test('S34: closed 传输显式拒绝 + HTTP 错误 fail-visible（阶段名在错误信息）', async () => {
  const { server, url, close } = await fakeMcpHttp({ rejectAll: true })
  try {
    const transport = createHttpMcpTransport({ url })
    transport.close()
    await assert.rejects(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), /closed/)
    const bad = createHttpMcpTransport({ url })
    await assert.rejects(() => bad.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), /HTTP 403.*initialize/)
    bad.close()
  } finally {
    await close()
  }
})

// ==================== headers 凭据规则（D-21 / CR-05） ====================

test('S34: resolveMcpHeaders——${ENV} 值内插值 / env 缺席显式报错 / 字面明文凭据拒绝', () => {
  const env = { CAR_MCP_TOKEN: TEST_TOKEN }
  assert.deepEqual(resolveMcpHeaders({ authorization: `Bearer \${CAR_MCP_TOKEN}` }, env), { authorization: `Bearer ${TEST_TOKEN}` })
  assert.deepEqual(resolveMcpHeaders({ 'x-flag': 'plain' }, env), { 'x-flag': 'plain' })
  assert.throws(() => resolveMcpHeaders({ authorization: 'Bearer ${CAR_MCP_MISSING}' }, env), /CAR_MCP_MISSING.*未设置/, 'env 缺席 fail-visible')
  assert.throws(() => resolveMcpHeaders({ 'x-api-key': `sk-literal-123456789` }, env), /plaintext credential/, '字面 sk- 值拒绝（CR-05 配置明文禁令）')
})

// ==================== config 校验（command/url 互斥 + 通道专属键） ====================

test('S34: mcp.servers url/headers 键位——互斥恰好其一 / url 形态 / 通道专属键 fail-visible', () => {
  const load = (raw: unknown) => {
    const p = join(withTmp(), 'c.json')
    writeFileSync(p, JSON.stringify(raw))
    return loadCarConfig({ explicitPath: p })
  }
  const withTmp = () => mkdtempSync(join(tmpdir(), 'car-s34-cfg-'))
  // command + url 同给 = 显式报错
  assert.match(load({ mcp: { servers: { a: { command: 'node', url: 'https://x.test' } } } }).error!, /恰好其一/)
  // 都缺 = 显式报错
  assert.match(load({ mcp: { servers: { a: { args: ['x'] } } } }).error!, /恰好其一/)
  // url 形态
  assert.match(load({ mcp: { servers: { a: { url: 'ftp://x' } } } }).error!, /http\(s\) URL/)
  // 通道专属键
  assert.match(load({ mcp: { servers: { a: { url: 'https://x.test', args: ['x'] } } } }).error!, /args 仅 stdio 通道/)
  assert.match(load({ mcp: { servers: { a: { url: 'https://x.test', env: { K: 'v' } } } } }).error!, /env 仅 stdio 通道/)
  assert.match(load({ mcp: { servers: { a: { command: 'node', headers: { h: 'v' } } } } }).error!, /headers 仅远程通道/)
  // 有效：url + headers
  const ok = load({ mcp: { servers: { a: { url: 'https://x.test/mcp', headers: { authorization: 'Bearer ${T}' } } } } })
  assert.equal(ok.error, undefined)
  assert.deepEqual(ok.config.mcp?.servers?.a, { url: 'https://x.test/mcp', headers: { authorization: 'Bearer ${T}' } })
  // 有效：command（存量键位兼容）
  const ok2 = load({ mcp: { servers: { b: { command: 'node', args: ['s.js'] } } } })
  assert.equal(ok2.error, undefined)
})

// ==================== spawn CLI 全链（1.5-GO-5） ====================

test('S34: spawn CLI 全链——car run --mcp 远程 server（initialize→tools/list→tools/call 进 turn）', async () => {
  await withTempDir('cli-remote', async dir => {
    const { server, url: mcpUrl, seen, close } = await fakeMcpHttp()
    let llmHits = 0
    const llm = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        void req
        const sse = (events: object[]) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n')
        }
        // 请求序驱动：首轮出 tool_calls（MCP 工具名在 tools[0].function.name——openai 出站体），
        // 次轮收尾文本；同时校验 MCP 工具确实进了声明面
        const n = llmHits++
        if (n === 0) {
          const body = JSON.parse(raw)
          assert.equal(body.tools?.[0]?.function?.name, 'mcp_remote_remote_echo', 'MCP 远程工具进声明面')
          sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'mcp_remote_remote_echo', arguments: '{"t":"hi"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ])
          return
        }
        sse([
          { choices: [{ delta: { content: 'remote 调用完成' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])
      })
    })
    await new Promise<void>(r => llm.listen(0, '127.0.0.1', r))
    const llmPort = (llm.address() as { port: number }).port
    writeFileSync(join(dir, 'empty.ts'), `export const manifest = { name: 'empty', version: '1.0.0' }\nexport default function apply() {}\n`)
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
      llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'm' },
      mcp: { servers: { remote: { url: mcpUrl, headers: { authorization: `Bearer \${CAR_MCP_TOKEN}` } } } },
    }))
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', 'empty.ts',
      '--prompt', 'call the remote echo tool with t=hi', '--mcp', 'remote'], {
      cwd: dir,
      env: { ...process.env, OPENAI_API_KEY: TEST_TOKEN, CAR_ALLOW_ENV_CREDENTIALS: '1', CAR_MCP_TOKEN: TEST_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const code = await new Promise<number>(resolve => child.on('exit', c => resolve(c ?? -1)))
    server.close()
    llm.close()
    assert.equal(code, 0, err + out)
    assert.match(out, /\[MCP\] remote: 1 工具入声明面/)
    assert.match(out, /turnEnd=completed/)
    // 远程 server 侧：真握手 + 调用（Authorization 头 ${ENV} 展开）
    assert.deepEqual(seen.map(r => r.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    assert.equal(seen[3]!.headers.authorization, `Bearer ${TEST_TOKEN}`)
    assert.deepEqual(seen[3]!.body.params, { name: 'remote_echo', arguments: { t: 'hi' } })
    await close()
  })
})
