/**
 * s54 · 1.14.1 B2 前置补出面（K-MP-1 chatStep 消费面 + K-MP-2/K-POOL-1 seam 行为 API）
 *
 * 断言面：
 *  - chatStep reasoning 透传：reasoning 形参 → core.chat（LlmRequest.reasoning）→ 适配器家族映射
 *    （openai reasoning_effort / off = 字节面不下发）——chatStep 是宿主 model 回调唯一路径，
 *    1.14.0 起 reasoning 仅经直连 adapter 可达，本批补齐经 chatStep 可达；
 *  - compact 经 seam：shouldCompact 阈值判定（enabled 缺省关）+ applyCompaction 立即压缩
 *    （append-only：compact 事件追加、原链不改写、投影折叠）；
 *  - pool 经 seam：assembleModelPool 装配（fallback 链 + onDecide 决策）+ probePoolMember 可用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import {
  RuntimeCore,
  createOpenAICompatAdapter,
  chatStep,
  shouldCompact,
  applyCompaction,
  assembleModelPool,
  probePoolMember,
} from '../src/seam.ts'
import type { LlmAdapter, LlmChunk, LlmRequest } from '../src/runtime-core/types.ts'

function fakeAdapter(id: string, chunks: LlmChunk[], seen: LlmRequest[] = []): LlmAdapter {
  return {
    id,
    chat(req: LlmRequest) {
      seen.push(req)
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}

async function collect(s: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = []
  for await (const c of s) out.push(c)
  return out
}

// ==================== chatStep reasoning 消费面 ====================

test('s54-1 chatStep reasoning 透传：形参 → req.reasoning → 适配器；缺席 = req 不带键', async () => {
  for (const [name, reasoning, expectKey] of [
    ['effort=high 透传', { effort: 'high' as const }, true],
    ['effort=off 透传（适配器侧零字节）', { effort: 'off' as const }, true],
    ['缺席 = req 不带键', undefined, false],
  ] as const) {
    const seen: LlmRequest[] = []
    const core = new RuntimeCore()
    core.registry.register(fakeAdapter('fake', [{ delta: 'ok' }, { finishReason: 'stop' }], seen))
    const log = new SessionLog('s54-reasoning')
    log.append('user', 'user', 'T1', 'hi')
    await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], ...(reasoning ? { reasoning } : {}) })
    if (expectKey) assert.deepEqual(seen[0]!.reasoning, reasoning, name)
    else assert.equal('reasoning' in seen[0]!, false, name)
  }
})

test('s54-2 chatStep + 真 openai 适配器：reasoning.effort → 请求体 reasoning_effort（off = 零痕迹）', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
  const sseResponse = () => new Response(
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  const adapter = createOpenAICompatAdapter({
    baseUrl: 'https://llm.test/v1', provider: 't',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return sseResponse() }) as typeof fetch,
  })
  for (const [effort, expectField] of [['medium', true], ['off', false]] as const) {
    const core = new RuntimeCore()
    core.registry.register(adapter, { default: true })
    const log = new SessionLog(`s54-openai-${effort}`)
    log.append('user', 'user', 'T1', 'hi')
    await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], reasoning: { effort } })
    const body = bodies[bodies.length - 1]!
    assert.equal('reasoning_effort' in body, expectField, `effort=${effort} → reasoning_effort ${expectField ? '在' : '零痕迹'}`)
    if (expectField) assert.equal(body.reasoning_effort, effort)
  }
})

// ==================== compact 经 seam ====================

test('s54-3 compact 经 seam：shouldCompact 阈值判定（缺省关）+ applyCompaction append-only 落链', async () => {
  const log = new SessionLog('s54-compact')
  log.append('runtime', 'system', 'system', '你是一个助手')
  for (let t = 1; t <= 6; t++) {
    log.append('user', 'user', `T${t}`, `问题 ${t}`)
    log.append('model', 'assistant', `T${t}`, `回答 ${t}`)
  }
  // 缺省关 = 行为零变化
  assert.equal(shouldCompact(log, undefined), false)
  assert.equal(shouldCompact(log, { enabled: false }), false)
  // 开启 + 阈值未到 = false；到 = true
  assert.equal(shouldCompact(log, { enabled: true, thresholdEvents: 100 }), false)
  assert.equal(shouldCompact(log, { enabled: true, thresholdEvents: 12 }), true)
  const before = log.events.length
  const ev = applyCompaction(log, { protectLastTurns: 2 })
  assert.equal(ev.kind, 'compact')
  assert.equal(log.events.length, before + 1, 'append-only：仅追加一条 compact 事件')
  assert.equal(log.verifyChain(), null, '压缩后链完整（原事件不改写）')
  // 投影折叠：折叠区间 user 事件不再以 user 消息出现（内容进摘要）；保护段最近 turn 保留
  const projected = log.deriveMessages()
  assert.ok(!projected.some(m => m.role === 'user' && JSON.stringify(m.content).includes('问题 1')),
    '折叠区间 user 事件已折叠（仅摘要携带，不再以 user 消息出现）')
  assert.ok(projected.some(m => m.role === 'user' && JSON.stringify(m.content).includes('问题 6')), '保护段最近 turn 保留')
})

// ==================== pool 经 seam ====================

test('s54-4 pool 经 seam：assembleModelPool 装配 + fallback 落 onDecide + probePoolMember 可用', async () => {
  const sseLive = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
  const sseResponse = (text: string) => new Response(
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  const decisions: Array<{ selected: string | null; reason: string; retries: number }> = []
  const { adapter } = assembleModelPool({
    pool: { endpoints: [
      { id: 'epA', baseUrl: 'https://dead-s54.test/v1', model: 'mA' },
      { id: 'epB', baseUrl: 'https://live-s54.test/v1', model: 'mB' },
    ], probe: { enabled: false } },
    fetchImpl: (async (u: string | URL) => String(u).includes('dead-s54.test')
      ? new Response('{"error":{}}', { status: 500 })
      : sseResponse(sseLive)) as unknown as typeof fetch,
    retries: 0,
    sleep: async () => {},
    onDecide: d => decisions.push({ selected: d.selected, reason: d.reason, retries: d.retries }),
  })
  const chunks = await collect(adapter.chat({ model: 'mA', messages: [{ role: 'user', content: 'x' }], tools: [] }))
  assert.equal(chunks.find(c => c.delta)?.delta, 'ok', 'fallback 链生效')
  assert.deepEqual(decisions, [{ selected: 'epB', reason: 'fallback', retries: 1 }], 'routing/decide 决策经 onDecide（宿主接线落链）')
  // probePoolMember 经 seam 可用（离线安全：回环拒绝 = 不健康不失败）
  const h = await probePoolMember({ baseUrl: 'http://127.0.0.1:1', adapterId: 'openai-compat' }, { timeoutMs: 800 })
  assert.equal(h.ok, false)
  assert.equal(h.errorCategory, 'network-error')
})
