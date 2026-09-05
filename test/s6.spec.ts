import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { enforceSignature, verifyMinisig, type SignatureBundle } from '../src/load/verifier.ts'
import { GoalDriver } from '../src/loop/goal.ts'
import { recoverInterrupted } from '../src/loop/recover.ts'
import { runTurn } from '../src/loop/stop.ts'
import { SessionLog } from '../src/session/log.ts'

// ==================== 验签器（ADR-003 双轨 / D-2 enforce 分级） ====================

function makeTrustRoot() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const signHash = (hash: string) => sign(null, Buffer.from(hash), privateKey).toString('base64')
  return { pubB64, signHash }
}

const HASH = createHash('sha256').update('manifest-body').digest('hex')

test('S6: minisig 验证——正确签名放行，篡改硬拒绝（不可配置放行）', () => {
  const { pubB64, signHash } = makeTrustRoot()
  const sig: SignatureBundle = { minisig: signHash(HASH) }
  const good = enforceSignature(HASH, sig, { trustRootPublicKey: pubB64, mode: 'warn' })
  assert.equal(good.allowed, true)
  assert.equal(good.warning, undefined)
  // 篡改哈希后验签失败——即使 warn 模式也硬拒绝
  const bad = enforceSignature(HASH + 'x', sig, { trustRootPublicKey: pubB64, mode: 'warn' })
  assert.equal(bad.allowed, false)
  assert.match(bad.error!, /verification FAILED.*不可配置放行/)
})

test('S6 D-2: 签名缺失——warn 告警放行（指纹兜底），enforce 硬拒绝', () => {
  const { pubB64 } = makeTrustRoot()
  const warn = enforceSignature(HASH, undefined, { trustRootPublicKey: pubB64, mode: 'warn' })
  assert.equal(warn.allowed, true)
  assert.match(warn.warning!, /CAR-W-SIG.*enforce 切换见 D-2 终局条件/)
  const enforce = enforceSignature(HASH, undefined, { trustRootPublicKey: pubB64, mode: 'enforce' })
  assert.equal(enforce.allowed, false)
  assert.match(enforce.error!, /signature missing/)
})

test('S6 ADR-003: Sigstore 不可达 → 回退静态轨（双轨回退语义）', () => {
  const { pubB64, signHash } = makeTrustRoot()
  const sig: SignatureBundle = { minisig: signHash(HASH), sigstoreBundle: '<bundled>' }
  const r = enforceSignature(HASH, sig, {
    trustRootPublicKey: pubB64, mode: 'enforce',
    sigstoreAvailable: () => true, // 主轨探针可用但骨架期 bundle 校验不可达 → 回退静态轨
  })
  assert.equal(r.allowed, true) // 静态轨兜底成功
})

test('S6: verifyMinisig 对非法 base64 不崩溃（fail-closed）', () => {
  const { pubB64 } = makeTrustRoot()
  const r = verifyMinisig(HASH, 'not-base64!!!', pubB64)
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

// ==================== F13 Goal 层 ====================

test('F13: Goal phase 持久化（goalUpdate 事件）+ 恢复层重放（activation 不恢复=disarmed）', () => {
  const log = new SessionLog()
  const goal = new GoalDriver(log)
  goal.arm()
  assert.equal(goal.activation, 'armed')
  goal.setPhase('paused', 'waiting for external event')
  goal.setPhase('complete', 'done')
  const events = log.events as any[]
  assert.equal(events.filter(e => e.kind === 'goalUpdate').length, 2)
  const replay = GoalDriver.replay(log.events)
  assert.equal(replay.phase, 'complete')   // phase 从日志重放
  assert.equal(replay.activation, 'disarmed') // activation 永不持久化（AC-4.5）
})

test('F13: 新实例默认 disarmed（重启不会把历史任务叫醒，AC-4.5）', () => {
  const goal = new GoalDriver(new SessionLog())
  assert.equal(goal.activation, 'disarmed')
  assert.equal(goal.phase, 'active')
})

test('F13: 非 completed 收口自动 disarm（D5 §9：撞限/错误都会 disarm）', () => {
  const goal = new GoalDriver(new SessionLog())
  goal.arm()
  goal.autoDisarmOnTurnEnd('max-tokens')
  assert.equal(goal.activation, 'disarmed')
  goal.arm()
  goal.autoDisarmOnTurnEnd('completed')
  assert.equal(goal.activation, 'armed') // completed 不 disarm
})

// ==================== F13 aggregate 可配置 + blockOnDeny ====================

test('F13: aggregate.terminate=any——单个 terminate 即 aborted（对照默认 AND）', async () => {
  const log = new SessionLog()
  const tools = new Map([
    ['killer', { declaredSideEffect: 'readonly', terminate: true, run: async () => 'k' } as any],
    ['probe', { declaredSideEffect: 'readonly', run: async () => 'p' } as any],
  ])
  const r = await runTurn({
    log, turnId: 'T', tools,
    preset: { aggregate: { terminate: 'any' } },
    model: async (): Promise<any> => ({ stopReason: 'toolUse', toolCalls: [
      { id: 'c1', tool: 'probe', args: {} }, { id: 'c2', tool: 'killer', args: {} },
    ] }),
  })
  assert.equal(r.reason, 'aborted') // any：killer 投票即整批终止（对照 M1 默认 AND 需全部）
})

test('F13: aggregate.concludesTurn=all——单工具收口不再立即 completed（对照默认 OR）', async () => {
  const log = new SessionLog()
  let n = 0
  const tools = new Map([
    ['probe', { declaredSideEffect: 'readonly', run: async () => 'p' } as any],
    ['commit', { declaredSideEffect: 'write', concludesTurn: true, run: async () => 'c' } as any],
  ])
  const r = await runTurn({
    log, turnId: 'T', tools, preset: { mode: 'full', aggregate: { concludesTurn: 'all' } },
    model: async (): Promise<any> => n++ === 0
      ? { stopReason: 'toolUse', toolCalls: [
          { id: 'c1', tool: 'probe', args: {} }, { id: 'c2', tool: 'commit', args: {} },
        ] }
      : { stopReason: 'stop', text: 'final' },
  })
  // all 模式：批次 2 个工具仅 1 个 conclude 投票 → concludesAll 不满足 → 模型继续 → stop 收口
  // （对照默认 OR：同批次会立即 completed——见 s2/s4 用例）
  assert.equal(r.reason, 'completed')
  assert.equal(r.steps, 2)
})

test('F13: blockOnDeny——授权拒绝即收口 blocked（产出点新增，枚举不增）', async () => {
  const log = new SessionLog()
  const tools = new Map([['danger', { declaredSideEffect: 'write', run: async () => 'x' } as any]])
  const r = await runTurn({
    log, turnId: 'T', tools,
    preset: { mode: 'confirm', blockOnDeny: true, authorize: async () => false },
    model: async (): Promise<any> => ({ stopReason: 'toolUse', toolCalls: [{ id: 'c1', tool: 'danger', args: {} }] }),
  })
  assert.equal(r.reason, 'blocked')
  const end = log.events.find(e => e.kind === 'turnEnd') as any
  assert.equal(end.meta.reason, 'blocked')
})

// ==================== 恢复层（interrupted） ====================

test('F13: recoverInterrupted——未配对 toolCall 补合成结果 + 未闭合 turn 补记 interrupted', () => {
  const log = new SessionLog()
  log.append('user', 'user', 'T1', 'go')
  log.append('model', 'toolCall', 'T1', { id: 'c1', tool: 't', args: {} })
  // 模拟进程消失：c1 无 toolResult、T1 无 turnEnd
  const report = recoverInterrupted(log)
  assert.equal(report.pairedCalls, 1)
  assert.equal(report.turnsClosed, 1)
  const synthetic = log.events.find(e => e.kind === 'toolResult' && (e.payload as any).id === 'c1') as any
  assert.equal(synthetic.payload.recovered, true) // 副作用状态未知显式声明
  const end = log.events.find(e => e.kind === 'turnEnd' && e.turnId === 'T1') as any
  assert.equal(end.meta.reason, 'interrupted') // 与 aborted 不混用
})

test('F13: 已配对/已闭合日志幂等（重复恢复零补记）', () => {
  const log = new SessionLog()
  log.append('user', 'user', 'T1', 'go')
  log.append('model', 'toolCall', 'T1', { id: 'c1', tool: 't', args: {} })
  log.append('plugin', 'toolResult', 'T1', { id: 'c1', result: 'ok' })
  log.append('runtime', 'turnEnd', 'T1', null, { reason: 'completed' })
  const report = recoverInterrupted(log)
  assert.equal(report.pairedCalls, 0)
  assert.equal(report.turnsClosed, 0)
})
