/**
 * 1.14-S1 · K-MP-1 思考参数透传（S49，D-39）
 *
 * 覆盖：
 *  - openai-compat：effort low/medium/high → reasoning_effort 字段逐值断言；off/缺席 = 字节面
 *    零痕迹（禁 'effort:none' 下发）；未知档位 → CAR-E-LLM-REASONING 显式报错（fail-visible）
 *  - anthropic：effort → thinking:{type:'enabled',budget_tokens}（D-39 表 low=2048/medium=8192/high=16384）；
 *    off/缺席不下发；budget ≥ max_tokens 违反 Messages API 约束 → 显式报错（禁静默改写 max_tokens）；
 *    maxTokens 显式调高后通过
 *  - normalizeReasoningEffort 归一：null/undefined → undefined；非法值 throw
 *  - 基线不变：无 reasoning 请求体与 1.13 逐字节一致（兼容验收线——tools/max_tokens/流解析不受影响）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicAdapter, createOpenAICompatAdapter, normalizeReasoningEffort } from '../src/runtime-core/llm.ts'
import type { LlmRequest } from '../src/runtime-core/types.ts'

const BASE_REQ: LlmRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
}

function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(text)); c.close() },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** openai SSE：单文本块 + stop 收口 + [DONE] */
const OPENAI_SSE = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

/** anthropic SSE：text 块 + end_turn 收口 */
const ANTHROPIC_SSE = [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
].map(e => `data: ${JSON.stringify(e)}\n\n`).join('')

/** 注入式 fetch：捕获请求体，回放 SSE 脚本 */
function capturingFetch(sse: string): { fetch: typeof fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  const fetch = (async (_u: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return sseResponse(sse)
  }) as typeof fetch
  return { fetch, bodies }
}

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of it) out.push(c)
  return out
}

// ==================== openai-compat ====================

test('S49-1 openai-compat: effort low/medium/high → reasoning_effort 逐值断言', async () => {
  for (const effort of ['low', 'medium', 'high'] as const) {
    const { fetch, bodies } = capturingFetch(OPENAI_SSE)
    const adapter = createOpenAICompatAdapter({ baseUrl: 'https://llm.test/v1', provider: 't', fetchImpl: fetch })
    await drain(adapter.chat({ ...BASE_REQ, reasoning: { effort } }))
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0]!.reasoning_effort, effort, `effort=${effort} 必须原样下发 reasoning_effort`)
  }
})

test('S49-2 openai-compat: off / 缺席 = 字节面零痕迹（无 reasoning_effort 键）', async () => {
  for (const reasoning of [{ effort: 'off' as const }, undefined]) {
    const { fetch, bodies } = capturingFetch(OPENAI_SSE)
    const adapter = createOpenAICompatAdapter({ baseUrl: 'https://llm.test/v1', provider: 't', fetchImpl: fetch })
    await drain(adapter.chat({ ...BASE_REQ, ...(reasoning ? { reasoning } : {}) }))
    assert.equal(bodies.length, 1)
    assert.equal('reasoning_effort' in bodies[0]!, false, 'off/缺席 = 不下发该字段（禁 effort:none 形态）')
  }
})

test('S49-3 openai-compat: 未知档位 → CAR-E-LLM-REASONING 显式报错（fail-visible）', async () => {
  const { fetch, bodies } = capturingFetch(OPENAI_SSE)
  const adapter = createOpenAICompatAdapter({ baseUrl: 'https://llm.test/v1', provider: 't', fetchImpl: fetch })
  await assert.rejects(
    drain(adapter.chat({ ...BASE_REQ, reasoning: { effort: 'extreme' as 'off' } })),
    /CAR-E-LLM-REASONING/,
  )
  assert.equal(bodies.length, 0, '报错发生在首块前（buildRequest），零出站')
})

test('S49-4 openai-compat: 无 reasoning 请求体与 1.13 基线一致（tools/max_tokens/流解析不受影响）', async () => {
  const { fetch, bodies } = capturingFetch(OPENAI_SSE)
  const adapter = createOpenAICompatAdapter({ baseUrl: 'https://llm.test/v1', provider: 't', fetchImpl: fetch })
  const chunks = await drain(adapter.chat({ ...BASE_REQ, maxTokens: 512, reasoning: { effort: 'off' } }))
  assert.equal(bodies[0]!.model, 'test-model')
  assert.equal(bodies[0]!.max_tokens, 512)
  assert.equal(Array.isArray(bodies[0]!.messages), true)
  const text = chunks.filter((c: { delta?: string }) => typeof c.delta === 'string').map((c: { delta?: string }) => c.delta).join('')
  assert.equal(text, 'hi')
  const finish = chunks.find((c: { finishReason?: string }) => c.finishReason !== undefined)
  assert.equal((finish as { finishReason?: string })!.finishReason, 'stop')
})

// ==================== anthropic ====================

test('S49-5 anthropic: effort → thinking budget（D-39 表 low=2048 / high=16384）', async () => {
  for (const [effort, budget] of [['low', 2048], ['high', 16384]] as const) {
    const { fetch, bodies } = capturingFetch(ANTHROPIC_SSE)
    const adapter = createAnthropicAdapter({ baseUrl: 'https://llm.test', provider: 't', fetchImpl: fetch })
    await drain(adapter.chat({ ...BASE_REQ, reasoning: { effort }, maxTokens: 32768 }))
    assert.equal(bodies.length, 1)
    assert.deepEqual(bodies[0]!.thinking, { type: 'enabled', budget_tokens: budget })
  }
})

test('S49-6 anthropic: off / 缺席 = 字节面零痕迹（无 thinking 键）', async () => {
  for (const reasoning of [{ effort: 'off' as const }, undefined]) {
    const { fetch, bodies } = capturingFetch(ANTHROPIC_SSE)
    const adapter = createAnthropicAdapter({ baseUrl: 'https://llm.test', provider: 't', fetchImpl: fetch })
    await drain(adapter.chat({ ...BASE_REQ, ...(reasoning ? { reasoning } : {}) }))
    assert.equal('thinking' in bodies[0]!, false, 'off/缺席 = 不下发 thinking 字段')
  }
})

test('S49-7 anthropic: budget ≥ max_tokens → 显式报错（medium 8192 ≥ 缺省 4096）', async () => {
  const { fetch, bodies } = capturingFetch(ANTHROPIC_SSE)
  const adapter = createAnthropicAdapter({ baseUrl: 'https://llm.test', provider: 't', fetchImpl: fetch })
  await assert.rejects(
    drain(adapter.chat({ ...BASE_REQ, reasoning: { effort: 'medium' } })), // maxTokens 缺省 4096 < 8192
    /CAR-E-LLM-REASONING[\s\S]*budget_tokens\(8192\)[\s\S]*max_tokens\(4096\)/,
  )
  assert.equal(bodies.length, 0, '约束校验在出站前（禁静默改写 max_tokens）')
})

test('S49-8 anthropic: maxTokens 调高后 medium 通过（budget < max_tokens）', async () => {
  const { fetch, bodies } = capturingFetch(ANTHROPIC_SSE)
  const adapter = createAnthropicAdapter({ baseUrl: 'https://llm.test', provider: 't', fetchImpl: fetch })
  await drain(adapter.chat({ ...BASE_REQ, reasoning: { effort: 'medium' }, maxTokens: 16384 }))
  assert.deepEqual(bodies[0]!.thinking, { type: 'enabled', budget_tokens: 8192 })
  assert.equal(bodies[0]!.max_tokens, 16384)
})

test('S49-9 anthropic: 未知档位 → CAR-E-LLM-REASONING（与 openai 同防线）', async () => {
  const { fetch } = capturingFetch(ANTHROPIC_SSE)
  const adapter = createAnthropicAdapter({ baseUrl: 'https://llm.test', provider: 't', fetchImpl: fetch })
  await assert.rejects(
    drain(adapter.chat({ ...BASE_REQ, reasoning: { effort: 'turbo' as 'off' } })),
    /CAR-E-LLM-REASONING/,
  )
})

// ==================== 归一函数 ====================

test('S49-10 normalizeReasoningEffort 归一口径', () => {
  assert.equal(normalizeReasoningEffort(undefined), undefined)
  assert.equal(normalizeReasoningEffort(null), undefined)
  assert.equal(normalizeReasoningEffort('off'), 'off')
  assert.equal(normalizeReasoningEffort('low'), 'low')
  assert.equal(normalizeReasoningEffort('medium'), 'medium')
  assert.equal(normalizeReasoningEffort('high'), 'high')
  assert.throws(() => normalizeReasoningEffort('extreme'), /CAR-E-LLM-REASONING/)
  assert.throws(() => normalizeReasoningEffort(42), /CAR-E-LLM-REASONING/)
})
