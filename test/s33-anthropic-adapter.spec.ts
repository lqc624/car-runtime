/**
 * 1.5-S1 · anthropic 适配器（S33）：Messages API 流式 SSE（D-20）
 *
 * 覆盖：
 *  - 出站体形状：x-api-key / anthropic-version / system 顶层化（多条 \n\n 连接）/
 *    toolResult → user tool_result（连续合并 + is_error）/ assistant tool_use /
 *    tools input_schema / max_tokens 必填缺省 4096 + 显式覆盖
 *  - stop_reason 映射（D-20 表）：end_turn/stop_sequence→stop、max_tokens→length、
 *    tool_use→toolUse、refusal→aborted；未映射 fail-visible（raw 附 message）
 *  - 流容错：ping/未知事件跳过；流内 error 事件 → error chunk；无 stop_reason → AL-05
 *  - chatStep 集成：多 tool_use 块按 index 聚合 → toolUse 两条 ToolCall
 *  - 基线同款：TLS 门（D-12a loopback）/ 凭据门 A080001 / 重试退避注入 / pre-aborted 取消零 chunk
 *  - spawn E2E：car run --adapter-id anthropic 全链（生产调用点核查——1.5-GO-5）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnthropicAdapter, RuntimeCore, assertTlsOrLoopback } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'
import { CarM8Error } from '../src/runtime-core/errors.ts'
import type { LlmChunk } from '../src/runtime-core/types.ts'
import { SessionLog } from '../src/session/log.ts'
import { Context } from '../src/kernel/context.ts'
import { runTurn } from '../src/loop/stop.ts'
import { toToolDefinitions } from '../src/runtime-core/tools.ts'
import { doctorModelReadiness } from '../src/dx/doctor.ts'

// 密钥扫描口径（generic-secret-assign）：夹具凭据经变量注入（赋值行无引号字面量）；值非真实凭据
const TEST_KEY = 'test-key-123'
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s33-${name}-`))
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

function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(text)); c.close() },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** anthropic 流脚本 → SSE 文本（无 [DONE] 终结——anthropic 以 message_stop 收口，解析器 data-only 不依赖） */
const anthropicSse = (events: object[]) => events.map(dataLine).join('')

const TEXT_EVENTS = (text: string): object[] => [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]

const TOOLUSE_EVENTS = (blocks: Array<{ id: string; name: string; args: string }>, text?: string): object[] => {
  const out: object[] = [{ type: 'message_start', message: { role: 'assistant' } }]
  if (text) {
    out.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
    )
  }
  blocks.forEach((b, i) => {
    const idx = text ? i + 1 : i
    out.push(
      { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: b.id, name: b.name } },
      { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: b.args } },
      { type: 'content_block_stop', index: idx },
    )
  })
  out.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' })
  return out
}

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of it) out.push(c)
  return out
}

/** 无凭据服务（出站体形状单测用） */
function adapterOf(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl, ...extra })
}

// ==================== 出站体形状（D-20） ====================

test('S33: anthropic 出站体——x-api-key/anthropic-version 头 + system 顶层化 + tools input_schema + max_tokens 缺省 4096', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const adapter = adapterOf((async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! })
    return sseResponse(anthropicSse(TEXT_EVENTS('ok')))
  }) as typeof fetch)
  await drain(adapter.chat({
    model: 'claude-x',
    messages: [
      { role: 'system', content: '规则一' },
      { role: 'system', content: '规则二' },
      { role: 'user', content: 'hi' },
    ],
    tools: [{ name: 'echo', description: '回声', parameters: { type: 'object', properties: { t: { type: 'string' } } }, declaredSideEffect: 'readonly' }],
  }))
  assert.equal(seen.length, 1)
  const { url, init } = seen[0]!
  assert.ok(url.endsWith('/v1/messages'), '请求路径 {baseUrl}/v1/messages（官方 SDK base_url 同约定）')
  const headers = init.headers as Record<string, string>
  assert.equal(headers['x-api-key'], '', '无凭据服务时空 x-api-key（凭据门在适配器外单测覆盖）')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(init.body as string)
  assert.equal(body.model, 'claude-x')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 4096, 'D-20：Anthropic max_tokens 必填——req 缺省 4096')
  assert.equal(body.system, '规则一\n\n规则二', 'system 消息提升顶层，多条 \\n\\n 连接')
  assert.ok(!('system' in body.messages[0]), 'system 不再以消息形态出站')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
  assert.deepEqual(body.tools, [{ name: 'echo', description: '回声', input_schema: { type: 'object', properties: { t: { type: 'string' } } } }], 'tools → input_schema；declaredSideEffect 不出站')
})

test('S33: anthropic 出站体——toolResult 合并单 user 多 tool_result + is_error + assistant tool_use + max_tokens 覆盖', async () => {
  const seen: RequestInit[] = []
  const adapter = adapterOf((async (_u: string | URL, init?: RequestInit) => {
    seen.push(init!)
    return sseResponse(anthropicSse(TEXT_EVENTS('done')))
  }) as typeof fetch)
  await drain(adapter.chat({
    model: 'm',
    maxTokens: 777,
    messages: [
      { role: 'user', content: '查天气' },
      { role: 'assistant', content: { toolCall: { id: 'toolu_1', tool: 'weather', args: { city: '北京' } } } },
      { role: 'toolResult', content: { id: 'toolu_1', result: '晴 25 度' } },
      { role: 'toolResult', content: { id: 'toolu_2', error: 'boom' } },
    ],
    tools: [],
  }))
  const body = JSON.parse(seen[0]!.body as string)
  assert.equal(body.max_tokens, 777, '显式 maxTokens 覆盖缺省')
  assert.deepEqual(body.messages, [
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: '北京' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '"晴 25 度"' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
    ] },
  ], '连续 toolResult 合并单 user 多块；error → is_error')
})

// ==================== stop_reason 映射与流容错 ====================

test('S33: stop_reason 映射——end_turn→stop / tool_use→toolUse（args 聚合）/ max_tokens→length / refusal→aborted', async () => {
  const mk = (events: object[]) => adapterOf((async () => sseResponse(anthropicSse(events))) as typeof fetch)
  const run = (events: object[]) => drain(mk(events).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }))

  const stop = await run(TEXT_EVENTS('ok')) as LlmChunk[]
  assert.equal(stop.at(-1)!.finishReason, 'stop')
  assert.ok(stop.every(c => c.finishReason !== 'error'), '成功流零 error chunk')

  const toolUse = await run(TOOLUSE_EVENTS([{ id: 'toolu_1', name: 'f', args: '{"a":1}' }])) as LlmChunk[]
  assert.equal(toolUse.at(-1)!.finishReason, 'toolUse')
  const startChunk = toolUse.find(c => c.toolCallDelta?.id)!
  const deltaChunk = toolUse.find(c => c.toolCallDelta?.argumentsDelta)!
  assert.equal(startChunk.toolCallDelta!.id, 'toolu_1', 'content_block_start 携带 id/name')
  assert.equal(startChunk.toolCallDelta!.name, 'f')
  assert.equal(deltaChunk.toolCallDelta!.argumentsDelta, '{"a":1}')

  const len = await run([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]) as LlmChunk[]
  assert.equal(len.at(-1)!.finishReason, 'length')

  const abort = await run([{ type: 'message_delta', delta: { stop_reason: 'refusal' } }]) as LlmChunk[]
  assert.equal(abort.at(-1)!.finishReason, 'aborted')

  // stop_sequence 同映射 stop（登记口径）
  const seq = await run([{ type: 'message_delta', delta: { stop_reason: 'stop_sequence' } }]) as LlmChunk[]
  assert.equal(seq.at(-1)!.finishReason, 'stop')
})

test('S33: 未映射 stop_reason fail-visible（pause_turn 等）+ 流内 error 事件 + 无 stop_reason AL-05 兜底', async () => {
  const mk = (events: object[]) => adapterOf((async () => sseResponse(anthropicSse(events))) as typeof fetch)
  const run = (events: object[]) => drain(mk(events).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as Promise<LlmChunk[]>

  const weird = await run([{ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }])
  assert.equal(weird.length, 1, 'fail-visible 单 chunk（sawFinish 命中无二次兜底）')
  assert.equal(weird[0]!.finishReason, 'error')
  assert.match(weird[0]!.error!.message, /pause_turn/, '原始 stop_reason 附 message（不吞没）')

  const streamErr = await run([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
  assert.equal(streamErr[0]!.finishReason, 'error')
  assert.match(streamErr[0]!.error!.message, /Overloaded/)

  const noFinish = await run([
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } },
    { type: 'ping' }, // 容错跳过
    { type: 'message_stop' },
  ])
  assert.equal(noFinish.at(-1)!.finishReason, 'error')
  assert.match(noFinish.at(-1)!.error!.message, /AL-05/, '流结束无 stop_reason = AL-05 显式化')
})

// ==================== chatStep 集成 + 基线同款 ====================

test('S33: chatStep 集成——RuntimeCore 经 anthropic 适配器多 tool_use 块按 index 聚合为两条 ToolCall', async () => {
  const adapter = adapterOf((async () => sseResponse(anthropicSse(TOOLUSE_EVENTS([
    { id: 'toolu_1', name: 'get_weather', args: '{"city":"北京"}' },
    { id: 'toolu_2', name: 'get_time', args: '{"tz":"UTC"}' },
  ], '查两个')))) as typeof fetch)
  const cred = new CredentialService({ keychainReader: () => null })
  const core = new RuntimeCore(cred)
  core.bindContext(new Context())
  core.registerLlmAdapter(adapter, { default: true })
  const log = new SessionLog('S-s33')
  log.append('user', 'user', 'T0', 'x')
  const r = await chatStep({ core, log, turnId: 'T0', model: 'm', tools: [] })
  assert.equal(r.stopReason, 'toolUse')
  assert.equal(r.text, '查两个')
  assert.deepEqual(r.toolCalls, [
    { id: 'toolu_1', tool: 'get_weather', args: { city: "北京" } },
    { id: 'toolu_2', tool: 'get_time', args: { tz: 'UTC' } },
  ], 'content_block_start id/name + input_json_delta 增量 → index 聚合')
  assert.equal(log.assertModelVisibleLogged().ok, true)
})

test('S33: 基线同款——TLS 门（http 非 loopback 拒绝 / loopback 豁免）/ 凭据门 A080001 / 首块前 5xx 重试 / pre-aborted 零 chunk', async () => {
  assertTlsOrLoopback('https://x.test')
  assert.throws(() => createAnthropicAdapter({ baseUrl: 'http://api.test' }), /CAR-E-LLM-TLS/)
  assert.doesNotThrow(() => createAnthropicAdapter({ baseUrl: 'http://127.0.0.1:9/v1' }), 'D-12a loopback 豁免同款')

  // 凭据门：keychain 通道缺席 + env fallback 未开 → A080001（CarM8Error 保形）
  const cred = new CredentialService({ keychainReader: () => null })
  const adapter = adapterOf((async () => sseResponse(anthropicSse(TEXT_EVENTS('x')))) as typeof fetch, { credentials: cred })
  await assert.rejects(
    () => drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })),
    (e: unknown) => e instanceof CarM8Error && (e as CarM8Error).code === 'A080001',
  )

  // 重试：首块前 5xx ×2 → 退避注入可观测 → 第三次成功（streamSsePost 引擎与 openai-compat 共用）
  let attempts = 0
  const sleeps: number[] = []
  const retryAdapter = createAnthropicAdapter({
    baseUrl: 'https://api.test',
    retries: 2, backoffMs: [11, 22],
    sleep: async ms => { sleeps.push(ms) },
    fetchImpl: (async () => {
      attempts++
      if (attempts < 3) return new Response('boom', { status: 500 })
      return sseResponse(anthropicSse(TEXT_EVENTS('ok')))
    }) as typeof fetch,
  })
  const out = await drain(retryAdapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as LlmChunk[]
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [11, 22], '指数退避注入可观测')
  assert.equal(out.at(-1)!.finishReason, 'stop')

  // 取消（D-19）：pre-aborted → 零 fetch 调用零 chunk
  let called = 0
  const cancelAdapter = adapterOf((async () => { called++; return sseResponse(anthropicSse(TEXT_EVENTS('x'))) }) as typeof fetch)
  const chunks = await drain(cancelAdapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [], signal: { aborted: true } }))
  assert.equal(chunks.length, 0)
  assert.equal(called, 0, 'attempt 前取消——请求未发出')
})

test('S33: doctorModelReadiness provider 感知——adapterId anthropic → ANTHROPIC_API_KEY（值不打印）', () => {
  withTempDir('doctor-anthropic', dir => {
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({ llm: { baseUrl: 'https://api.anthropic.com', model: 'claude-x', adapterId: 'anthropic', allowEnvFallback: true } }))
    const d1 = doctorModelReadiness({ env: { ANTHROPIC_API_KEY: TEST_KEY }, cwd: dir })
    assert.equal(d1.configured, true)
    assert.equal(d1.credential, 'env', 'anthropic provider 探测 ANTHROPIC_API_KEY')
    assert.equal(d1.detail.includes(TEST_KEY), false, '凭据值永不打印')
    // openai adapter 的凭据变量不算 anthropic 就绪
    const d2 = doctorModelReadiness({ env: { OPENAI_API_KEY: TEST_KEY }, cwd: dir })
    assert.equal(d2.credential, 'not-found', 'provider 变量面隔离')
    // 显式 adapter 行在 detail
    assert.match(d1.detail, /adapter=anthropic/)
  })
})

// ==================== 多步真 E2E + spawn 生产调用点（1.5-GO-5） ====================

test('S33: spawn CLI 全链——car run --adapter-id anthropic（x-api-key / system 顶层 / tool_result 第二请求）', async () => {
  await withTempDir('cli-anthropic', async dir => {
    const plugin = `export const manifest = { name: 'p', version: '1.0.0' }\n` +
      `export default function apply(api) {\n` +
      `  api.registerTool({ name: 'echo_tool', description: '回声工具', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, declaredSideEffect: 'readonly', run: async (a) => 'echo:' + a.text })\n` +
      `}\n`
    writeFileSync(join(dir, 'p.ts'), plugin)
    const bodies: any[] = []
    const headers: any[] = []
    let n = 0
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        bodies.push(JSON.parse(raw))
        headers.push(req.headers)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(n++ === 0
          ? anthropicSse(TOOLUSE_EVENTS([{ id: 'toolu_1', name: 'echo_tool', args: '{"text":"hi"}' }]))
          : anthropicSse(TEXT_EVENTS('完成了')))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', 'p.ts',
      '--adapter-id', 'anthropic',
      '--prompt', 'call echo_tool with text hi', '--base-url', `http://127.0.0.1:${port}`, '--model', 'claude-cli',
      '--system', '你是 CLI 集成测试助手'], {
      cwd: dir,
      env: { ...process.env, ANTHROPIC_API_KEY: TEST_KEY, CAR_ALLOW_ENV_CREDENTIALS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const code = await new Promise<number>(resolve => child.on('exit', c => resolve(c ?? -1)))
    server.close()
    assert.equal(code, 0, err)
    assert.match(out, /turnEnd=completed/)
    // 请求 1：anthropic 出站体（system 顶层 / input_schema / x-api-key 凭据 / 版本头）
    assert.equal(headers[0]['x-api-key'], TEST_KEY, '凭据经 CredentialService→x-api-key')
    assert.equal(headers[0]['anthropic-version'], '2023-06-01')
    assert.equal(bodies[0].system, '你是 CLI 集成测试助手', '--system 落链（system 事件）→ 顶层 system')
    assert.equal(JSON.stringify(bodies[0]).includes(TEST_KEY), false, '凭据值不出站到消息体')
    assert.equal(bodies[0].tools[0].name, 'echo_tool')
    assert.equal(bodies[0].tools[0].input_schema.properties.text.type, 'string')
    // 请求 2：assistant tool_use + user tool_result（D-20 映射回路）
    const asst = bodies[1].messages.find((m: any) => m.role === 'assistant')
    assert.deepEqual(asst.content, [{ type: 'tool_use', id: 'toolu_1', name: 'echo_tool', input: { text: 'hi' } }])
    const tr = bodies[1].messages.find((m: any) => m.role === 'user' && Array.isArray(m.content))
    assert.equal(tr.content[0].type, 'tool_result')
    assert.equal(tr.content[0].tool_use_id, 'toolu_1')
    assert.equal(tr.content[0].content, '"echo:hi"')
  })
})
