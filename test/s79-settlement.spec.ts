/**
 * s79 · 1.24-W2 回合结算回执（settlement）
 *
 * 判据（《内核1.24-W2结算回执-迭代规划.md》D-W2-1~6 /《Qwen-Code 对照分析》§2.3/§5）：
 *  - 形态：kind:'system' + payload.type:'settlement'（EventKind 零新增），一 turn 一张，
 *    落链序 settlement → turnEnd（turnEnd 保持终止标记语义）；
 *  - 产出点仅 closeTurn + recoverInterrupted；authz 台账 turnEnd 不触发；
 *  - 字段：outcome 由 reason 映射 / failureKind=1.23 meta.kind 诚实缺键 / requestSent 由
 *    usage 事件或 assistant 在场自证 / 两本账按链 id 对账（cap 64 + truncated）/
 *    tool 节五键齐（permissionDenialCount / hasUnknownOutcomes〔无配对或 recovered:true〕/
 *    unknownToolUseIds 条件键 / stopRequested〔terminate hints〕/ bounded〔aborted-before-dispatch〕）；
 *  - 字节兼容：turnEnd meta 与 1.23 形态逐字段一致（settlement 独立事件非 meta 键，D-W2-4）；
 *  - kill-switch：CAR_SETTLEMENT=off 跳过 append（D-W2-5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTurn, TurnAborted, type ToolDef } from '../src/loop/stop.ts'
import { appendSettlement, outcomeFromReason, SETTLEMENT_LEDGER_CAP } from '../src/loop/settlement.ts'
import { recoverInterrupted } from '../src/loop/recover.ts'
import { SessionLog, type SessionEvent } from '../src/session/log.ts'
import { providerUnreachable } from '../src/runtime-core/errors.ts'

const settlementOf = (log: SessionLog, turnId: string): SessionEvent | undefined =>
  log.events.find((e) => e.kind === 'system' && e.turnId === turnId && (e.payload as { type?: string })?.type === 'settlement')
const turnEndMeta = (log: SessionLog, turnId: string): Record<string, unknown> | undefined =>
  log.events.find((e) => e.kind === 'turnEnd' && e.turnId === turnId)?.meta
const turnEndSeq = (log: SessionLog, turnId: string): number =>
  log.events.find((e) => e.kind === 'turnEnd' && e.turnId === turnId)!.seq

// ==================== 形态与字段 ====================

test('S79-1 正常 completed turn：settlement 全字段 + 落链序 settlement→turnEnd + turnEnd meta 字节兼容', async () => {
  const log = new SessionLog('s79-normal')
  log.append('user', 'user', 'T1', 'hi')
  const result = await runTurn({ log, turnId: 'T1', model: async () => ({ stopReason: 'stop', text: 'ok' }), tools: new Map<string, ToolDef>() })
  assert.equal(result.reason, 'completed')
  const s = settlementOf(log, 'T1')!
  assert.ok(s, 'settlement 事件存在')
  assert.equal(s.actor, 'runtime')
  assert.ok(s.seq < turnEndSeq(log, 'T1'), 'settlement 先于 turnEnd（终止标记语义保持）')
  assert.deepEqual(s.payload, {
    type: 'settlement',
    outcome: 'complete',
    requestSent: false,
    declaredToolUseIds: [],
    dispatchedToolUseIds: [],
    tool: { permissionDenialCount: 0, hasUnknownOutcomes: false, stopRequested: false, bounded: false },
  }, '无 usage/assistant → requestSent=false；条件键（failureKind/assistantSeq/unknownToolUseIds/ledgerTruncated）诚实缺席')
  assert.deepEqual(turnEndMeta(log, 'T1'), { reason: 'completed' }, 'turnEnd meta 与 1.23 逐字段一致（settlement 非 meta 键，D-W2-4）')
})

test('S79-2 assistant+usage 在场 → requestSent=true + assistantSeq=末条 assistant seq', async () => {
  const log = new SessionLog('s79-sent')
  log.append('user', 'user', 'T1', 'hi')
  let assistantSeq = -1
  await runTurn({
    log, turnId: 'T1',
    model: async () => {
      log.append('model', 'assistant', 'T1', 'partial answer')
      assistantSeq = log.events.length - 1
      log.append('runtime', 'usage', 'T1', { input: 10, output: 5 })
      return { stopReason: 'stop' }
    },
    tools: new Map<string, ToolDef>(),
  })
  const p = settlementOf(log, 'T1')!.payload as Record<string, unknown>
  assert.equal(p.requestSent, true)
  assert.equal(p.assistantSeq, assistantSeq)
  assert.equal(p.outcome, 'complete')
  assert.equal('failureKind' in p, false, '无失败细类 → 诚实缺键')
})

test('S79-3 授权拒绝计数：denied 成对结果 granted=false → permissionDenialCount=1（两本账仍齐）', async () => {
  const log = new SessionLog('s79-deny')
  log.append('user', 'user', 'T1', 'hi')
  let step = 0
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => {
      step++
      return step === 1
        ? { stopReason: 'toolUse', toolCalls: [{ id: 'c1', tool: 'fs_write', args: {} }] }
        : { stopReason: 'stop' }
    },
    tools: new Map<string, ToolDef>([['fs_write', { declaredSideEffect: 'write', run: async () => ({}) }]]),
    preset: { mode: 'confirm', blockOnDeny: false, authorize: async () => false },
  })
  assert.equal(result.reason, 'completed')
  const p = settlementOf(log, 'T1')!.payload as { declaredToolUseIds: string[]; dispatchedToolUseIds: string[]; tool: Record<string, unknown> }
  assert.deepEqual(p.declaredToolUseIds, ['c1'])
  assert.deepEqual(p.dispatchedToolUseIds, ['c1'], '拒绝也成对落链——两本账齐（日志无缺口红线）')
  assert.equal(p.tool.permissionDenialCount, 1)
  assert.equal(p.tool.hasUnknownOutcomes, false)
})

test('S79-4 CarM8Error kind → settlement failureKind + outcome=failed', async () => {
  const log = new SessionLog('s79-kind')
  log.append('user', 'user', 'T1', 'hi')
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => { throw providerUnreachable('wire HTTP 400：bad', 'transport-4xx') },
    tools: new Map<string, ToolDef>(),
  })
  assert.equal(result.reason, 'error')
  const p = settlementOf(log, 'T1')!.payload as Record<string, unknown>
  assert.equal(p.outcome, 'failed')
  assert.equal(p.failureKind, 'transport-4xx', '1.23 meta.kind 同源传播（D-W2-3）')
})

test('S79-5 in-flight abort → outcome=interrupted', async () => {
  const log = new SessionLog('s79-abort')
  log.append('user', 'user', 'T1', 'hi')
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => { throw new TurnAborted('in-flight') },
    tools: new Map<string, ToolDef>(),
  })
  assert.equal(result.reason, 'aborted')
  const p = settlementOf(log, 'T1')!.payload as Record<string, unknown>
  assert.equal(p.outcome, 'interrupted')
})

// ==================== 对账与护栏形态 ====================

test('S79-6 recovery 部分链对账：无配对 toolCall → recovered:true 合成结果按「结果不明」记账（主战场）', () => {
  const log = new SessionLog('s79-recover')
  log.append('user', 'user', 'T1', 'hi')
  log.append('model', 'toolCall', 'T1', { id: 'x1', tool: 'fs_write', args: { path: 'a.txt' } })
  log.append('model', 'assistant', 'T1', 'writing...')
  const report = recoverInterrupted(log)
  assert.equal(report.turnsClosed, 1)
  const p = settlementOf(log, 'T1')!.payload as { outcome: string; requestSent: boolean; declaredToolUseIds: string[]; dispatchedToolUseIds: string[]; tool: Record<string, unknown> }
  assert.equal(p.outcome, 'interrupted')
  assert.equal(p.requestSent, true, 'assistant 在场自证请求已发')
  assert.deepEqual(p.declaredToolUseIds, ['x1'])
  assert.deepEqual(p.dispatchedToolUseIds, ['x1'], 'recover 成对补记后账面配对')
  assert.equal(p.tool.hasUnknownOutcomes, true, 'recovered:true = 副作用状态未知显式记账（不因成对补记丢信号）')
  assert.deepEqual(p.tool.unknownToolUseIds, ['x1'])
})

test('S79-7 bounded：取消落在派发边界（aborted-before-dispatch 成对）→ bounded=true、账面配对', async () => {
  const log = new SessionLog('s79-bounded')
  log.append('user', 'user', 'T1', 'hi')
  const signal = { aborted: false }
  let step = 0
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => {
      step++
      return step === 1
        ? { stopReason: 'toolUse', toolCalls: [{ id: 'a', tool: 'touch', args: {} }, { id: 'b', tool: 'touch', args: {} }] }
        : { stopReason: 'stop' }
    },
    tools: new Map<string, ToolDef>([['touch', { declaredSideEffect: 'readonly', run: async () => { signal.aborted = true; return {} } }]]),
    signal,
  })
  assert.equal(result.reason, 'aborted')
  const p = settlementOf(log, 'T1')!.payload as { declaredToolUseIds: string[]; dispatchedToolUseIds: string[]; tool: Record<string, unknown> }
  assert.deepEqual(p.declaredToolUseIds, ['a', 'b'])
  assert.deepEqual(p.dispatchedToolUseIds, ['a', 'b'], '未派发调用补记成对事件——账面齐')
  assert.equal(p.tool.bounded, true, '取消落在派发边界 = bounded（链上 aborted-before-dispatch 自证）')
  assert.equal(p.tool.stopRequested, false)
  assert.equal(p.tool.hasUnknownOutcomes, false)
})

test('S79-8 terminate 收口 → stopRequested=true（hints 不落 turnEnd meta）', async () => {
  const log = new SessionLog('s79-term')
  log.append('user', 'user', 'T1', 'hi')
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => ({ stopReason: 'toolUse', toolCalls: [{ id: '1', tool: 'finish', args: {} }] }),
    tools: new Map<string, ToolDef>([['finish', { declaredSideEffect: 'readonly', terminate: true, run: async () => ({ ok: true }) }]]),
  })
  assert.equal(result.reason, 'aborted')
  const p = settlementOf(log, 'T1')!.payload as { tool: Record<string, unknown> }
  assert.equal(p.tool.stopRequested, true)
  assert.equal(p.tool.bounded, false)
  const meta = turnEndMeta(log, 'T1')!
  assert.deepEqual(meta, { reason: 'aborted' }, 'hints 不落 turnEnd meta——1.23 terminate 形态逐字节不变（D-W2-4）')
})

// ==================== 开关与边界 ====================

test('S79-9 kill-switch：CAR_SETTLEMENT=off → 无 settlement 事件（turnEnd 照常）', async () => {
  const log = new SessionLog('s79-off')
  log.append('user', 'user', 'T1', 'hi')
  process.env.CAR_SETTLEMENT = 'off'
  try {
    await runTurn({ log, turnId: 'T1', model: async () => ({ stopReason: 'stop' }), tools: new Map<string, ToolDef>() })
  } finally {
    delete process.env.CAR_SETTLEMENT
  }
  assert.equal(settlementOf(log, 'T1'), undefined)
  assert.ok(turnEndMeta(log, 'T1'), 'turnEnd 照常落链')
})

test('S79-10 authz 台账 turnEnd 不触发 settlement：恰一张、turnId 归属 run turn', async () => {
  const log = new SessionLog('s79-authz')
  log.append('runtime', 'turnEnd', 'authz:rule:fs-write:1', null, { reason: 'aborted' }) // 授权台账复用 turnEnd kind 先例
  log.append('user', 'user', 'T1', 'hi')
  await runTurn({ log, turnId: 'T1', model: async () => ({ stopReason: 'stop' }), tools: new Map<string, ToolDef>() })
  const settlements = log.events.filter((e) => e.kind === 'system' && (e.payload as { type?: string })?.type === 'settlement')
  assert.equal(settlements.length, 1, 'authz 台账不经 closeTurn——不触发结算')
  assert.equal(settlements[0].turnId, 'T1')
})

// ==================== 纯函数与护栏 ====================

test('S79-11 outcomeFromReason 映射表：六值 TurnEndReason → 三值 outcome', () => {
  assert.equal(outcomeFromReason('completed'), 'complete')
  assert.equal(outcomeFromReason('max-tokens'), 'complete')
  assert.equal(outcomeFromReason('aborted'), 'interrupted')
  assert.equal(outcomeFromReason('interrupted'), 'interrupted')
  assert.equal(outcomeFromReason('error'), 'failed')
  assert.equal(outcomeFromReason('blocked'), 'failed')
})

test('S79-12 账本 cap：超 64 条截断 + ledgerTruncated 标记（R-W2 链量纪律）', () => {
  const log = new SessionLog('s79-cap')
  const turnId = 'T1'
  for (let i = 0; i < SETTLEMENT_LEDGER_CAP + 5; i++) {
    log.append('model', 'toolCall', turnId, { id: `id-${i}`, tool: 't', args: {} })
    log.append('runtime', 'toolResult', turnId, { id: `id-${i}`, result: {} })
  }
  appendSettlement(log, turnId, { reason: 'completed' })
  const p = settlementOf(log, turnId)!.payload as { declaredToolUseIds: string[]; ledgerTruncated?: boolean; tool: Record<string, unknown> }
  assert.equal(p.declaredToolUseIds.length, SETTLEMENT_LEDGER_CAP)
  assert.equal(p.ledgerTruncated, true)
  assert.equal(p.tool.hasUnknownOutcomes, false, '前 64 条全配对——截断不影响已见账面判定')
})

test('S79-13 settlement 不投影（model_visible=0）：deriveMessages 无 settlement 消息、末条仍是 assistant', async () => {
  const log = new SessionLog('s79-proj')
  log.append('user', 'user', 'T1', 'hi')
  await runTurn({
    log, turnId: 'T1',
    model: async () => {
      log.append('model', 'assistant', 'T1', 'done') // assistant 落链事实由模型面生产（chatStep 同构）
      return { stopReason: 'stop' }
    },
    tools: new Map<string, ToolDef>(),
  })
  assert.ok(settlementOf(log, 'T1'), '前置：settlement 已落链')
  const msgs = log.deriveMessages()
  assert.equal(msgs.some((m) => m.role === 'system' && (m.content as { type?: string })?.type === 'settlement'), false, '结算凭据不进模型消息流（审计面事实非上下文）')
  assert.equal(msgs.at(-1)!.role, 'assistant')
  assert.equal(msgs.at(-1)!.content, 'done', '链尾投影不被 settlement 挤占（s31 守门同款判据）')
  assert.equal(log.assertModelVisibleLogged().ok, true, 'N1 快照自洽不受影响')
})
