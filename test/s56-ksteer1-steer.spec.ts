/**
 * s56 · K-STEER-1 引导消息语义（1.15-S2 / D-47 / D-V02-9）
 *
 * 断言面（投影隔离红线优先）：
 *  - 逐字节对拍：turn 进行中（工具执行间隙）append 引导 user 事件 → 当前 turn 后续步请求体
 *    与无引导场景逐字节一致（引导 ≠ 注入当前 turn 上下文）；turn 内增量（toolResult）照进；
 *  - 排队扫描 pendingSteerTurns：未闭合 user 事件按 seq 序枚举；消费后消隐；excludeTurnId
 *    排除执行中 turn；recover 补记 interrupted 后不再 pending（R-8 定性锁定）；
 *  - 消费续跑链序（宿主 FIFO 模拟）：turn 收口 → 扫描 → 逐条以引导事件自身 turnId 调
 *    runTurn → 链上 turnEnd 全齐、发出时刻 ts ≤ 消费时刻、消费 turn 的请求不含后续排队；
 *  - recover 边界（R-8）：执行中 append + 消费前崩溃模拟 → 当前 turn 与引导 turn 均补记
 *    turnEnd=interrupted（recovered=true）+ pending 清零（消息已发未跑，不重复消费、不静默吞）；
 *  - N1 快照自洽：activeTurnId 快照口径与请求投影同构（引导 append 后 assert 仍 PASS）；
 *  - 兼容线：无引导事件时 activeTurnId 过滤零命中（投影与缺省口径逐字节一致）+ runTurn
 *    请求体 1.14.1 形态不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { RuntimeCore } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { runTurn, type ToolDef } from '../src/loop/stop.ts'
import { recoverInterrupted } from '../src/loop/recover.ts'
import { pendingSteerTurns } from '../src/session/steer.ts'
import type { LlmAdapter, LlmChunk, LlmRequest } from '../src/runtime-core/types.ts'

/** 请求捕获型 fakeAdapter（逐字节对拍源——直接存 LlmRequest，不经 SSE 二次编码） */
function captureAdapter(id: string, script: Array<LlmChunk[]>, reqs: LlmRequest[]): LlmAdapter {
  let call = 0
  return {
    id,
    chat(req: LlmRequest) {
      reqs.push(structuredClone(req))
      const chunks = script[Math.min(call++, script.length - 1)]!
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}

const coreWith = (id: string, script: Array<LlmChunk[]>, reqs: LlmRequest[]) => {
  const core = new RuntimeCore()
  core.registry.register(captureAdapter(id, script, reqs))
  return core
}

const toolUseStep: LlmChunk[] = [
  { toolCallDelta: { index: 0, id: 'x1', name: 'probe', argumentsDelta: '{}' } },
  { finishReason: 'toolUse' },
]
const stopStep = (text: string): LlmChunk[] => [{ delta: text }, { finishReason: 'stop' }]

/** 工具间隙 append 引导事件的探针工具（steerHooks 按调用次序触发一次） */
function steerProbe(log: SessionLog, steerTurnId: string, steerText: string, fired: { n: number }): ToolDef {
  return {
    declaredSideEffect: 'readonly',
    name: 'probe',
    description: 'probe tool that appends a steer user event between steps',
    run: async () => {
      if (fired.n++ === 0) log.append('user', 'user', steerTurnId, steerText)
      return 'ok'
    },
  }
}

// ==================== 投影隔离（红线） ====================

test('s56-1 红线：引导事件 append 后当前 turn 后续步请求体逐字节不变（turn 内 toolResult 照进）', async () => {
  // 场景 A（引导）：T1 执行中，工具间隙 append T2 引导 → step2 请求体不含引导
  const logA = new SessionLog('s56-a')
  logA.append('user', 'user', 'T1', '第一问')
  const reqsA: LlmRequest[] = []
  const coreA = coreWith('fake-steer', [toolUseStep, stopStep('A-done')], reqsA)
  const firedA = { n: 0 }
  const toolA = steerProbe(logA, 'T2', '引导消息（间隙 append）', firedA)
  const rA = await runTurn({
    log: logA, turnId: 'T1',
    model: () => chatStep({ core: coreA, log: logA, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map([['probe', toolA]]),
  })
  assert.equal(rA.reason, 'completed')
  assert.equal(firedA.n, 1, '间隙钩子已触发（引导事件已落链）')
  assert.equal(logA.events.some(e => e.kind === 'user' && e.turnId === 'T2'), true, '引导事件在链上（发出时刻落链）')

  // 场景 B（对照）：同脚本，无引导 append
  const logB = new SessionLog('s56-b')
  logB.append('user', 'user', 'T1', '第一问')
  const reqsB: LlmRequest[] = []
  const coreB = coreWith('fake-plain', [toolUseStep, stopStep('A-done')], reqsB)
  await runTurn({
    log: logB, turnId: 'T1',
    model: () => chatStep({ core: coreB, log: logB, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map([['probe', { declaredSideEffect: 'readonly' as const, name: 'probe', run: async () => 'ok' }]]),
  })

  // 逐字节对拍：A 的两步请求体与 B 完全一致（引导不进当前 turn 任何一步）
  assert.equal(reqsA.length, 2)
  assert.equal(JSON.stringify(reqsA[0]!.messages), JSON.stringify(reqsB[0]!.messages), 'step1 请求体逐字节一致')
  assert.equal(JSON.stringify(reqsA[1]!.messages), JSON.stringify(reqsB[1]!.messages), 'step2 请求体逐字节一致（引导被投影隔离）')
  // turn 内增量照进：step2 含 toolResult（agent loop 依赖实时投影——非快照口径的证据）
  const rolesB = reqsB[1]!.messages.map(m => m.role)
  assert.deepEqual(rolesB, ['user', 'assistant', 'toolResult'], 'turn 内 toolResult 照进后续请求（排除快照式误杀）')
  assert.equal(JSON.stringify(reqsA[1]!.messages).includes('引导消息'), false, '引导文本零泄漏（belt-and-suspenders）')
  // N1 自洽：引导 append 落在快照边界之后，activeTurnId 快照口径逐快照成立
  assert.equal(logA.assertModelVisibleLogged().ok, true, '全链快照断言 PASS（activeTurnId 口径）')
  assert.equal(logA.verifyChain(), null)
})

// ==================== 排队扫描 ====================

test('s56-2 排队扫描：未闭合引导按 seq 序枚举 + 消费后消隐 + excludeTurnId 排除执行中 turn', () => {
  const log = new SessionLog('s56-scan')
  log.append('user', 'user', 'T1', '已闭合问')       // seq1
  log.append('model', 'assistant', 'T1', '答')
  log.append('runtime', 'turnEnd', 'T1', null, { reason: 'completed' })
  // 模拟执行中：T4 在跑（未闭合），T2/T3 已排队
  log.append('user', 'user', 'T4', '执行中问')        // 执行中 turn
  log.append('user', 'user', 'T2', '排队 2')          // seq5
  log.append('user', 'user', 'T3', '排队 3')          // seq6

  // exclude T4（执行中）→ pending = [T2, T3] 按链序
  const p1 = pendingSteerTurns(log, { excludeTurnId: 'T4' })
  assert.deepEqual(p1.map(p => p.turnId), ['T2', 'T3'], 'FIFO 按 seq 序')
  assert.deepEqual(p1.map(p => p.text), ['排队 2', '排队 3'])
  assert.ok(p1[0]!.seq < p1[1]!.seq)
  assert.equal(typeof p1[0]!.ts, 'number', '发出时刻 ts 在册（链序校验口径）')

  // 不排除 T4 → T4 也报（宿主职责边界：内核不猜哪个是执行中）
  assert.deepEqual(pendingSteerTurns(log).map(p => p.turnId), ['T4', 'T2', 'T3'], '缺省全量未闭合')

  // 消费 T2（turnEnd 落）→ pending 消隐
  log.append('runtime', 'turnEnd', 'T2', null, { reason: 'completed' })
  assert.deepEqual(pendingSteerTurns(log, { excludeTurnId: 'T4' }).map(p => p.turnId), ['T3'], '已消费消隐')
  assert.equal(log.verifyChain(), null)
})

// ==================== 消费续跑链序（宿主 FIFO 模拟） ====================

test('s56-3 消费续跑：收口→扫描→逐条 runTurn（引导 turnId）→链上 turnEnd 全齐 + 消费请求不含后续排队', async () => {
  const log = new SessionLog('s56-fifo')
  log.append('user', 'user', 'T1', '第一问')
  const reqs: LlmRequest[] = []
  const core = coreWith('fake-fifo', [toolUseStep, stopStep('t1-done'), toolUseStep, stopStep('t2-done'), stopStep('t3-done')], reqs)
  const fired = { n: 0 }
  const tool = steerProbe(log, 'T2', '引导 A', fired)
  // T2 消费期间再 append T3（待执行队列追加——「执行中再发」与「排队中追加」同一语义）
  const fired2 = { n: 0 }
  const tool2: ToolDef = {
    declaredSideEffect: 'readonly', name: 'probe', run: async () => {
      if (fired2.n++ === 0) log.append('user', 'user', 'T3', '引导 B（T2 消费期间追加）')
      return 'ok'
    },
  }
  const runTurnWith = (turnId: string, t: ToolDef) => runTurn({
    log, turnId,
    model: () => chatStep({ core, log, turnId, model: 'm1', tools: [] }),
    tools: new Map([['probe', t]]),
  })

  await runTurnWith('T1', tool) // T1：间隙 append 引导 A（T2）
  // —— 宿主 FIFO 续跑（消费语义在宿主装配层，D-47 ②）——
  let pending = pendingSteerTurns(log, { excludeTurnId: 'T1' }) // T1 收口后排除自身
  assert.equal(log.events.filter(e => e.kind === 'turnEnd' && e.turnId === 'T1').length, 1, 'T1 已收口')
  assert.deepEqual(pending.map(p => p.turnId), ['T2'])
  const steerSeq = pending[0]!.seq
  const steerTs = pending[0]!.ts
  await runTurnWith('T2', tool2) // T2 消费：间隙 append 引导 B（T3）
  pending = pendingSteerTurns(log)
  assert.deepEqual(pending.map(p => p.turnId), ['T3'], 'T2 收口后 T3 入队（待执行队列追加语义）')
  await runTurnWith('T3', { declaredSideEffect: 'readonly' as const, name: 'probe', run: async () => 'ok' })
  assert.deepEqual(pendingSteerTurns(log), [], '队列消费完毕')

  // 链序：引导事件 ts ≤ 其消费 turnEnd ts（发出时刻在先）+ 三 turn turnEnd 全齐
  const endOf = (tid: string) => log.events.find(e => e.kind === 'turnEnd' && e.turnId === tid)
  assert.ok(endOf('T1') && endOf('T2') && endOf('T3'), 'turnEnd 全齐')
  assert.ok(steerTs <= endOf('T2')!.ts, '发出时刻 ≤ 消费时刻')
  const steerEvent = log.events.find(e => e.kind === 'user' && e.turnId === 'T2')!
  assert.equal(steerEvent.seq, steerSeq, '引导事件 seq 与扫描报告一致（发出时刻链上位置）')
  assert.equal(log.verifyChain(), null, '全程链完整（只追加）')
  // 消费请求隔离：T2 消费请求不含 T3 内容（T3 在 T2 进行中 append——同红线）
  const t2Req = reqs.find(r => r.metadata?.turnId === 'T2')
  assert.ok(t2Req, 'T2 请求在册')
  assert.equal(JSON.stringify(t2Req!.messages).includes('引导 B'), false, 'T2 消费请求不含 T3 排队内容')
  assert.equal(JSON.stringify(t2Req!.messages).includes('引导 A'), true, 'T2 消费请求含自身引导正文（消费 turn 正常投影）')
  assert.equal(log.assertModelVisibleLogged().ok, true, 'N1 全链自洽（activeTurnId 快照口径）')
})

// ==================== recover 边界（R-8 锁定） ====================

test('s56-4 recover 锁定：消费前崩溃 → 当前 turn 与引导 turn 均补记 interrupted + pending 清零（消息已发未跑，不重复消费）', () => {
  const log = new SessionLog('s56-recover')
  log.append('user', 'user', 'T1', '执行中问')
  // 模拟崩溃前状态：T1 进行中（无 turnEnd），T2/T3 已排队未消费
  log.append('user', 'user', 'T2', '排队 A')
  log.append('user', 'user', 'T3', '排队 B')
  assert.deepEqual(pendingSteerTurns(log).map(p => p.turnId), ['T1', 'T2', 'T3'], '崩溃前全未闭合')

  const report = recoverInterrupted(log)
  assert.ok(report.turnsClosed >= 3, `未闭合 turn 全补记（实际 ${report.turnsClosed}）`)
  assert.equal(log.verifyChain(), null, '补记后链完整（只追加——recover 也是 append）')
  // R-8 定性锁定：引导 turn 被补记 interrupted（消息已发未跑——语义正确）
  for (const tid of ['T1', 'T2', 'T3']) {
    const end = log.events.find(e => e.kind === 'turnEnd' && e.turnId === tid) as { meta?: Record<string, unknown> }
    assert.ok(end, `${tid} turnEnd 在册`)
    assert.equal(end.meta?.reason, 'interrupted', `${tid} 定性 interrupted（不可与 aborted 混用）`)
    assert.equal(end.meta?.recovered, true, `${tid} recovered=true（副作用未知显式声明）`)
  }
  // 重启后：pending 清零——不重复消费（消费方以 interrupted turnEnd 为据明示「已发未跑」，不静默吞）
  assert.deepEqual(pendingSteerTurns(log), [], '重启续跑行为明示：无 pending（链上留痕可查）')
  const queuedAfter = log.events.filter(e => e.kind === 'user' && (e.turnId === 'T2' || e.turnId === 'T3'))
  assert.equal(queuedAfter.length, 2, '引导 user 事件保留在链（不删除——审计留痕，不静默吞）')
})

// ==================== N1 快照自洽 + 兼容线 ====================

test('s56-5 N1 快照自洽：activeTurnId 快照口径与请求投影同构（引导 append 前后 assert 均 PASS）', () => {
  const log = new SessionLog('s56-n1')
  log.append('user', 'user', 'T1', 'q1')
  log.snapshotModelRequest({ activeTurnId: 'T1' })   // 快照 1：引导前
  log.append('model', 'assistant', 'T1', 'a1')
  log.snapshotModelRequest({ activeTurnId: 'T1' })   // 快照 2：引导前（多步）
  log.append('user', 'user', 'T2', '引导')            // 执行中 append
  log.snapshotModelRequest({ activeTurnId: 'T1' })   // 快照 3：引导后（隔离口径）
  assert.equal(log.assertModelVisibleLogged().ok, true, '三快照逐字节自洽（口径含过滤）')
  // 隔离语义直接断言：快照 3 的投影 = 快照 2 的投影 + T1 assistant（引导被滤）
  const s2 = log.deriveMessages(undefined, { activeTurnId: 'T1' })
  assert.equal(JSON.stringify(s2).includes('引导'), false, '活跃 turn 口径投影不含引导')
  // 1.14.1 缺省口径（无 opts）不受影响——快照 3 若按缺省口径投影则含引导（两口径显式区分）
  assert.equal(JSON.stringify(log.deriveMessages()).includes('引导'), true, '缺省口径仍含引导（1.14.1 行为零变化；消费 turn 用自身 activeTurnId 口径）')
})

test('s56-6 兼容线：无引导事件时 activeTurnId 过滤零命中（执行中链尾 turn 投影与缺省口径逐字节一致）', () => {
  const log = new SessionLog('s56-compat')
  log.append('user', 'user', 'T1', 'q1')
  log.append('model', 'assistant', 'T1', 'a1')
  log.append('runtime', 'turnEnd', 'T1', null, { reason: 'completed' })
  log.append('user', 'user', 'T2', 'q2')
  log.append('model', 'assistant', 'T2', 'a2')
  // T2 执行中（无 turnEnd、链尾）——运行时可达形态：runTurn 只传当前执行中 turn 为 activeTurnId
  assert.equal(
    JSON.stringify(log.deriveMessages(undefined, { activeTurnId: 'T2' })),
    JSON.stringify(log.deriveMessages()),
    'activeTurnId=T2（链尾执行中）过滤零命中——活跃 turn 自身 user 事件 = 起点 seq 不过滤，链上无他 turn 尾随 user',
  )
  // 缺省口径（无 opts）与 1.14.1 逐字节一致（零回归）
  assert.deepEqual(log.deriveMessages(), [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ])
  // 口径适用前提注记（非断言）：历史已闭合 turn 传入 activeTurnId 会滤掉其后正常 turn 的
  // user 事件——该形态运行时不可达（runTurn 只传执行中 turnId），spec 不为病态调用背书
  assert.equal(log.verifyChain(), null)
})
