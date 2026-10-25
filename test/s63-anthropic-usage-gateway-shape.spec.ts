/**
 * s63 · anthropic usage 网关形态归一化（1.18.1-K6-A / 2026-10-25 装机会话实证）
 *
 * 商汤网关（anthropic Messages API 形态）把 input 侧三键放 message_delta.usage
 * （message_start.input_tokens 常为 0），官方形态 input 侧在 message_start、delta 仅
 * output_tokens。修复前归一化只读 message_start → 商汤通路三键系统性归零（2026-10-25
 * 复审计 19/19 usage 事件实证），D-51 thresholdTokens 事实源
 * （input+cacheRead+cacheCreation 之和）恒 0 → token 阈值在生效安装物上永不触发。
 *
 * 判别式 = delta 是否携带任一 input 侧键（input_tokens / cache_read_input_tokens /
 * cache_creation_input_tokens）；input 侧整体取单一来源（不混取两包、不估算）。
 * 官方形态行为不变（s45 全量回归）；output 侧守卫不变（delta.output_tokens 非数值
 * 整条不落）。
 *
 * fixture 数字全部取自装机真实会话 providerRaw（S-mvm9th2p / S-mvdevcsf）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicAdapter } from '../src/runtime-core/llm.ts'
import type { LlmChunk } from '../src/runtime-core/types.ts'

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

async function drain(it: AsyncIterable<unknown>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = []
  for await (const c of it) out.push(c as LlmChunk)
  return out
}

/** 网关流骨架：start（input 侧可指定）→ 一个文本块 → delta（usage 可指定）*/
const gwStream = (startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>) => sseResponse([
  dataLine({ type: 'message_start', message: { id: 'msg_gw', type: 'message', role: 'assistant', usage: startUsage } }),
  dataLine({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
  dataLine({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: deltaUsage }),
  dataLine({ type: 'message_stop' }),
])

const gwAdapter = (resp: Response) => createAnthropicAdapter({
  baseUrl: 'https://api.test',
  fetchImpl: (async () => resp) as typeof fetch,
})

const gwChat = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], tools: [] } as const

test('s63: 网关形态（装机会话实证样本）——input 侧三键取 message_delta，start=0 不再吞真值', async () => {
  // S-mvm9th2p T1 原样回放：start.input_tokens=0，真值全在 delta
  const adapter = gwAdapter(gwStream(
    { input_tokens: 0, output_tokens: 0 },
    { input_tokens: 186, cache_read_input_tokens: 256, cache_creation_input_tokens: 0, output_tokens: 1083 },
  ))
  const out = await drain(adapter.chat(gwChat))
  const usage = out.find(c => c.usage !== undefined)!.usage!
  assert.equal(usage.inputTokens, 186)
  assert.equal(usage.cacheReadTokens, 256)
  assert.equal(usage.cacheCreationTokens, 0)
  assert.equal(usage.outputTokens, 1083)
  // D-51 thresholdTokens 事实源：修复前 0+0+0=0（永不触发），修复后 442
  assert.equal(usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens, 442)
})

test('s63: 网关形态多轮增长轨迹（S-mvdevcsf 稳定期样本）——cacheRead=512 到达事实源', async () => {
  const adapter = gwAdapter(gwStream(
    { input_tokens: 0, output_tokens: 0 },
    { input_tokens: 203, cache_read_input_tokens: 512, cache_creation_input_tokens: 0, output_tokens: 92 },
  ))
  const out = await drain(adapter.chat(gwChat))
  const usage = out.find(c => c.usage !== undefined)!.usage!
  assert.equal(usage.inputTokens, 203)
  assert.equal(usage.cacheReadTokens, 512)
  assert.equal(usage.inputTokens + usage.cacheReadTokens, 715, '事实源之和随上下文真实增长')
})

test('s63: 网关形态下 start 侧畸形不阻塞——input 来源整体切 delta（单一来源原则）', async () => {
  const adapter = gwAdapter(gwStream(
    { input_tokens: 'x' },
    { input_tokens: 476, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 30 },
  ))
  const out = await drain(adapter.chat(gwChat))
  const usage = out.find(c => c.usage !== undefined)?.usage
  assert.ok(usage, 'delta 携带完整 input 侧 → start 侧畸形不吞整条')
  assert.equal(usage!.inputTokens, 476)
})

test('s63: 官方形态回归——delta 仅 output_tokens 时 input 侧仍取 message_start（不混取）', async () => {
  const adapter = gwAdapter(gwStream(
    { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 40 },
    { output_tokens: 50 },
  ))
  const out = await drain(adapter.chat(gwChat))
  const usage = out.find(c => c.usage !== undefined)!.usage!
  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.cacheReadTokens, 40)
  assert.equal(usage.cacheCreationTokens, 10)
  assert.equal(usage.outputTokens, 50)
})

test('s63: 网关形态下 output 侧守卫不变——delta.output_tokens 非数值整条不落', async () => {
  const adapter = gwAdapter(gwStream(
    { input_tokens: 0 },
    { input_tokens: 186, cache_read_input_tokens: 256, cache_creation_input_tokens: 0, output_tokens: 'x' },
  ))
  const out = await drain(adapter.chat(gwChat))
  assert.ok(out.every(c => c.usage === undefined), 'output 侧畸形 → usage 整条不落（缺失口径不变）')
})
