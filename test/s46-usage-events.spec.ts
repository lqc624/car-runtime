/**
 * s46 · usage 事件与聚合测试（1.11-S2 / D-33 / 计量设计 §3.3 + §7-A4）
 *
 * 断言面：
 *  - chatStep 请求级落链：actor='runtime'、payload 七键、哈希链不断、model_visible=0（投影不含 usage）；
 *  - runTurn turnEnd 聚合：本 turn usage 事件四分量求和 + requests 计数（聚合在消费侧单点 closeTurn）；
 *  - 无 usage → turnEnd meta 不带 usage 键（缺省=未采集，向后兼容）；跨 turn 不串（turnId 过滤）；
 *  - reason='max-tokens' turn：已完成的请求照常落 usage（撞限不吞用量）；
 *  - provider_raw 泄漏断言：不含消息内容/凭据/URL 查询串（三模式；正控 = model 名在位）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { RuntimeCore } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { runTurn, TurnAborted } from '../src/loop/stop.ts'
import type { LlmAdapter, LlmChunk, LlmRequest } from '../src/runtime-core/types.ts'

/** 脚本化 fake 适配器：每次 chat 依序吐一组 chunk（usage 形态 = openai 尾包：独立 chunk 置尾） */
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

const USER_CANARY = 'CONFIDENTIAL-USER-TEXT'
const CRED_CANARY = 'sk-canary-CREDENTIAL-XX'
const URL_CANARY = 'https://provider.example/v1?token=sk-canary-2'

test('s46: chatStep 请求级 usage 落链——actor/payload 七键/哈希链/model_visible=0', async () => {
  const log = new SessionLog('s46-chatstep')
  log.append('user', 'user', 'T1', USER_CANARY)
  const core = coreWith('fake-usage', [[
    { delta: 'ok' },
    { finishReason: 'stop' },
    { usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-usage', providerRaw: { prompt_tokens: 100, completion_tokens: 20 } } },
  ]])
  const step = await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] })
  assert.equal(step.stopReason, 'stop')

  const usageEvents = log.events.filter(e => e.kind === 'usage')
  assert.equal(usageEvents.length, 1)
  const u = usageEvents[0]!
  assert.equal(u.actor, 'runtime', 'usage 事件 actor=runtime（计量设计 §2.5）')
  assert.equal(u.turnId, 'T1')
  assert.deepEqual(u.payload, {
    model: 'm1', adapterId: 'fake-usage',
    input: 60, output: 20, cacheRead: 40, cacheCreation: 0,
    providerRaw: { prompt_tokens: 100, completion_tokens: 20 },
  }, 'payload 七键：model/adapterId/四分量/providerRaw（§3.3 形态）')
  assert.equal(log.verifyChain(), null, 'usage 事件过 log.append 进哈希链，链条完整')
  assert.deepEqual(log.deriveMessages().map(m => m.role), ['user', 'assistant'],
    'model_visible=0：deriveMessages 不投影 usage（不进模型消息流）')
})

test('s46: runTurn turnEnd 聚合——两请求四分量求和 + requests 计数', async () => {
  const log = new SessionLog('s46-agg')
  log.append('user', 'user', 'T1', '查一下')
  const core = coreWith('fake-usage', [
    [ // step1：toolUse（交回模型，非收口）
      { toolCallDelta: { index: 0, id: 'tc1', name: 'lookup', argumentsDelta: '{"q":1}' } },
      { finishReason: 'toolUse' },
      { usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-usage', providerRaw: { p: 1 } } },
    ],
    [ // step2：stop 收口
      { delta: 'done' },
      { finishReason: 'stop' },
      { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-usage', providerRaw: { p: 2 } } },
    ],
  ])
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map([['lookup', { declaredSideEffect: 'readonly' as const, run: async () => 'r' }]]),
  })
  assert.equal(result.reason, 'completed')
  const turnEnd = log.events.filter(e => e.kind === 'turnEnd').at(-1)!
  assert.deepEqual(turnEnd.meta, { reason: 'completed', usage: { input: 70, output: 25, cacheRead: 40, cacheCreation: 0, requests: 2 } },
    'turnEnd.meta.usage = 本 turn usage 事件四分量求和 + requests（§3.3）')
  assert.equal(log.verifyChain(), null)
})

test('s46: 无 usage → meta 不带 usage 键（向后兼容）；跨 turn 事实不串（turnId 过滤）', async () => {
  const log = new SessionLog('s46-compat')
  // T0 的 usage 事实先在链上（模拟早前 turn）——T1 收口不得把它聚合进来
  log.append('runtime', 'usage', 'T0', { model: 'm', adapterId: 'x', input: 999, output: 999, cacheRead: 0, cacheCreation: 0, providerRaw: {} })
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-plain', [[{ delta: 'ok' }, { finishReason: 'stop' }]])
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map(),
  })
  assert.equal(result.reason, 'completed')
  const turnEnd = log.events.filter(e => e.kind === 'turnEnd').at(-1)!
  assert.deepEqual(turnEnd.meta, { reason: 'completed' }, '无本 turn usage 事件 → meta 不带 usage 键；T0 事实不跨 turn 串入')
})

test('s46: max-tokens turn——截断请求的 usage 照常落链（撞限不吞用量）', async () => {
  const log = new SessionLog('s46-maxtok')
  log.append('user', 'user', 'T1', '写长文')
  const core = coreWith('fake-usage', [[
    { delta: 'long text' },
    { finishReason: 'length' },
    { usage: { inputTokens: 50, outputTokens: 4096, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-usage', providerRaw: {} } },
  ]])
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map(),
  })
  assert.equal(result.reason, 'max-tokens')
  const usageEvents = log.events.filter(e => e.kind === 'usage')
  assert.equal(usageEvents.length, 1, 'length 收口请求的 usage 事实照常落（Anthropic 撞限 message_delta 仍带 usage 同口径）')
  const turnEnd = log.events.filter(e => e.kind === 'turnEnd').at(-1)!
  assert.equal(turnEnd.meta!.reason, 'max-tokens')
  assert.deepEqual(turnEnd.meta!.usage, { input: 50, output: 4096, cacheRead: 0, cacheCreation: 0, requests: 1 })
})

test('s46: provider_raw 泄漏断言——不含消息内容/凭据/URL 查询串（正控：model 名在位）', async () => {
  const log = new SessionLog('s46-leak')
  log.append('user', 'user', 'T1', USER_CANARY)
  const core = coreWith('fake-usage', [[
    { delta: 'ok' },
    { finishReason: 'stop' },
    { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-usage', providerRaw: { prompt_tokens: 1, completion_tokens: 2 } } },
  ]])
  await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] })
  const line = JSON.stringify(log.events.find(e => e.kind === 'usage'))
  assert.ok(line!.includes('"m1"'), '正控：providerRaw/模型名确实在事件行内（断言非空转）')
  for (const [name, canary] of [['消息内容', USER_CANARY], ['凭据', CRED_CANARY], ['URL 查询串', URL_CANARY]] as const) {
    assert.ok(!line!.includes(canary), `泄漏断言：usage 事件不含${name}（${canary}）`)
  }
})

test('s46: 取消（TurnAborted）不落 usage——流不完整整条不落', async () => {
  const log = new SessionLog('s46-abort')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-usage', [[
    { delta: 'partial' },
    { finishReason: 'stop' },
    { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm1', adapterId: 'fake-usage', providerRaw: {} } },
  ]])
  await assert.rejects(
    () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], signal: { aborted: true } }),
    TurnAborted,
  )
  assert.equal(log.events.filter(e => e.kind === 'usage').length, 0, '取消路径无 usage 事实（chunk 间隙取消，流未消费完整）')
})
