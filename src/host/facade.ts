/**
 * T-1 · RuntimeFacade 真实实现（M3-S12）：归一化数据流落到 SessionLog
 *
 * 口径（M3系统设计增补 T-1 / 决议⑤）：
 *  - sessionStart：deriveSessionId 派生 + 首次映射登记事件落哈希链（hostRaw 载体，hostEvent=session_registered）；
 *  - sessionTurn：宿主报事件批（{hostEvent, payload}[]）→ 逐条 normalizeHostEvent → append 落盘；
 *    未命中事件走 hostRaw 降级（零静默）；turnEnd reason 由最后一条归一化 turnEnd 决定（缺省 completed）；
 *  - 模型循环由宿主驱动（「统一边界而非统一内部」）：CAR 承载日志/审计/工具面，step 循环不暴露；
 *  - 会话内存态 Map 承载（v0.2.0 SessionLog 语义），持久化经 sessionExport（取证包）与后续 S13 文件落盘增强。
 */
import { SessionLog, type EventKind } from '../session/log.ts'
import { forkCrossHost, loadForkedLog } from '../session/fork.ts'
import { deriveSessionId, normalizeHostEvent } from './mappings.ts'
import type { HostProfile } from './mappings.ts'
import type { RuntimeFacade } from './hostGateway.ts'

interface SessionState { log: SessionLog; profile: HostProfile; hostSessionId: string; turnCount: number; lastReason: string }

/** 迁移事件里已用过的最大 turn 序号（T{n}）——import 侧续跑 turnId 不与迁移段冲突 */
function maxTurnIndex(log: SessionLog): number {
  let max = 0
  for (const e of log.events) {
    const m = /^T(\d+)$/.exec(e.turnId)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

export function createRuntimeFacade(opts: { profiles: Map<string, HostProfile> }): RuntimeFacade {
  const sessions = new Map<string, SessionState>()

  const bySession = (sessionId: string): SessionState => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error(`CAR-E-HOST: session "${sessionId}" not found（session_start 先行）`)
    return s
  }

  return {
    async sessionStart(args) {
      const { hostSessionId, importJsonl } = args as { hostSessionId: string; importJsonl?: string; __hostId?: string }
      const hostId = (args as { __hostId?: string }).__hostId as string
      const profile = opts.profiles.get(hostId)
      if (!profile) throw new Error('CAR-A050001: host profile not registered')
      const sessionId = deriveSessionId(hostId, hostSessionId)
      if (sessions.has(sessionId)) return { sessionId } // 幂等：同一宿主会话重复 start 返回同一 CAR 会话
      // M5-DEC4：fork 工件导入（跨宿主 resume）——归属校验（target 必须命中本宿主）+ 断链拒绝
      if (importJsonl !== undefined) {
        const { log } = loadForkedLog(importJsonl, { hostId, hostSessionId })
        const turnCount = maxTurnIndex(log)
        sessions.set(sessionId, { log, profile, hostSessionId, turnCount, lastReason: 'completed' })
        return { sessionId }
      }
      const log = new SessionLog(sessionId)
      log.append('runtime', 'hostRaw', 'T0', { hostEvent: 'session_registered', hostId, hostSessionId })
      sessions.set(sessionId, { log, profile, hostSessionId, turnCount: 0, lastReason: 'completed' })
      return { sessionId }
    },

    // M5-DEC4 转正：跨宿主 fork——源会话链逐字节迁移 + fork 标记落链，产出可迁移 JSONL 工件
    async sessionFork({ sessionId, targetHostId, targetHostSessionId, upToSeq }) {
      const s = bySession(sessionId)
      if (!opts.profiles.has(targetHostId)) throw new Error(`CAR-A050001: target host "${targetHostId}" not registered（目标宿主须登记）`)
      const fork = forkCrossHost(s.log, { hostId: targetHostId, hostSessionId: targetHostSessionId }, { upToSeq })
      return { sessionId: fork.sessionId, jsonl: fork.jsonl, migrated: fork.migrated }
    },

    async sessionTurn({ sessionId, input }) {
      const s = bySession(sessionId)
      s.turnCount++
      const turnId = `T${s.turnCount}`
      let reason = 'completed'
      const batch = (input as { events?: Array<{ hostEvent: string; payload?: Record<string, unknown> }> }).events ?? []
      for (const ev of batch) {
        const n = normalizeHostEvent(s.profile, ev.hostEvent, ev.payload ?? {})
        s.log.append(n.actor as 'user', n.kind as EventKind, turnId, n.payload)
        if (n.kind === 'turnEnd') {
          const r = (n.payload as { reason?: string }).reason
          if (r) reason = r
        }
      }
      s.lastReason = reason
      return { reason, steps: s.turnCount }
    },

    async sessionStop({ sessionId }) {
      const s = bySession(sessionId)
      s.log.append('runtime', 'turnEnd', `T${s.turnCount}`, null, { reason: 'aborted' })
      s.lastReason = 'aborted'
      return { reason: 'aborted' }
    },

    async sessionStatus({ sessionId }) {
      const s = bySession(sessionId)
      return { state: 'idle', lastReason: s.lastReason }
    },

    async sessionReplay({ sessionId }) {
      return { messages: bySession(sessionId).log.deriveMessages() }
    },

    async sessionVerify({ sessionId }) {
      const brokenAt = bySession(sessionId).log.verifyChain()
      return { ok: brokenAt === null, brokenAt }
    },

    async sessionExport({ sessionId }) {
      const s = bySession(sessionId)
      // 延迟 import 避免与 facade 类型循环（exportForensicsBundle 依赖 SessionLog 类型）
      const { exportForensicsBundle } = await import('../session/export.ts')
      const bundle = exportForensicsBundle(s.log, {
        sessionId, exportedBy: 'host:' + s.profile.hostId, exportedAt: new Date().toISOString(),
        runtimeVersion: '0.2.0', sessionRange: { fromSeq: 0, toSeq: s.log.events.length - 1 },
      })
      return { bundle }
    },

    async toolList() {
      return { tools: [] } // S13：宿主工具面透传（登记制接入宿主侧工具）
    },

    async toolCall() {
      return { ok: false, error: 'tool 面透传在 S13 实装（tool_list/tool_call）' }
    },
  }
}
