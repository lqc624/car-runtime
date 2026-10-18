/**
 * s51 · K-MP-2b 请求分段计量（1.14-S3 / D-41）
 *
 * 断言面（禁估算红线优先）：
 *  - openai-compat：completion_tokens_details.reasoning_tokens（provider 真实输出细分，K-MP-1
 *    思考参数计量配套）→ segments.reasoningTokens；一致性 = reasoning ≤ output（同源事实）；
 *  - 缺 details / reasoning_tokens 非数值 → segments 不带键（禁估算补造，色条退化单色）；
 *  - usage 事件落链：segments 随事件（有则带键、无则缺键——payload 形态逐键断言）；
 *    model_visible=0 不受影响；链完整；
 *  - runTurn 聚合：多请求 segments.reasoningTokens 求和；全 turn 无分段事实 → meta.usage
 *    不带 segments 键（缺省=未采集向后兼容）；
 *  - anthropic：无输出细分事实（thinking 计入 output_tokens）→ segments 缺省（登记口径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { RuntimeCore, createOpenAICompatAdapter, createAnthropicAdapter } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { runTurn } from '../src/loop/stop.ts'
import type { LlmAdapter, LlmChunk, LlmRequest } from '../src/runtime-core/types.ts'

function fakeAdapter(id: string, script: Array<LlmChunk[]>): LlmAdapter {
  let call = 0
  return {
    id,
    chat(_req: LlmRequest) {
      const chunks = script[Math.min(call++, script.length - 1)]!
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}

const coreWith = (id: string, script: Array<LlmChunk[]>) => {
  const core = new RuntimeCore()
  core.registry.register(fakeAdapter(id, script))
  return core
}

function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text)); c.close() } })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

// ==================== openai-compat 归一 ====================

test('s51-1 openai: completion_tokens_details.reasoning_tokens → segments.reasoningTokens（一致性 ≤ output）', async () => {
  const sse = dataLine({ choices: [{ delta: { content: 'hi' } }] }) +
    dataLine({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 12 } } }) +
    'data: [DONE]\n\n'
  const bodies: Array<Record<string, unknown>> = []
  const adapter = createOpenAICompatAdapter({
    baseUrl: 'https://llm.test/v1', provider: 't',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return sseResponse(sse) }) as typeof fetch,
  })
  const out: LlmChunk[] = []
  for await (const c of adapter.chat({ model: 'm1', messages: [{ role: 'user', content: 'x' }], tools: [] })) out.push(c)
  const usage = out.find(c => c.usage)?.usage
  assert.ok(usage, 'usage 事实在册')
  assert.equal(usage!.segments?.reasoningTokens, 12)
  assert.ok(usage!.segments!.reasoningTokens! <= usage!.outputTokens, '分段一致性：reasoning ≤ output（同源事实）')
  assert.equal(usage!.inputTokens, 60, '输入侧归一不变（prompt − cached）')
})

test('s51-2 openai: 缺 details / reasoning_tokens 非数值 → segments 不带键（禁估算）', async () => {
  for (const [name, usageObj] of [
    ['缺 completion_tokens_details', { prompt_tokens: 10, completion_tokens: 5 }],
    ['reasoning_tokens 非数值', { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 'many' } }],
  ] as const) {
    const sse = dataLine({ choices: [{ delta: { content: 'hi' } }] }) + dataLine({ choices: [], usage: usageObj }) + 'data: [DONE]\n\n'
    const adapter = createOpenAICompatAdapter({
      baseUrl: 'https://llm.test/v1', provider: 't',
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    })
    const out: LlmChunk[] = []
    for await (const c of adapter.chat({ model: 'm1', messages: [{ role: 'user', content: 'x' }], tools: [] })) out.push(c)
    const usage = out.find(c => c.usage)?.usage
    assert.ok(usage, name)
    assert.equal('segments' in usage!, false, `${name} → segments 不带键（色条退化单色，不造假）`)
  }
})

// ==================== 落链与聚合 ====================

test('s51-3 chatStep 落链：segments 随 usage 事件（有则带键）；model_visible=0；链完整', async () => {
  const log = new SessionLog('s51-chain')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-seg', [[
    { delta: 'ok' },
    { finishReason: 'stop' },
    { usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-seg', providerRaw: {}, segments: { reasoningTokens: 8 } } },
  ]])
  await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] })
  const usageEvents = log.events.filter(e => e.kind === 'usage')
  assert.equal(usageEvents.length, 1)
  assert.deepEqual((usageEvents[0]!.payload as { segments?: unknown }).segments, { reasoningTokens: 8 })
  assert.equal(log.verifyChain(), null)
  assert.deepEqual(log.deriveMessages().map(m => m.role), ['user', 'assistant'], 'usage/segments 不进模型消息流')
})

test('s51-4 chatStep 落链：usage 无分段事实 → 事件 payload 不带 segments 键（七键形态不变）', async () => {
  const log = new SessionLog('s51-noseg')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-plain', [[
    { delta: 'ok' },
    { finishReason: 'stop' },
    { usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-plain', providerRaw: {} } },
  ]])
  await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] })
  const u = log.events.find(e => e.kind === 'usage')!
  assert.deepEqual(u.payload, {
    model: 'm1', adapterId: 'fake-plain',
    input: 60, output: 20, cacheRead: 40, cacheCreation: 0,
    providerRaw: {},
  }, 'payload 七键——无 segments 键（1.11 形态逐字节不变）')
})

test('s51-5 runTurn 聚合：多请求 reasoning 求和；全无分段 → meta.usage 不带 segments 键', async () => {
  const log = new SessionLog('s51-agg')
  log.append('user', 'user', 'T1', '查一下')
  const core = coreWith('fake-seg', [
    [ // step1：toolUse + reasoning 30
      { toolCallDelta: { index: 0, id: 'tc1', name: 'lookup', argumentsDelta: '{"q":1}' } },
      { finishReason: 'toolUse' },
      { usage: { inputTokens: 60, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-seg', providerRaw: {}, segments: { reasoningTokens: 30 } } },
    ],
    [ // step2：stop + reasoning 12
      { delta: 'done' },
      { finishReason: 'stop' },
      { usage: { inputTokens: 10, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-seg', providerRaw: {}, segments: { reasoningTokens: 12 } } },
    ],
  ])
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map([['lookup', { declaredSideEffect: 'readonly' as const, run: async () => 'r' }]]),
  })
  assert.equal(result.reason, 'completed')
  const turnEnd = log.events.filter(e => e.kind === 'turnEnd').at(-1)!
  assert.deepEqual(turnEnd.meta!.usage, {
    input: 70, output: 65, cacheRead: 40, cacheCreation: 0, requests: 2,
    segments: { reasoningTokens: 42 },
  }, '聚合 = 四分量求和 + segments.reasoningTokens 求和（30+12）')

  // 全无分段：meta.usage 不带 segments 键
  const log2 = new SessionLog('s51-agg-noseg')
  log2.append('user', 'user', 'T1', '查一下')
  const core2 = coreWith('fake-plain', [
    [{ toolCallDelta: { index: 0, id: 'tc1', name: 'lookup', argumentsDelta: '{"q":1}' } }, { finishReason: 'toolUse' }, { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-plain', providerRaw: {} } }],
    [{ delta: 'b' }, { finishReason: 'stop' }, { usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-plain', providerRaw: {} } }],
  ])
  await runTurn({
    log: log2, turnId: 'T1',
    model: () => chatStep({ core: core2, log: log2, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map([['lookup', { declaredSideEffect: 'readonly' as const, run: async () => 'r' }]]),
  })
  const turnEnd2 = log2.events.filter(e => e.kind === 'turnEnd').at(-1)!
  assert.deepEqual(turnEnd2.meta!.usage, { input: 4, output: 6, cacheRead: 0, cacheCreation: 0, requests: 2 },
    '全 turn 无分段事实 → meta.usage 不带 segments 键（禁估算补造）')
})

// ==================== anthropic 登记口径 ====================

test('s51-6 anthropic: 无输出细分事实 → segments 缺省（thinking 计入 output_tokens）', async () => {
  const sse = [
    { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
    { type: 'message_stop' },
  ].map(dataLine).join('')
  const adapter = createAnthropicAdapter({
    baseUrl: 'https://llm.test', provider: 't',
    fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
  })
  const out: LlmChunk[] = []
  for await (const c of adapter.chat({ model: 'm1', messages: [{ role: 'user', content: 'x' }], tools: [] })) out.push(c)
  const usage = out.find(c => c.usage)?.usage
  assert.ok(usage)
  assert.equal(usage!.inputTokens, 10)
  assert.equal(usage!.outputTokens, 25)
  assert.equal('segments' in usage!, false, 'anthropic 无细分事实 → segments 不带键（登记口径，禁估算）')
})
