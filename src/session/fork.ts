/**
 * T-1④ 转正 · 跨宿主 fork/resume（M5 · DEC-4 预埋项 2/2，原 M3 §1.7 显式延后项）
 *
 * 口径（M3系统设计增补 §1.7 / M4 RC-3 / M5 DEC-4 用户裁决①）：
 *  - 语义：宿主 A 发起的会话在宿主 B 续跑——fork 产出可迁移 JSONL 工件（链逐字节保留），
 *    resume 侧装载校验（断链即拒绝）+ 归属校验（fork 标记 target 与装载宿主不匹配即拒绝）；
 *  - 会话 id 确定性派生复用（deriveSessionId）：fork 目标会话 id = SH-(targetHostId|targetHostSessionId)，
 *    resume 侧幂等重推导，不信任工件命名；
 *  - fork 标记事件（kind='fork'）落链：fromSessionId/target/upToSeq 全量留痕，零静默；
 *  - 哈希链与 sessionId 解耦（事件哈希不含会话 id）→ 链逐字节迁移后 verifyChain 仍完整。
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
