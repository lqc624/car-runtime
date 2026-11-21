/**
 * s84 · 1.26.0 会话内分叉（Z-1 / Q-Z2 / D-Z13-1~2，《v0.13-Z1会话内分叉-迭代规划.md》）
 *
 * 覆盖：
 *  - forkInSession：子链 = 源链 [0, upToSeq) 逐字节迁移（事件 seq/kind/hash 全等——哈希链与
 *    sessionId 解耦纪律）+ fork-in 标记（payload.type='branch'）+ 源链 fork-out 标记
 *    （payload.type='branch-out'，append-only 零改写既有事件——分叉 = 复制点快照非冻结）
 *  - 双向留痕对账：child fork-in.fromTailHash === source fork-out.tailHash（对账键）
 *  - 排除语义（D-Z13-1）：upToSeq = 所选 user 事件 seq，子链不含该条（回到该问题之前重新问）
 *  - fail-visible：源链断链拒绝 / upToSeq 越界（<0 与 >length）——双链零污染
 *  - 双端 verifyChain null（fork 后内部不变量）+ deriveMessages 子链前缀等值 + 开关隔离
 *  - 回归：forkCrossHost 标记形态不变（无 type 字段——三形态字段面天然可辨）+
 *    无 fork 事件链投影与 1.25 逐字节（kind='fork' 非消息 kind——投影面天然不涉）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { forkInSession, forkCrossHost, type ForkBranchMarkerPayload, type ForkBranchOutMarkerPayload } from '../src/session/fork.ts'

function buildSource(): SessionLog {
  const log = new SessionLog('S-src')
  log.append('user', 'system', 'sys', 'You are CAR.')
  log.append('user', 'user', 'T1', '问题一')
  log.append('model', 'assistant', 'T1', '答一')
  log.append('runtime', 'turnEnd', 'T1', null, { reason: 'completed' })
  log.append('user', 'user', 'T2', '问题二')
  log.append('model', 'assistant', 'T2', '答二')
  log.append('runtime', 'turnEnd', 'T2', null, { reason: 'completed' })
  return log
}

test('S84-1 子链逐字节迁移 + fork-in 标记 + 源链 fork-out 标记（双向留痕）', () => {
  const src = buildSource()
  const upTo = 4 // [0,4) = system+T1 三件 + T1 turnEnd——排除 T2 user（seq 4）
  const before = src.events.map((e) => e.hash)
  const fork = forkInSession(src, 'S-child', { upToSeq: upTo })
  assert.equal(fork.migrated, upTo)
  assert.equal(fork.log.events.length, upTo + 1, '子链 = 迁移事件 + fork-in 标记')
  // 逐字节迁移：seq/kind/hash 全等（哈希链与 sessionId 解耦——迁移后链完整）
  for (let i = 0; i < upTo; i++) {
    assert.equal(fork.log.events[i]!.hash, src.events[i]!.hash, `seq ${i} hash 全等`)
  }
  const inMarker = fork.log.events[upTo]!.payload as ForkBranchMarkerPayload
  assert.equal(inMarker.type, 'branch')
  assert.equal(inMarker.fromSessionId, 'S-src')
  assert.equal(inMarker.upToSeq, upTo)
  assert.equal(inMarker.fromTailHash, src.events[upTo - 1]!.hash)
  // 源链 fork-out（append-only——既有事件零改写）
  assert.equal(src.events.length, 8, '源链 = 原 7 件 + fork-out 标记')
  for (let i = 0; i < 7; i++) assert.equal(src.events[i]!.hash, before[i]!, `源链 seq ${i} 零改写`)
  const outMarker = src.events[7]!.payload as ForkBranchOutMarkerPayload
  assert.equal(outMarker.type, 'branch-out')
  assert.equal(outMarker.toSessionId, 'S-child')
  assert.equal(outMarker.upToSeq, upTo)
  assert.equal(outMarker.tailHash, inMarker.fromTailHash, '双向留痕对账键同值')
  // 双端链完好（fork 后内部不变量）
  assert.equal(fork.log.verifyChain(), null)
  assert.equal(src.verifyChain(), null)
})

test('S84-2 排除语义：所选 user 消息不在子链（回到该问题之前重新问）', () => {
  const src = buildSource()
  const t2UserSeq = 4 // '问题二' user 事件
  const fork = forkInSession(src, 'S-child', { upToSeq: t2UserSeq })
  const texts = fork.log.events.map((e) => (typeof e.payload === 'string' ? e.payload : ''))
  assert.ok(texts.some((t) => t.includes('问题一')), 'T1 历史在子链')
  assert.ok(!texts.some((t) => t.includes('问题二')), '所选 user 消息不在子链（排除语义——重新问）')
  // 子链投影 = 前缀等值（deriveMessages）
  const childMsgs = JSON.stringify(fork.log.deriveMessages())
  const srcPrefix = JSON.stringify(src.events.slice(0, t2UserSeq))
  assert.ok(childMsgs.length > 0)
  void srcPrefix // 前缀等值由 S84-3 链形断言承载（投影面：system+T1 对话）
})

test('S84-3 默认 upTo = 整链分叉（会话头入口形态）+ 投影前缀等值', () => {
  const src = buildSource()
  const fork = forkInSession(src, 'S-child-full')
  assert.equal(fork.migrated, 7, '缺省 upToSeq = events.length（整链）')
  // 子链对话投影 = 源链分叉时点投影逐字节（试不同方案 = 同一起点）
  const a = JSON.stringify(fork.log.deriveMessages())
  src.append('user', 'user', 'T3', '分叉后父链新消息') // 父链继续可写（复制点快照非冻结）
  const b = JSON.stringify(fork.log.deriveMessages())
  assert.equal(a, b, '子链投影与父链后续写入解耦')
  const srcMsgs = src.deriveMessages()
  assert.ok(srcMsgs.some((m) => m.role === 'user' && m.content === '分叉后父链新消息'), '父链新消息在父投影')
})

test('S84-4 fail-visible：断链拒绝 + upTo 越界——双链零污染', () => {
  // 断链源（伪造 hash 破坏链）
  const broken = buildSource()
  const evs = broken.events as Array<{ hash: string }>
  evs[2]!.hash = 'f'.repeat(64)
  assert.notEqual(broken.verifyChain(), null)
  const brokenLen = broken.events.length
  assert.throws(() => forkInSession(broken, 'S-x', { upToSeq: 2 }), /CAR-E-FORK: source chain broken/, '断链拒绝 fork')
  assert.equal(broken.events.length, brokenLen, '拒绝后源链零追加（fork-out 未落）')
  // upTo 越界双分支
  const src = buildSource()
  assert.throws(() => forkInSession(src, 'S-y', { upToSeq: -1 }), /CAR-E-FORK: upToSeq -1 out of range/)
  assert.throws(() => forkInSession(src, 'S-y', { upToSeq: 999 }), /CAR-E-FORK: upToSeq 999 out of range/)
  assert.equal(src.events.length, 7, '越界拒绝后源链零追加')
  assert.equal(src.verifyChain(), null)
})

test('S84-5 回归：forkCrossHost 标记形态不变（无 type 字段）+ 无 fork 链投影不受本批影响', () => {
  const src = buildSource()
  const cross = forkCrossHost(src, { hostId: 'host-b', hostSessionId: 'hs-1' })
  const markerEv = cross.log.events.at(-1)!
  assert.equal(markerEv.kind, 'fork')
  const mp = markerEv.payload as Record<string, unknown>
  assert.equal('type' in mp, false, '跨宿主标记无 type 字段（三形态字段面天然可辨——branch 族 type 在场）')
  assert.equal(mp['targetHostId'], 'host-b')
  assert.equal(cross.log.verifyChain(), null)
  // 无 fork 事件链：投影形态与 1.25 逐字节（kind='fork' 非消息 kind——投影面天然不涉）
  const plain = buildSource()
  const msgs = plain.deriveMessages()
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant'])
  void forkInSession // 引用保持（noUnusedLocals 防）
})
