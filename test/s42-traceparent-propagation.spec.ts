/**
 * 1.8 · W3C traceparent 跨进程传播（D-29/D-30/D-31 · S42）
 *
 * 覆盖（1.8-迭代规划 TRACE-1/2/3）：
 *  - 单元：W3C 编解码（合法/畸形/全零 fail-open）；mcpToolSpan client span（挂 turn + traceparent
 *    形态 + noop 零注入）；startTurn opts.trace 远端挂链；ptcRelay relay span（worker 时刻覆盖 +
 *    error 路径）；gateway.callTool `_meta` 注入与缺省不注入（字节面兼容）；
 *  - E2E-A：car run --mcp --ptc 全链——假 MCP server 捕获 `_meta.traceparent` 回显进工具结果，
 *    与 OTLP 出站 car.mcp.tool span 三点对拍闭合（traceId + spanId）+ car.ptc relay span 挂链
 *    turn + worker 计时窗口；零内容断言（结果文本/提示词不出站）；
 *  - E2E-B：mcp-serve 收 `_meta.traceparent` → car.turn span 加入宿主 trace（traceId 复用 +
 *    parentSpanId = 远端 spanId）；畸形 traceparent fail-open 新 trace。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTelemetryFacade } from '../src/runtime-core/telemetry.ts'
import { TurnTracer, formatTraceparent, parseTraceparent } from '../src/runtime-core/trace.ts'
import { McpGateway, type ClientTransport, type JsonRpcRequest, type JsonRpcResponse } from '../src/mcp/gateway.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.ts')

const okRes = () => ({ ok: true, status: 200 }) as unknown as Response

// 密钥扫描口径：夹具凭据经变量注入（赋值行无引号字面量）
const TEST_KEY = 'test-key-123'

function withTempDir(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s42-${name}-`))
  return fn(dir).finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } })
}

const sse = (chunks: object[]) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

// ==================== 单元：W3C 编解码（D-29） ====================

test('S42: formatTraceparent/parseTraceparent——W3C 形态 + 畸形 fail-open（null 不抛）', () => {
  const tid = 'a'.repeat(32)
  const sid = 'b'.repeat(16)
  assert.equal(formatTraceparent(tid, sid), `00-${tid}-${sid}-01`, 'flags 01（本端记录中）')
  assert.deepEqual(parseTraceparent(`00-${tid}-${sid}-01`), { traceId: tid, parentSpanId: sid })
  assert.deepEqual(parseTraceparent(`00-${tid}-${sid}-ff`), { traceId: tid, parentSpanId: sid }, 'flags 任意值接受（挂链不消费 flags）')
  // 畸形 fail-open：全 null 不抛（遥测面禁 fail-hard——BD-05 同源）
  assert.equal(parseTraceparent('garbage'), null, '非格式串')
  assert.equal(parseTraceparent(`ff-${tid}-${sid}-01`), null, 'version 非 00')
  assert.equal(parseTraceparent(`00-${'a'.repeat(31)}-${sid}-01`), null, 'trace-id 错长')
  assert.equal(parseTraceparent(`00-${tid}-${'b'.repeat(15)}-01`), null, 'span-id 错长')
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-${sid}-01`), null, 'trace-id 全零（W3C 无效）')
  assert.equal(parseTraceparent(`00-${tid}-${'0'.repeat(16)}-01`), null, 'span-id 全零（W3C 无效）')
  assert.equal(parseTraceparent(`00-${'g'.repeat(32)}-${sid}-01`), null, '非 hex')
  // 自研 id 形态天然合规：16B/8B hex 往返
  const rt = parseTraceparent(formatTraceparent(tid, sid))
  assert.deepEqual(rt, { traceId: tid, parentSpanId: sid }, 'format→parse 往返一致')
})

// ==================== 单元：mcpToolSpan client span（D-29） ====================

test('S42: mcpToolSpan——car.mcp.tool 挂 turn + traceparent 形态；noop 门面 traceparent 零注入', async () => {
  await withTempDir('client-span', async () => {
    const bodies: any[] = []
    const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
    })
    const tracer = new TurnTracer(f)
    const turn = tracer.startTurn('T0')
    const span = turn.mcpToolSpan('helper', 'upper')
    // traceparent 形态 = 00-{turn traceId}-{本 span spanId}-01
    const parsed = parseTraceparent(span.traceparent)
    assert.ok(parsed, 'traceparent 可解析')
    assert.equal(parsed!.traceId, turn.traceId, 'client span traceId = turn traceId')
    span.end('ok')
    const span2 = turn.mcpToolSpan('helper', 'upper')
    span2.recordException(new Error('boom'))
    span2.end('error')
    turn.end('completed')
    await f.flush()
    const spans = bodies.flatMap(b => b.scopeSpans[0].spans)
    const mcp = spans.filter((s: any) => s.name === 'car.mcp.tool')
    assert.equal(mcp.length, 2, '两次外呼两个 client span')
    assert.equal(mcp[0].parentSpanId, spans.find((s: any) => s.name === 'car.turn').spanId, 'client span 父 = turn spanId')
    assert.equal(mcp[0].traceId, turn.traceId, '共享 trace')
    const attrs = Object.fromEntries(mcp[0].attributes.map((a: any) => [a.key, a.value.stringValue]))
    assert.equal(attrs['car.mcp_server'], 'helper', 'serverId 标识符面（零内容口径扩展登记）')
    assert.equal(attrs['car.tool'], 'upper')
    assert.equal(attrs['car.outcome'], 'ok')
    // 本 span spanId 与 traceparent 三点一致（E2E-A 端到端对拍的单元基线）
    const outSpanId = mcp[0].spanId
    assert.equal(parsed!.parentSpanId, outSpanId, 'traceparent spanId = 出站 spanId')
    const errAttrs = Object.fromEntries(mcp[1].attributes.map((a: any) => [a.key, a.value.stringValue]))
    assert.equal(errAttrs['car.outcome'], 'error')
    assert.equal(mcp[1].status.code, 'STATUS_CODE_ERROR', 'error 路径 D-26 形态')
    // noop 门面：traceparent=''（调用方不注入 _meta——字节面兼容线）
    const noopTracer = new TurnTracer(createTelemetryFacade(null))
    const noopSpan = noopTracer.startTurn('T0').mcpToolSpan('helper', 'upper')
    assert.equal(noopSpan.traceparent, '', 'noop 零注入面')
    noopSpan.end('ok')
    noopTracer.startTurn('T0').ptcRelay().complete(0, 0, 'ok') // noop relay 零抛
  })
})

// ==================== 单元：startTurn 远端挂链（D-30） + ptcRelay（D-31） ====================

test('S42: startTurn opts.trace——turn span 加入远端 trace（traceId 复用 + parentSpanId）', async () => {
  await withTempDir('server-link', async () => {
    const bodies: any[] = []
    const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
    })
    const tracer = new TurnTracer(f)
    const remoteTraceId = 'c'.repeat(32)
    const remoteSpanId = 'd'.repeat(16)
    const turn = tracer.startTurn('', { trace: { traceId: remoteTraceId, parentSpanId: remoteSpanId } })
    turn.setTurnId('T1')
    turn.end('completed')
    await f.flush()
    const spans = bodies.flatMap(b => b.scopeSpans[0].spans)
    const t = spans.find((s: any) => s.name === 'car.turn')
    assert.equal(t.traceId, remoteTraceId, 'traceId 复用远端（加入宿主 trace）')
    assert.equal(t.parentSpanId, remoteSpanId, 'parentSpanId = 远端 spanId')
    // step 子 span 同 trace 挂 turn（挂链后层级不破坏）
    const turn2 = tracer.startTurn('', { trace: { traceId: remoteTraceId, parentSpanId: remoteSpanId } })
    turn2.stepSpan(1).end('stop')
    turn2.end('completed')
    await f.flush()
    const spans2 = bodies.flatMap(b => b.scopeSpans[0].spans)
    const step = spans2.find((s: any) => s.name === 'car.step')
    assert.equal(step.traceId, remoteTraceId)
    assert.equal(step.parentSpanId, spans2.filter((s: any) => s.name === 'car.turn').at(-1)!.spanId)
  })
})

test('S42: ptcRelay——car.ptc span 主线程收口（worker 时刻覆盖 + 挂链 turn + error 形态）', async () => {
  await withTempDir('ptc-relay', async () => {
    const bodies: any[] = []
    const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
    })
    const tracer = new TurnTracer(f)
    const turn = tracer.startTurn('T0')
    const relay = turn.ptcRelay()
    assert.deepEqual(relay.workerTrace, { traceId: turn.traceId, parentSpanId: turn.spanId }, 'workerTrace 载荷 = turn 挂链')
    // ok 路径：worker 计时时刻覆盖（1000→1060 不经 now()——精确出站）
    relay.complete(1000, 1060, 'ok')
    // error 路径：recordException D-26 形态
    turn.ptcRelay().complete(2000, 2250, 'error', new Error('boom'))
    turn.end('completed')
    await f.flush()
    const spans = bodies.flatMap(b => b.scopeSpans[0].spans)
    const ptc = spans.filter((s: any) => s.name === 'car.ptc')
    assert.equal(ptc.length, 2)
    assert.equal(ptc[0].startTimeUnixNano, String(1000 * 1e6), 'startMs 时刻覆盖（非 now()）')
    assert.equal(ptc[0].endTimeUnixNano, String(1060 * 1e6), 'endMs 时刻覆盖')
    assert.equal(ptc[0].parentSpanId, turn.spanId, 'car.ptc 挂 turn')
    assert.equal(ptc[0].traceId, turn.traceId, '同 trace')
    assert.equal(ptc[0].status.code, 'STATUS_CODE_UNSET')
    assert.equal(ptc[1].status.code, 'STATUS_CODE_ERROR', 'error 路径 status')
    const ev = ptc[1].events?.find((e: any) => e.name === 'exception')
    assert.ok(ev, 'error 路径 exception 事件（D-26）')
    // 负时长防线：endMs < startMs 收口为 startMs（防御下游转换器）
    turn.ptcRelay().complete(3000, 2999, 'ok')
    turn.end('completed')
    await f.flush()
    const ptc3 = bodies.flatMap(b => b.scopeSpans[0].spans).filter((s: any) => s.name === 'car.ptc').at(-1)!
    assert.equal(ptc3.endTimeUnixNano, ptc3.startTimeUnixNano, '负时长钳制')
    // noop 门面：workerTrace null + complete 零出站
    const noopRelay = new TurnTracer(createTelemetryFacade(null)).startTurn('T0').ptcRelay()
    assert.equal(noopRelay.workerTrace, null)
    noopRelay.complete(0, 0, 'ok')
  })
})

// ==================== 单元：gateway.callTool `_meta` 注入（D-29） ====================

test('S42: callTool traceparent 注入 params._meta；缺省无 _meta 键（字节面兼容）', async () => {
  await withTempDir('meta', async () => {
    const sent: JsonRpcRequest[] = []
    const transport: ClientTransport = {
      send: async (req) => {
        sent.push(req)
        // tools/list 需回工具面（登记制：无工具则 callTool 不发送直接 unknown tool）
        const result = req.method === 'tools/list'
          ? { tools: [{ name: 'upper', sideEffect: 'readonly' }] }
          : {}
        return { jsonrpc: '2.0', id: req.id, result } as JsonRpcResponse
      },
      alive: () => true,
      close: () => {},
    }
    const gw = new McpGateway()
    await gw.register({ serverId: 'helper', transport })
    sent.length = 0
    await gw.callTool('helper', 'upper', { text: 'x' }, { traceparent: formatTraceparent('a'.repeat(32), 'b'.repeat(16)) })
    assert.equal((sent[0].params as any)._meta?.traceparent, formatTraceparent('a'.repeat(32), 'b'.repeat(16)), '_meta.traceparent 注入')
    assert.equal(sent[0].params && 'name' in (sent[0].params as object), true, 'params.name 保持')
    await gw.callTool('helper', 'upper', { text: 'x' })
    const p2 = sent[1].params as Record<string, unknown>
    assert.equal('_meta' in p2, false, '缺省不注入（线上 JSON-RPC 字节面不变）')
    await gw.callTool('helper', 'upper', { text: 'x' }, { traceparent: '' })
    assert.equal('_meta' in (sent[2].params as object), false, '空串不注入（noop 门面路径）')
  })
})

// ==================== E2E-A：car run --mcp --ptc 全链（D-29/D-31 生产调用点） ====================

/** 受控 stdio MCP server（node 脚本文本）：tools/call 捕获 _meta.traceparent 回显进工具结果 */
const FAKE_MCP_SERVER = `
const lines = [];
let buf = '';
process.stdin.on('data', d => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === 'tools/list') {
      reply(req, { tools: [{ name: 'upper', description: '大写工具', sideEffect: 'readonly', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
    } else if (req.method === 'tools/call') {
      const tp = (req.params._meta || {}).traceparent || 'none';
      reply(req, { content: [{ type: 'text', text: String(req.params.arguments.text).toUpperCase() + '|tp:' + tp }] });
    }
  }
});
function reply(req, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n'); }
`

const RUN_CODE = `const r = await tools.mcp_helper_upper({ text: 'abc' })\nawait new Promise(res => setTimeout(res, 60))\nreturn r`

test('S42 E2E-A: car run 全链——_meta.traceparent 与 OTLP car.mcp.tool 三点闭合 + car.ptc relay span', async () => {
  await withTempDir('full-chain', async dir => {
    // 插件（run 首位参数——s32 同款装配面）
    writeFileSync(join(dir, 'p.ts'), `export const manifest = { name: 'p', version: '1.0.0' }\n` +
      `export default function apply() {}\n`)
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
      llm: { model: 'test-model' },
      mcp: { servers: { helper: { command: process.execPath, args: ['-e', FAKE_MCP_SERVER] } } },
    }))
    // 假 LLM：req1 → run_code（worker 桥调 MCP）；req2 → 直调 MCP 工具；req3 → done
    const llmBodies: any[] = []
    let n = 0
    const llmServer: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        llmBodies.push(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(n++ === 0
          ? sse([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_code', arguments: JSON.stringify({ code: RUN_CODE, description: '经桥调 MCP 大写' } ) } }] } }] },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ])
          : n === 2
            ? sse([
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'mcp_helper_upper', arguments: JSON.stringify({ text: 'xyz' } ) } }] } }] },
                { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              ])
            : sse([{ choices: [{ delta: { role: 'assistant', content: '' } }] }, { choices: [{ delta: { content: 'done' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
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

    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', 'p.ts',
      '--prompt', 'uppercase please', '--base-url', `http://127.0.0.1:${llmPort}/v1`,
      '--mcp', 'helper', '--ptc'], {
      cwd: dir,
      env: { ...process.env, OPENAI_API_KEY: TEST_KEY, CAR_ALLOW_ENV_CREDENTIALS: '1', CAR_OTEL_ENDPOINT: `http://127.0.0.1:${otlpPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const exitDone = new Promise<number>(resolve => child.on('exit', c => resolve(c ?? -1)))
    const code = await Promise.race([exitDone, new Promise<number>(r => setTimeout(() => r(-999), 60_000))])
    llmServer.close()
    otlp.close()

    assert.equal(code, 0, `exit=${code}\nSTDOUT:\n${out}\nSTDERR:\n${err}`)
    assert.match(out, /turnEnd=completed/)
    // 工具结果含回显 traceparent（假 MCP server 捕获 _meta）——桥内与直调两条路径
    const toolMsgs = llmBodies.flatMap(b => b.messages).filter((m: any) => m.role === 'tool')
    const echoed: string[] = []
    for (const m of toolMsgs) {
      const s = JSON.stringify(m.content)
      for (const g of s.matchAll(/tp:(00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})/g)) echoed.push(g[1]!)
    }
    assert.ok(echoed.length >= 2, `两条 MCP 路径均回显 traceparent（${JSON.stringify(echoed)}）`)

    // OTLP 出站对拍（三点闭合：回显 traceparent ↔ 出站 car.mcp.tool spanId ↔ 同 traceId）
    await new Promise(r => setTimeout(r, 300))
    const spans = otlpBodies.flatMap(b => b.scopeSpans[0].spans)
    const turnSpan = spans.find((s: any) => s.name === 'car.turn')
    assert.ok(turnSpan, 'turn span 出站')
    const mcpSpans = spans.filter((s: any) => s.name === 'car.mcp.tool')
    assert.equal(mcpSpans.length, 2, '两次 MCP 外呼两个 client span')
    for (const s of mcpSpans) {
      assert.equal(s.parentSpanId, turnSpan.spanId, 'client span 父 = turn')
      assert.equal(s.traceId, turnSpan.traceId, '同 trace')
    }
    const outSpanIds = new Set(mcpSpans.map((s: any) => s.spanId))
    const outTraceId = turnSpan.traceId
    for (const tp of echoed) {
      const p = parseTraceparent(tp)!
      assert.ok(p, `回显 traceparent 可解析：${tp}`)
      assert.equal(p.traceId, outTraceId, '回显 traceId == 出站 turn traceId（端到端同 trace）')
      assert.ok(outSpanIds.has(p.parentSpanId), '回显 spanId == 出站 car.mcp.tool spanId（client span 对拍闭合）')
    }
    // car.ptc relay span：挂链 turn + worker 计时窗口（程序含 60ms sleep）
    const ptcSpan = spans.find((s: any) => s.name === 'car.ptc')
    assert.ok(ptcSpan, 'car.ptc relay span 出站')
    assert.equal(ptcSpan.parentSpanId, turnSpan.spanId, 'car.ptc 挂 turn')
    assert.equal(ptcSpan.traceId, turnSpan.traceId, 'car.ptc 同 trace')
    const durMs = (Number(ptcSpan.endTimeUnixNano) - Number(ptcSpan.startTimeUnixNano)) / 1e6
    assert.ok(durMs >= 50 && durMs < 5000, `worker 计时窗口 ≈ 程序 sleep（${durMs.toFixed(1)}ms）`)
    assert.equal(ptcSpan.status.code, 'STATUS_CODE_UNSET', 'ok 路径无 exception')
    // 零内容口径：出站体无会话内容（提示词/工具结果文本/程序体不出站）
    const all = JSON.stringify(otlpBodies)
    assert.equal(/uppercase please|大写工具|setTimeout/.test(all), false, 'span 出站体零内容')
  })
})

// ==================== E2E-B：mcp-serve 收 traceparent 挂链（D-30 生产调用点） ====================

test('S42 E2E-B: mcp-serve——_meta.traceparent 合法挂链远端 trace；畸形 fail-open 新 trace', async () => {
  await withTempDir('mcp-serve', async dir => {
    const traceBodies: any[] = []
    let done: (v: void) => void = () => {}
    const closed = new Promise<void>(r => { done = r })
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        if (req.url === '/v1/traces') traceBodies.push(JSON.parse(body))
        res.writeHead(200).end()
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve'], {
        cwd: dir,
        env: { ...process.env, CAR_OTEL_ENDPOINT: `http://127.0.0.1:${port}`, CAR_OTEL_INTERVAL_MS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', d => { err += d })
      child.on('exit', () => done())
      const { deriveSessionId } = await import('../src/host/mappings.ts')
      const sid = deriveSessionId('claude-code', 's42-link')
      const remoteTraceId = 'c'.repeat(32)
      const remoteSpanId = 'd'.repeat(16)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's42-link' } } }) + '\n')
      // 合法 traceparent → turn span 加入宿主 trace
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'session_turn',
          arguments: { sessionId: sid, input: { events: [{ hostEvent: 'user_message', payload: { content: 'hi' } }, { hostEvent: 'turn_complete' }] } },
          _meta: { traceparent: formatTraceparent(remoteTraceId, remoteSpanId) },
        },
      }) + '\n')
      // 畸形 traceparent → fail-open 新 trace（不 fail-hard）
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'session_turn',
          arguments: { sessionId: sid, input: { events: [{ hostEvent: 'user_message', payload: { content: 'ho' } }, { hostEvent: 'turn_complete' }] } },
          _meta: { traceparent: 'not-a-traceparent' },
        },
      }) + '\n')
      child.stdin.end()
      let raceTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, rej) => { raceTimer = setTimeout(() => rej(new Error(`mcp-serve 超时\n${err}`)), 60_000) }),
        ])
      } finally {
        if (raceTimer) clearTimeout(raceTimer)
      }
      const spans = traceBodies.flatMap(b => b.scopeSpans[0].spans)
      const turns = spans.filter((s: any) => s.name === 'car.turn')
      assert.equal(turns.length, 2, '两次 session_turn 两个 turn span')
      const linked = turns.find((s: any) => s.traceId === remoteTraceId)
      assert.ok(linked, '合法 traceparent：turn span 加入宿主 trace（traceId 复用）')
      assert.equal(linked.parentSpanId, remoteSpanId, 'parentSpanId = 远端 spanId')
      const attrs = Object.fromEntries(linked.attributes.map((a: any) => [a.key, a.value.stringValue]))
      assert.equal(attrs['car.turn_id'], 'T1', 'turnId 回填不受挂链影响')
      assert.equal(attrs['car.outcome'], 'completed')
      const fallback = turns.find((s: any) => s.traceId !== remoteTraceId)
      assert.ok(fallback, '畸形 traceparent：fail-open 新 trace')
      assert.equal('parentSpanId' in fallback, false, 'fail-open 无 parent（新独立 trace）')
      assert.equal(/hi|ho|user_message/.test(JSON.stringify(traceBodies)), false, 'span 出站体零内容')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
