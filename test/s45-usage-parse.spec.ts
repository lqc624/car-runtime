/**
 * s45 · usage 采集层测试（1.11-S1 / D-33 / 计量设计 §3.1-§3.2 + §7-A1/A2/A3）
 *
 * fixture SSE 全集：
 *  - openai-compat：usage 尾包解析（空 choices 不再被吞）+ cached 减法归一 + stream_options
 *    请求体断言 + 缺失/畸形容错（整条不落）+ usage 与内容同 chunk 共存形态；
 *  - anthropic：message_start（input 侧）+ message_delta（output 侧）两包合并 + cache_creation
 *    透传 + message_delta 缺席整条不落（R-2 中断形态）+ 任一侧缺失/畸形不落。
 * 断言全部对齐 src/runtime-core/llm.ts 真实实现；归一口径以计量设计 §1.1 为准。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatAdapter, createAnthropicAdapter } from '../src/runtime-core/llm.ts'
import type { LlmChunk } from '../src/runtime-core/types.ts'

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of it) out.push(c)
  return out
}

const last = <T>(arr: T[]): T => arr[arr.length - 1] as T

// ==================== openai-compat ====================

const OPENAI_FULL: Array<unknown> = [
  { choices: [{ delta: { content: 'he' } }] },
  { choices: [{ delta: { content: 'y' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  // 官方 include_usage 尾包：choices 为空数组——`if (!choice) continue` 原样会吞掉
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } },
]

test('s45: openai usage 尾包解析 + cached 减法归一（§1.1：inputTokens = prompt − cached）', async () => {
  const adapter = createOpenAICompatAdapter({
    baseUrl: 'https://api.test/v1',
    fetchImpl: (async () => sseResponse([...OPENAI_FULL.map(dataLine), 'data: [DONE]\n\n'])) as typeof fetch,
  })
  const out = await drain(adapter.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], tools: [] })) as LlmChunk[]
  const usageChunk = last(out)
  assert.equal(usageChunk.finishReason, undefined, 'usage 尾包独立成 chunk（finishReason chunk 之前已给出）')
  assert.deepEqual(usageChunk.usage, {
    inputTokens: 60, // 100 − 40（prompt_tokens 含 cached，必须减法）
    outputTokens: 20,
    cacheReadTokens: 40,
    cacheCreationTokens: 0, // openai 系恒 0（§1.1 登记不估算）
    model: 'gpt-x',
    adapterId: 'openai-compat',
    providerRaw: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
  })
  assert.equal(out.length, 4, 'delta + delta + finish + usage 尾包')
})

test('s45: openai stream_options.include_usage 请求体断言（计量设计 §9-2 推荐A：默认开启）', async () => {
  const seen: RequestInit[] = []
  const adapter = createOpenAICompatAdapter({
    baseUrl: 'https://api.test/v1',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { seen.push(init!); return sseResponse([...OPENAI_FULL.map(dataLine), 'data: [DONE]\n\n']) }) as typeof fetch,
  })
  await drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }))
  const body = JSON.parse(seen[0]!.body as string) as { stream_options?: { include_usage?: boolean } }
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('s45: openai usage 缺失（不支持网关形态）→ 无 usage chunk，流照常收口', async () => {
  const adapter = createOpenAICompatAdapter({
    baseUrl: 'https://api.test/v1',
    fetchImpl: (async () => sseResponse([
      dataLine({ choices: [{ delta: { content: 'ok' } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])) as typeof fetch,
  })
  const out = await drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })) as LlmChunk[]
  assert.ok(out.every(c => c.usage === undefined), '缺失口径：不落任何 usage（禁估算补造）')
  assert.equal(last(out).finishReason, 'stop')
})

test('s45: openai usage 畸形（主字段缺失/非数值/null）→ 整条不落，零抛错', async () => {
  for (const bad of [
    {}, // 全缺
    { prompt_tokens: 'x', completion_tokens: 5 }, // 非数值
    { prompt_tokens: 10 }, // output 侧缺失
    null,
  ]) {
    const adapter = createOpenAICompatAdapter({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () => sseResponse([
        dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        dataLine({ choices: [], usage: bad }),
        'data: [DONE]\n\n',
      ])) as typeof fetch,
    })
    const out = await drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })) as LlmChunk[]
    assert.ok(out.every(c => c.usage === undefined), `畸形 usage 不落（${JSON.stringify(bad)}）`)
  }
})

test('s45: openai usage 与 finish_reason 同事件共存形态（部分网关）→ 附着于该 chunk', async () => {
  const adapter = createOpenAICompatAdapter({
    baseUrl: 'https://api.test/v1',
    fetchImpl: (async () => sseResponse([
      dataLine({ choices: [{ delta: { content: 'ok' } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 7 } }),
      'data: [DONE]\n\n',
    ])) as typeof fetch,
  })
  const out = await drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })) as LlmChunk[]
  assert.equal(out.length, 2, '共存形态不额外加 chunk')
  assert.equal(last(out).finishReason, 'stop')
  assert.equal(last(out).usage?.inputTokens, 30, 'usage 附着于本事件最后一个 chunk（无 details 字段 → cached=0 不减）')
  assert.equal(last(out).usage?.cacheReadTokens, 0)
})

// ==================== anthropic ====================

const ANTHROPIC_START = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 40 } } }
const ANTHROPIC_DELTA = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }
const anthropicLines = (...evts: Array<Record<string, unknown>>) => [...evts.map(dataLine), `event: ping\ndata: {"type":"ping"}\n\n`, dataLine({ type: 'message_stop' })]

test('s45: anthropic start+delta 两包合并 + cache_creation 透传，附着于终态 chunk（D-33）', async () => {
  const adapter = createAnthropicAdapter({
    baseUrl: 'https://api.test',
    fetchImpl: (async () => sseResponse(anthropicLines(
      ANTHROPIC_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      ANTHROPIC_DELTA,
    ))) as typeof fetch,
  })
  const out = await drain(adapter.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], tools: [] })) as LlmChunk[]
  const finishChunk = out.find(c => c.finishReason !== undefined)
  assert.ok(finishChunk, 'finishReason chunk 存在')
  assert.equal(finishChunk!.finishReason, 'stop')
  assert.deepEqual(finishChunk!.usage, {
    inputTokens: 100, // anthropic 天然不含 cache，透传不减
    outputTokens: 50, // 来自 message_delta（output 侧）
    cacheReadTokens: 40,
    cacheCreationTokens: 10, // cache_creation_input_tokens 透传
    model: 'claude-x',
    adapterId: 'anthropic',
    providerRaw: { messageStart: ANTHROPIC_START.message.usage, messageDelta: ANTHROPIC_DELTA.usage },
  }, 'usage 与 finishReason 并存于最后一个 chunk（不互斥）')
})

test('s45: anthropic message_delta 缺席（流中断 R-2）→ AL-05 error chunk，整条不落', async () => {
  const adapter = createAnthropicAdapter({
    baseUrl: 'https://api.test',
    fetchImpl: (async () => sseResponse([
      dataLine(ANTHROPIC_START),
      dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } }),
    ])) as typeof fetch,
  })
  const out = await drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })) as LlmChunk[]
  assert.equal(last(out).finishReason, 'error', '流结束未携带 finishReason → AL-05 显式 error（不产半条事实）')
  assert.ok(out.every(c => c.usage === undefined), 'output 侧缺失 → usage 整条不落')
})

test('s45: anthropic 任一侧缺失/畸形 → 整条不落（delta 无 usage / start 缺席 / input_tokens 非数值）', async () => {
  const cases: Array<Array<Record<string, unknown>>> = [
    // delta 到但无 usage（output 侧缺失）
    [ANTHROPIC_START, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    // message_start 缺席（input 侧缺失）
    [ANTHROPIC_DELTA],
    // input_tokens 非数值（input 侧畸形）
    [{ type: 'message_start', message: { usage: { input_tokens: 'x' } } }, ANTHROPIC_DELTA],
  ]
  for (const [i, evts] of cases.entries()) {
    const adapter = createAnthropicAdapter({
      baseUrl: 'https://api.test',
      fetchImpl: (async () => sseResponse(anthropicLines(...evts))) as typeof fetch,
    })
    const out = await drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })) as LlmChunk[]
    assert.ok(out.every(c => c.usage === undefined), `用例 ${i}：usage 整条不落`)
    assert.equal(last(out).finishReason, 'stop', `用例 ${i}：终态信号不受 usage 采集影响`)
  }
})
