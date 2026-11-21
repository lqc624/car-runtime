/**
 * s83 · 1.25.1 授权决策附注键（Z-11 / D-V12-1，《v0.12-Z7反向感知Z11同意面Z5召回消费-迭代规划.md》）
 *
 * 覆盖：
 *  - decideByUser 人审回调对象形态 { approve, note } → 决策事件 payload +note 落链
 *    （批准/拒绝两档皆可带——单事件完整审计面）
 *  - boolean 形态字节兼容（无 note 事件零变化——payload 四键不增）+ 超时 EXPIRED 无附注
 *  - 幂等缓存含 note（同 id 重放返回同一决策对象）
 *  - 坏形态 fail-visible：对象缺布尔 approve / note 非串空串 → CAR-E-AUTHZ-NOTE 且决策不落链
 *  - seam 45 零加法（AuthzDecision +note 可选——类型面演化随类出面，运行时符号不变）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { AuthzService } from '../src/authz/authz.ts'

const REQ = { authorizationId: 'A-s83-1', actor: 'p', capability: 'fs-write' as const, resource: '/ws/a.txt' }

test('S83-1 对象形态：附注随决策事件 payload 落链（批准档）', async () => {
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 500 })
  const d = await authz.decideByUser(REQ, async () => ({ approve: true, note: '仅限本次构建目录' }))
  assert.equal(d.decision, 'APPROVED')
  assert.equal(d.decidedBy, 'user')
  assert.equal(d.note, '仅限本次构建目录', '决策对象携带附注')
  const ev = log.events.find((e) => e.turnId === 'authz:A-s83-1')
  assert.ok(ev)
  const p = ev!.payload as Record<string, unknown>
  assert.equal(p['note'], '仅限本次构建目录', 'payload +note 落链（单事件完整审计面）')
  assert.equal(p['decision'], 'APPROVED')
  assert.equal((ev!.meta as Record<string, unknown>)['reason'], 'user approved within timeout', 'reason 硬编码不动')
})

test('S83-2 对象形态拒绝档：附注同样落链（拒绝理由可溯）', async () => {
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 500 })
  const d = await authz.decideByUser(
    { ...REQ, authorizationId: 'A-s83-2' },
    async () => ({ approve: false, note: '该路径在白名单外，先补规则' }),
  )
  assert.equal(d.decision, 'EXPIRED')
  assert.equal(d.note, '该路径在白名单外，先补规则', '拒绝档附注落决策对象')
  const ev = log.events.find((e) => e.turnId === 'authz:A-s83-2')
  assert.equal((ev!.payload as Record<string, unknown>)['note'], '该路径在白名单外，先补规则')
})

test('S83-3 boolean 形态字节兼容 + 超时无附注', async () => {
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 60 })
  await authz.decideByUser({ ...REQ, authorizationId: 'A-s83-3' }, async () => true)
  const ev = log.events.find((e) => e.turnId === 'authz:A-s83-3')
  assert.equal('note' in (ev!.payload as Record<string, unknown>), false, 'boolean 形态 payload 无 note 键（字节兼容）')
  assert.deepEqual(new Set(Object.keys(ev!.payload as Record<string, unknown>)), new Set(['authorizationId', 'decision', 'decidedBy', 'degraded']), 'payload 恰四键（1.25.0 前形态）')
  const d2 = await authz.decideByUser({ ...REQ, authorizationId: 'A-s83-4' }, () => new Promise<false>(() => {}))
  assert.equal(d2.decision, 'EXPIRED')
  assert.equal(d2.note, undefined, '超时无附注（决策=timeout default-deny，附注未及时提交属预期）')
  const ev2 = log.events.find((e) => e.turnId === 'authz:A-s83-4')
  assert.equal('note' in (ev2!.payload as Record<string, unknown>), false)
})

test('S83-4 幂等缓存含 note + 坏形态 fail-visible 决策不落链', async () => {
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 500 })
  const d1 = await authz.decideByUser({ ...REQ, authorizationId: 'A-s83-5' }, async () => ({ approve: true, note: 'n1' }))
  const d2 = await authz.decideByUser({ ...REQ, authorizationId: 'A-s83-5' }, async () => ({ approve: false, note: 'n2' }))
  assert.equal(d2, d1, '同 id 重放返回同一决策（防重放不一致，T-10）')
  assert.equal(d2.note, 'n1')
  // 坏形态一：对象缺布尔 approve
  await assert.rejects(
    () => authz.decideByUser({ ...REQ, authorizationId: 'A-s83-6' }, async () => ({ approve: 'yes' } as never)),
    /CAR-E-AUTHZ-NOTE: 人审回调对象形态缺布尔 approve/,
  )
  // 坏形态二：note 非串
  await assert.rejects(
    () => authz.decideByUser({ ...REQ, authorizationId: 'A-s83-7' }, async () => ({ approve: true, note: 42 as never })),
    /CAR-E-AUTHZ-NOTE: 决策附注非法/,
  )
  // 坏形态三：note 空串
  await assert.rejects(
    () => authz.decideByUser({ ...REQ, authorizationId: 'A-s83-8' }, async () => ({ approve: true, note: '   ' })),
    /CAR-E-AUTHZ-NOTE: 决策附注非法/,
  )
  assert.equal(log.events.filter((e) => String(e.turnId).startsWith('authz:A-s83-6') || String(e.turnId).startsWith('authz:A-s83-7') || String(e.turnId).startsWith('authz:A-s83-8')).length, 0, '坏形态决策不落链（fail-visible）')
})
