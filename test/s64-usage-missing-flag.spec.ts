/**
 * s64 · turnEnd usageMissing 加法尾键（1.18.2-K8 / R-K7-2）
 *
 * 背景：商汤网关实测 20% 概率 message_delta 不带 usage（K7 装机 10 轮中 2 轮——流正常
 * 回复但计量整条缺席）。缺失口径纪律不落半条事实（turnUsageFrom undefined → meta 不带
 * usage 键），缺失本身自 1.18.2 起 fail-visible：本 turn 存在 assistant 事件（模型有
 * 可见输出 ⇒ 必有请求）而无 usage 聚合时，turnEnd meta 带 `usageMissing: true`（加法
 * 尾键，与 usage 同语义位）。
 *
 * 正向形态（有回复无计量 → usageMissing: true）在 s46 更新用例中覆盖；本 spec 补互斥
 * 回归（usage 在 → 不带 usageMissing 键——正常流计量面零漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { RuntimeCore } from '../src/runtime-core/llm.ts'
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

test('s64: usage 在 → meta.usage 聚合 + usageMissing 无键（互斥——正常流不冒缺失标注）', async () => {
  const log = new SessionLog('s64-mutex')
  log.append('user', 'user', 'T1', 'hi')
  const core = new RuntimeCore()
  core.registry.register(fakeAdapter('s64-adapter', [[
    { delta: 'ok' },
    { finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 0, model: 'm1', adapterId: 's64-adapter', providerRaw: {} } },
  ]]))
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map(),
  })
  assert.equal(result.reason, 'completed')
  const turnEnd = log.events.filter(e => e.kind === 'turnEnd').at(-1)!
  assert.equal(turnEnd.meta.usage?.input, 100, 'usage 聚合在')
  assert.equal('usageMissing' in turnEnd.meta, false, 'usage 在 → usageMissing 键不在（互斥，正常流零漂移）')
})
