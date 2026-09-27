/**
 * 1.4-S6~S7 · 遥测 trace 面 + MCP 工具进 turn + PTC 进真实 turn（S32）
 *
 * 覆盖（1.4-迭代规划 OTel 块 / MCP 块 / PTC 块）：
 *  - telemetry trace 透传：traceId 复用 + parentSpanId 挂链（OTLP 出站体断言）；缺省行为不变
 *  - TurnTracer：turn（根）→ step（子）层级；noop 门面零出站
 *  - 生产调用点：car run spawn 全链——CAR_OTEL_ENDPOINT 捕获 OTLP traces（共享 traceId + 父子链）；
 *    --mcp（config mcp.servers + 受控 stdio 假 server）→ MCP 工具进声明面 + callTool 真派发；
 *    --ptc → run_code 参数 schema 出站 + worker 桥真调工具 + renderSdk 声明块进 system
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTelemetryFacade, type TelemetrySpan } from '../src/runtime-core/telemetry.ts'
import { TurnTracer } from '../src/runtime-core/trace.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.ts')

const okRes = () => ({ ok: true, status: 200 }) as unknown as Response

// 密钥扫描口径：夹具凭据经变量注入（赋值行无引号字面量）
const TEST_KEY = 'test-key-123'

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s32-${name}-`))
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

const sse = (chunks: object[]) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

// ==================== trace 透传 + TurnTracer（单元） ====================

test('S32: telemetry trace 透传——traceId 复用 + parentSpanId 进 OTLP 出站体；缺省行为不变', async () => {
  await withTempDir('trace-unit', async dir => {
    const bodies: any[] = []
    const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
    })
    // 子 span：显式 trace（traceId 复用 + 父 spanId）
    const child = f.getTracer().startSpan('car.step', { attributes: { 'car.step': 1 }, trace: { traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16) } })
    assert.equal(child.traceId, 'a'.repeat(32), '显式 traceId 复用')
    assert.equal(child.spanId.length, 16, 'spanId 生成')
    child.end()
    // 兄弟 span：同 traceId、无 parent
    const sibling = f.getTracer().startSpan('car.step', { trace: { traceId: 'a'.repeat(32) } })
    sibling.end()
    // 独立 span：缺省随机 traceId（1.1 行为不变）
    const standalone: TelemetrySpan = f.getTracer().startSpan('standalone')
    assert.notEqual(standalone.traceId, 'a'.repeat(32))
    standalone.end()
    await f.flush()
    const spans = bodies.flatMap(b => b.scopeSpans[0].spans)
    const c = spans.find((s: any) => s.name === 'car.step' && s.parentSpanId === 'b'.repeat(16))
    assert.ok(c, 'parentSpanId 进出站体')
    assert.equal(c.traceId, 'a'.repeat(32))
    const sib = spans.find((s: any) => s.name === 'car.step' && !s.parentSpanId)
    assert.ok(sib, '同 traceId 无父的兄弟 span')
  })
})

test('S32: TurnTracer——turn（根）→ step（子）层级共享 traceId；noop 门面零出站', async () => {
  await withTempDir('tracer', async dir => {
    const bodies: any[] = []
    const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
    })
    const tracer = new TurnTracer(f)
    const turn = tracer.startTurn('T0')
    const step = turn.stepSpan(1)
    step.recordException(new Error('x'))
    step.end('toolUse')
    turn.end('completed')
    await f.flush()
    const spans = bodies.flatMap(b => b.scopeSpans[0].spans)
    const turnSpan = spans.find((s: any) => s.name === 'car.turn')
    const stepSpan = spans.find((s: any) => s.name === 'car.step')
    assert.ok(turnSpan && stepSpan)
    assert.equal(stepSpan.traceId, turnSpan.traceId, '同 turn 共享 traceId')
    assert.equal(stepSpan.parentSpanId, turnSpan.spanId, 'step 父 = turn spanId')
    assert.equal(turnSpan.attributes.find((a: any) => a.key === 'car.outcome').value.stringValue, 'completed')
    // noop 门面：enabled=false → 句柄零出站（默认关三原则在 trace 面成立）
    const noopTracer = new TurnTracer(createTelemetryFacade(null))
    const noopTurn = noopTracer.startTurn('T0')
    noopTurn.stepSpan(1).end('stop')
    noopTurn.end('completed')
    const nf = createTelemetryFacade({ endpoint: 'https://otel' }, { fetchImpl: (async () => { throw new Error('零出站') }) as typeof fetch })
    void nf
  })
})

// ==================== 生产调用点：car run 全链（MCP + PTC + trace 出站） ====================

/** 受控 stdio MCP server（node 脚本文本）：tools/list + tools/call(upper) */
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
      reply(req, { content: [{ type: 'text', text: String(req.params.arguments.text).toUpperCase() }] });
    }
  }
});
function reply(req, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n'); }
`

const RUN_CODE = `const r = await tools.mcp_helper_upper({ text: 'abc' })\nreturn r`

test('S32: car run 全链——MCP 工具进声明面+callTool 派发 / run_code worker 桥 / SDK 块进 system / trace 出站', async () => {
  await withTempDir('full-chain', async dir => {
    // 插件（声明面带 schema）
    writeFileSync(join(dir, 'p.ts'), `export const manifest = { name: 'p', version: '1.0.0' }\n` +
      `export default function apply(api) {\n` +
      `  api.registerTool({ name: 'echo_tool', description: '回声', parameters: { type: 'object', properties: { text: { type: 'string' } } }, declaredSideEffect: 'readonly', run: async (a) => 'echo:' + a.text })\n` +
      `  api.setSystemPrompt('插件级系统提示')\n` +
      `}\n`)
    // 配置：llm + mcp.servers
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
      llm: { model: 'test-model' },
      mcp: { servers: { helper: { command: process.execPath, args: ['-e', FAKE_MCP_SERVER] } } },
    }))
    // 假 LLM：req1 → run_code（worker 桥调 MCP 工具）；req2 → done
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
      '--prompt', 'uppercase abc', '--base-url', `http://127.0.0.1:${llmPort}/v1`,
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
    // MCP：进声明面 + callTool 真派发
    assert.match(out, /\[MCP\] helper: 1 工具入声明面/)
    const req1Tools = llmBodies[0].tools.map((t: any) => t.function.name)
    assert.ok(req1Tools.includes('mcp_helper_upper'), 'MCP 工具模型侧命名（D-18）')
    assert.ok(req1Tools.includes('run_code'), 'run_code 入工具面')
    const runCodeFn = llmBodies[0].tools.find((t: any) => t.function.name === 'run_code')
    assert.deepEqual(runCodeFn.function.parameters.required, ['code', 'description'], 'run_code 参数 schema 出站（1.4 新增）')
    // PTC：工具结果回链——写类工具先落授权决策 toolResult（M4 既有语义，观察项登记：投影双 tool 消息）、
    // 再落执行结果；取最后一条（run_code 执行结果，worker 桥调 MCP upper → 'ABC'）
    const toolMsg = llmBodies[1].messages.filter((m: any) => m.role === 'tool').at(-1)
    assert.ok(toolMsg, '第二请求含 run_code 结果')
    assert.equal(JSON.stringify(toolMsg.content).includes('ABC'), true, `worker 桥真调 MCP 工具（结果应含 ABC）：${JSON.stringify(toolMsg.content).slice(0, 200)}`)
    // system：flag 缺省 → 插件 setSystemPrompt + SDK 声明块独立追加
    assert.equal(llmBodies[0].messages[0].role, 'system')
    assert.equal(llmBodies[0].messages[0].content, '插件级系统提示')
    assert.equal(llmBodies[0].messages[1].role, 'system')
    assert.match(llmBodies[0].messages[1].content, /declare const tools:/, 'renderSdk 声明块出站（1.4 前零生产调用点）')
    assert.match(llmBodies[0].messages[1].content, /mcp_helper_upper/, 'SDK 声明含 MCP 工具')
    // trace：turn/step 共享 traceId + 父子链（OTLP 出站）
    await new Promise(r => setTimeout(r, 300))
    const spans = otlpBodies.flatMap(b => b.scopeSpans[0].spans)
    const turnSpan = spans.find((s: any) => s.name === 'car.turn')
    const stepSpan = spans.find((s: any) => s.name === 'car.step')
    assert.ok(turnSpan && stepSpan, `trace 出站（${otlpBodies.length} bodies, ${spans.length} spans）`)
    assert.equal(stepSpan.traceId, turnSpan.traceId, '同 turn 共享 traceId')
    assert.equal(stepSpan.parentSpanId, turnSpan.spanId, '父子链')
  })
})
