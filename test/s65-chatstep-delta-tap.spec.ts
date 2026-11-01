/**
 * s65 · 1.19.0 chatStep onDelta 流式增量回调（D-S2-1 渲染提示面）
 *
 * 判据：
 *  - textDelta 之和 + flush 尾巴 ≡ 落链 assistant 全文（收敛一致——屏幕无第二事实源）；
 *  - 增量经过 StreamRedactor（密钥原文不出现在任何回调片段——流式遮蔽语义）；
 *  - toolName 首次可知即回调一次（args 半截 JSON 不解析——ADR-001 同纪律）；
 *  - 回调先于 assistant 落链（宿主推送序 = delta → assistant 事件）；
 *  - 缺省（undefined）= 零行为变化（落链事件逐字段与无回调路径一致）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeCore, type LlmAdapter, type LlmChunk, type LlmRequest } from '../src/runtime-core/llm.ts'
import { SessionLog } from '../src/session/log.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'

function fakeAdapter(id: string, script: Array<LlmChunk[]>): LlmAdapter {
  let call = 0
  return {
    id,
    async *chat(_req: LlmRequest) {
      const chunks = script[Math.min(call, script.length - 1)]!
      call++
      yield* chunks
    },
  }
}

const coreWith = (id: string, script: Array<LlmChunk[]>) => {
  const core = new RuntimeCore()
  core.registry.register(fakeAdapter(id, script))
  return core
}

type Delta = { textDelta?: string; toolName?: string }

test('s65: textDelta 之和 + flush 尾巴 ≡ 落链 assistant 全文（尾部驻留窗收敛）', async () => {
  const log = new SessionLog('s65-converge')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-delta', [[
    { delta: '你好，今天天气不错，适合' },
    { delta: '写点代码，先把这行流式' },
    { delta: '渲染的测试补完再说。' },
    { finishReason: 'stop' },
  ]])
  const seen: Delta[] = []
  const step = await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], onDelta: (d) => seen.push(d) })
  const streamed = seen.map((d) => d.textDelta ?? '').join('')
  const logged = log.events.filter((e) => e.kind === 'assistant').at(-1)!.payload as string
  assert.equal(step.text, logged, 'ModelStep.text = 落链全文')
  assert.equal(streamed, logged, '回调增量之和（含 flush 尾巴）≡ 落链全文——屏幕无第二事实源')
  assert.ok(seen.length >= 2, '多 chunk 多次回调（非攒一次）')
  assert.ok(seen.every((d) => d.toolName === undefined), '纯文本流零 toolName 回调')
})

test('s65: 增量经 StreamRedactor——密钥原文零泄漏（遮蔽串出现，原文任何片段不出现在回调）', async () => {
  const log = new SessionLog('s65-redact')
  log.append('user', 'user', 'T1', 'hi')
  const credCanary = 'sk-live-abc123def456ghi789'
  const core = coreWith('fake-secret', [[
    { delta: '密钥是 ' },
    { delta: credCanary.slice(0, 10) },
    { delta: credCanary.slice(10) + ' 请妥善保管。' },
    { finishReason: 'stop' },
  ]])
  const seen: Delta[] = []
  await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], onDelta: (d) => seen.push(d) })
  const streamed = seen.map((d) => d.textDelta ?? '').join('')
  const logged = log.events.filter((e) => e.kind === 'assistant').at(-1)!.payload as string
  assert.ok(!streamed.includes(credCanary), '流式增量不含密钥原文（遮蔽生效）')
  assert.ok(!logged.includes(credCanary), '落链全文同样遮蔽（既有语义不变）')
  assert.equal(streamed, logged, '遮蔽后的流式增量与落链全文收敛一致')
})

test('s65: toolName 首次可知即回调一次——args 流式期不解析不回调', async () => {
  const log = new SessionLog('s65-toolname')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-tool', [[
    { toolCallDelta: { index: 0, id: 'tc1', name: 'fs_read', argumentsDelta: '{"path"' } },
    { toolCallDelta: { index: 0, argumentsDelta: ':"a.txt"}' } },
    { finishReason: 'toolUse' },
  ]])
  const seen: Delta[] = []
  const step = await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], onDelta: (d) => seen.push(d) })
  const names = seen.filter((d) => d.toolName !== undefined)
  assert.equal(names.length, 1, '同名只回调一次（args 增量不重复回调）')
  assert.equal(names[0]!.toolName, 'fs_read')
  assert.deepEqual(step.toolCalls, [{ id: 'tc1', tool: 'fs_read', args: { path: 'a.txt' } }], 'ModelStep 形态不受回调影响')
})

test('s65: 回调先于 assistant 落链（宿主推送序 = delta → assistant 事件）', async () => {
  const log = new SessionLog('s65-order')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-order', [[{ delta: 'ok' }, { finishReason: 'stop' }]])
  const order: string[] = []
  log.attachSink((line) => {
    const e = JSON.parse(line) as { kind: string }
    if (e.kind === 'assistant') order.push('assistant-event')
  })
  await chatStep({
    core, log, turnId: 'T1', model: 'm1', tools: [],
    onDelta: (d) => { if (d.textDelta) order.push('delta:' + d.textDelta) },
  })
  assert.deepEqual(order, ['delta:ok', 'assistant-event'], '增量回调先于落链事件（sink 序）')
})

test('s65: 缺省 onDelta = 零行为变化（事件链与 usage/assistant 逐字段一致）', async () => {
  const script: LlmChunk[] = [
    { delta: 'plain text ' },
    { delta: 'with sk-live-xyz987654321abc key' },
    { finishReason: 'stop' },
    { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake', providerRaw: {} } },
  ]
  const logA = new SessionLog('s65-nope')
  logA.append('user', 'user', 'T1', 'hi')
  const stepA = await chatStep({ core: coreWith('fake-plain', [script]), log: logA, turnId: 'T1', model: 'm1', tools: [] })
  const logB = new SessionLog('s65-cb')
  logB.append('user', 'user', 'T1', 'hi')
  const stepB = await chatStep({ core: coreWith('fake-plain', [script]), log: logB, turnId: 'T1', model: 'm1', tools: [], onDelta: () => {} })
  assert.deepEqual(stepA, stepB, 'ModelStep 逐字段一致')
  assert.deepEqual(
    logA.events.map((e) => [e.kind, e.payload, e.meta]),
    logB.events.map((e) => [e.kind, e.payload, e.meta]),
    '事件链逐字段一致（回调不产生任何链上差异）',
  )
})

test('s65: runTurn 集成——多步 turn 每步独立回调，落链不变', async () => {
  const { runTurn } = await import('../src/loop/stop.ts')
  const log = new SessionLog('s65-turn')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-turn', [
    [{ toolCallDelta: { index: 0, id: 'tc1', name: 'lookup', argumentsDelta: '{"q":1}' } }, { finishReason: 'toolUse' }],
    [{ delta: 'done' }, { finishReason: 'stop' }],
  ])
  const seen: Delta[] = []
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], onDelta: (d) => seen.push(d) }),
    tools: new Map([['lookup', { declaredSideEffect: 'readonly' as const, run: async () => 'r' }]]),
  })
  assert.equal(result.reason, 'completed')
  assert.deepEqual(seen.filter((d) => d.toolName !== undefined).map((d) => d.toolName), ['lookup'])
  const streamed = seen.map((d) => d.textDelta ?? '').join('')
  assert.ok(streamed.includes('done'), '第二步文本增量可达')
  assert.equal(log.verifyChain(), null, '哈希链完整')
})
