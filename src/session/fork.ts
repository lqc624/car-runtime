/**
 * T-1④ 转正 · 跨宿主 fork/resume（M5 · DEC-4 预埋项 2/2，原 M3 §1.7 显式延后项）
 * 1.26.0 · Z-1 会话内分叉（Q-Z2 / D-Z13-1~2，《v0.13-Z1会话内分叉-迭代规划.md》）
 *
 * 口径（M3系统设计增补 §1.7 / M4 RC-3 / M5 DEC-4 用户裁决①）：
 *  - 语义：宿主 A 发起的会话在宿主 B 续跑——fork 产出可迁移 JSONL 工件（链逐字节保留），
 *    resume 侧装载校验（断链即拒绝）+ 归属校验（fork 标记 target 与装载宿主不匹配即拒绝）；
 *  - 会话 id 确定性派生复用（deriveSessionId）：fork 目标会话 id = SH-(targetHostId|targetHostSessionId)，
 *    resume 侧幂等重推导，不信任工件命名；
 *  - fork 标记事件（kind='fork'）落链：fromSessionId/target/upToSeq 全量留痕，零静默；
 *  - 哈希链与 sessionId 解耦（事件哈希不含会话 id）→ 链逐字节迁移后 verifyChain 仍完整。
 *
 * 1.26.0 加法口径（forkInSession——同宿主消息边界分支，语义正交于跨宿主迁移）：
 *  - 子链 = [0, upToSeq) 逐字节迁移（同解耦纪律）+ fork-in 标记（payload.type='branch'）；
 *    源链 append fork-out 标记（payload.type='branch-out'）——双向留痕零静默（D-Z13-2），
 *    append-only 不改写既有事件；
 *  - 标记 payload.type 判别分立（settlement 先例）：跨宿主 ForkMarkerPayload 无 type 字段，
 *    branch 族以 type 在场区分——三形态字段面天然可辨；
 *  - 排除语义（D-Z13-1）：upToSeq = 所选 user 事件 seq，子链不含该条（回到该问题之前重新问）；
 *    边界选点由宿主承担（消息行透传链 seq），内核只做 range/断链校验；
 *  - EventKind 零新增（'fork' 已在册——eventmap golden 不动）；双标记 turnId='F0'（跨宿主同款）。
 */
import { SessionLog, type SessionEvent } from './log.ts'
import { deriveSessionId } from '../host/mappings.ts'

export interface ForkTarget { hostId: string; hostSessionId: string }

export interface CrossHostFork {
  /** 宿主 B 侧新会话 id（SH- 确定性派生） */
  sessionId: string
  /** 可迁移工件（JSONL 全文——经取证通道传递给宿主 B） */
  jsonl: string
  /** 迁移的事件数（不含 fork 标记） */
  migrated: number
  /** fork 后内存态日志（同进程等价验证用；跨进程走 jsonl 工件） */
  log: SessionLog
}

/** fork 标记事件 payload（resume 侧归属校验数据源） */
export interface ForkMarkerPayload {
  fromSessionId: string
  targetHostId: string
  targetHostSessionId: string
  upToSeq: number
  fromTailHash: string
}

/**
 * 跨宿主 fork：源会话 [0, upToSeq) 事件逐字节迁移 + fork 标记落链。
 * 源链断链即抛错（fail-visible：破损链不允许扩散为「合法」新会话）。
 */
export function forkCrossHost(source: SessionLog, target: ForkTarget, opts?: { upToSeq?: number }): CrossHostFork {
  const brokenAt = source.verifyChain()
  if (brokenAt !== null) throw new Error(`CAR-E-FORK: source chain broken at seq ${brokenAt}（断链拒绝 fork）`)
  const upToSeq = opts?.upToSeq ?? source.events.length
  if (!Number.isInteger(upToSeq) || upToSeq < 0 || upToSeq > source.events.length) {
    throw new Error(`CAR-E-FORK: upToSeq ${upToSeq} out of range [0, ${source.events.length}]`)
  }
  const sessionId = deriveSessionId(target.hostId, target.hostSessionId)
  const log = SessionLog.fromEvents(sessionId, source.events.slice(0, upToSeq))
  const marker: ForkMarkerPayload = {
    fromSessionId: source.sessionId,
    targetHostId: target.hostId,
    targetHostSessionId: target.hostSessionId,
    upToSeq,
    fromTailHash: upToSeq > 0 ? source.events[upToSeq - 1]!.hash : 'GENESIS',
  }
  log.append('runtime', 'fork', 'F0', marker)
  const brokenAfter = log.verifyChain()
  if (brokenAfter !== null) throw new Error(`CAR-E-FORK: post-fork chain broken at seq ${brokenAfter}（内部不变量违例）`)
  return { sessionId, jsonl: log.exportJSONL(), migrated: upToSeq, log }
}

export interface LoadedFork {
  log: SessionLog
  sessionId: string
  marker: ForkMarkerPayload
}

/**
 * resume 侧装载：JSONL 工件 → 校验链完整性 → 提取 fork 标记 → 确定性重推导会话 id。
 * 断链 / 无 fork 标记 / 标记畸形 = 抛错（不静默降级为普通会话）。
 */
export function loadForkedLog(jsonl: string, expected?: ForkTarget): LoadedFork {
  const events = jsonl.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as SessionEvent)
  const markerEvent = [...events].reverse().find(e => e.kind === 'fork')
  if (!markerEvent) throw new Error('CAR-E-FORK: no fork marker in artifact（非 fork 工件拒绝装载）')
  const marker = markerEvent.payload as ForkMarkerPayload
  if (!marker || typeof marker.targetHostId !== 'string' || typeof marker.targetHostSessionId !== 'string') {
    throw new Error('CAR-E-FORK: fork marker malformed（标记缺 target 字段）')
  }
  if (expected && (marker.targetHostId !== expected.hostId || marker.targetHostSessionId !== expected.hostSessionId)) {
    throw new Error(`CAR-E-FORK: artifact target mismatch（工件归属 ${marker.targetHostId}/${marker.targetHostSessionId}，装载方 ${expected.hostId}/${expected.hostSessionId}）`)
  }
  const sessionId = deriveSessionId(marker.targetHostId, marker.targetHostSessionId)
  const log = SessionLog.fromEvents(sessionId, events)
  const brokenAt = log.verifyChain()
  if (brokenAt !== null) throw new Error(`CAR-E-FORK: artifact chain broken at seq ${brokenAt}（断链拒绝装载）`)
  return { log, sessionId, marker }
}

// ── 1.26.0 · Z-1 会话内分叉（同宿主消息边界分支——与跨宿主迁移语义正交） ──────────

/** fork-in 标记 payload（子链侧——payload.type='branch' 判别） */
export interface ForkBranchMarkerPayload {
  type: 'branch'
  fromSessionId: string
  /** 分叉边界（子链含 [0, upToSeq)——排除语义 D-Z13-1：所选 user 事件不在子链） */
  upToSeq: number
  /** 源链边界前一件事哈希（GENESIS = 空前缀分叉） */
  fromTailHash: string
}

/** fork-out 标记 payload（源链侧——payload.type='branch-out' 判别） */
export interface ForkBranchOutMarkerPayload {
  type: 'branch-out'
  toSessionId: string
  upToSeq: number
  /** 源链边界前一件事哈希（与子链 fromTailHash 同值——双向留痕对账键） */
  tailHash: string
}

export interface InSessionFork {
  /** 子会话 id（调用方派生——桌面 S- 形态；跨宿主 SH- 派生不复用） */
  sessionId: string
  /** 子链内存态（已含 fork-in 标记；落盘由宿主 SessionFileStore 承担） */
  log: SessionLog
  /** 迁移的事件数（不含 fork-in 标记） */
  migrated: number
}

/**
 * 同宿主会话内分叉（Z-1 / D-Z13-1~2）：源链 [0, upToSeq) 逐字节迁移为子链 + 双向标记落链。
 * 源链断链即抛错（fail-visible 同 forkCrossHost——破损链不允许扩散）；upTo 越界拒绝。
 * 子链 fork-in（type='branch'）+ 源链 fork-out（type='branch-out'，append-only 零改写既有事件）
 * ——双向留痕：审计从任一端查到对端（tailHash/fromTailHash 同值 = 对账键）。
 */
export function forkInSession(source: SessionLog, newSessionId: string, opts?: { upToSeq?: number }): InSessionFork {
  const brokenAt = source.verifyChain()
  if (brokenAt !== null) throw new Error(`CAR-E-FORK: source chain broken at seq ${brokenAt}（断链拒绝 fork——分支不扩散破损）`)
  const upToSeq = opts?.upToSeq ?? source.events.length
  if (!Number.isInteger(upToSeq) || upToSeq < 0 || upToSeq > source.events.length) {
    throw new Error(`CAR-E-FORK: upToSeq ${upToSeq} out of range [0, ${source.events.length}]`)
  }
  const tailHash = upToSeq > 0 ? source.events[upToSeq - 1]!.hash : 'GENESIS'
  // 子链：逐字节迁移 + fork-in 标记（SessionLog.fromEvents 重建哈希链——sessionId 解耦纪律下链完整性保持）
  const log = SessionLog.fromEvents(newSessionId, source.events.slice(0, upToSeq))
  log.append('runtime', 'fork', 'F0', {
    type: 'branch',
    fromSessionId: source.sessionId,
    upToSeq,
    fromTailHash: tailHash,
  } satisfies ForkBranchMarkerPayload)
  // 源链：fork-out 标记（append-only 零改写——分叉 = 复制点快照非冻结，父链继续可写）
  source.append('runtime', 'fork', 'F0', {
    type: 'branch-out',
    toSessionId: newSessionId,
    upToSeq,
    tailHash,
  } satisfies ForkBranchOutMarkerPayload)
  const childBroken = log.verifyChain()
  if (childBroken !== null) throw new Error(`CAR-E-FORK: post-fork child chain broken at seq ${childBroken}（内部不变量违例）`)
  const sourceBroken = source.verifyChain()
  if (sourceBroken !== null) throw new Error(`CAR-E-FORK: post-fork source chain broken at seq ${sourceBroken}（内部不变量违例）`)
  return { sessionId: newSessionId, log, migrated: upToSeq }
}
