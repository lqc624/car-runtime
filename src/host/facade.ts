/**
 * T-1 · RuntimeFacade 真实实现（M3-S12）：归一化数据流落到 SessionLog
 *
 * 口径（M3系统设计增补 T-1 / 决议⑤）：
 *  - sessionStart：deriveSessionId 派生 + 首次映射登记事件落哈希链（hostRaw 载体，hostEvent=session_registered）；
 *  - sessionTurn：宿主报事件批（{hostEvent, payload}[]）→ 逐条 normalizeHostEvent → append 落盘；
 *    未命中事件走 hostRaw 降级（零静默）；turnEnd reason 由最后一条归一化 turnEnd 决定（缺省 completed）；
 *  - 模型循环由宿主驱动（「统一边界而非统一内部」）：CAR 承载日志/审计/工具面，step 循环不暴露；
 *  - 会话内存态 Map 承载（v0.2.0 SessionLog 语义），持久化经 sessionExport（取证包）与后续 S13 文件落盘增强。
 *  - 1.6-S2（D-25）宿主工具面透传：opts.tools 注入插件工具 Map（mcp-serve 装配）——
 *    toolList 出 name/description/parameters（declaredSideEffect 不出站：权限面只进权限门红线）；
 *    toolCall 经权限门（T-22 缺省 write 收口；write 类 policy 拒绝——mcp-serve 无人审回路，
 *    人审 confirm 属 turn 循环 preset.authorize 通道不外推到宿主面）+ 成对落链
 *    （actor='user' 宿主=用户代理 / turnId='T0' 会话级能力面，sessionTurn 从 T1 起不冲突）；
 *    未装配 tools 时显式报错（S13 占位「静默空面」退役——fail-visible）。
 */
import { SessionLog, type EventKind } from '../session/log.ts'
import { forkCrossHost, loadForkedLog } from '../session/fork.ts'
import { deriveSessionId, normalizeHostEvent } from './mappings.ts'
import type { HostProfile } from './mappings.ts'
import type { RuntimeFacade } from './hostGateway.ts'
import type { ToolReg } from '../load/loader.ts'

interface SessionState { log: SessionLog; profile: HostProfile; hostSessionId: string; turnCount: number; lastReason: string; hostToolSeq: number }

/** 宿主工具面声明形态（toolList 出站——权限面字段不出站） */
export interface HostToolDescriptor { name: string; description?: string; parameters?: unknown }

/** 迁移事件里已用过的最大 turn 序号（T{n}）——import 侧续跑 turnId 不与迁移段冲突 */
function maxTurnIndex(log: SessionLog): number {
  let max = 0
  for (const e of log.events) {
    const m = /^T(\d+)$/.exec(e.turnId)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

export function createRuntimeFacade(opts: { profiles: Map<string, HostProfile>; tools?: Map<string, ToolReg> }): RuntimeFacade {
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
        sessions.set(sessionId, { log, profile, hostSessionId, turnCount, lastReason: 'completed', hostToolSeq: 0 })
        return { sessionId }
      }
      const log = new SessionLog(sessionId)
      log.append('runtime', 'hostRaw', 'T0', { hostEvent: 'session_registered', hostId, hostSessionId })
      sessions.set(sessionId, { log, profile, hostSessionId, turnCount: 0, lastReason: 'completed', hostToolSeq: 0 })
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
      if (!opts.tools) return { tools: [] } // 未装配 = 空面（与占位形态兼容）；装配后出声明面
      const out: HostToolDescriptor[] = []
      for (const t of opts.tools.values()) {
        out.push({ name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), ...(t.parameters !== undefined ? { parameters: t.parameters } : {}) })
      }
      return { tools: out }
    },

    // 1.6-S2（D-25）：权限门语义——未知工具显式报错；T-22 缺省 write；write 类 policy 拒绝
    //（mcp-serve 无人审回路，deny-by-default）；readonly 执行；工具异常=成对错误结果（US-5 同款）。
    // 全路径成对落链（toolCall/toolResult）——宿主面调用 100% 留痕哈希链。
    async toolCall(args) {
      const { sessionId, tool, arguments: toolArgs } = args as { sessionId?: string; tool?: string; arguments?: Record<string, unknown> }
      const s = bySession(String(sessionId))
      if (!opts.tools) throw new Error('CAR-E-HOST: tool 面未装配（mcp-serve 未登记插件工具——tool_list/tool_call 不可用）')
      const id = `host-tc-${++s.hostToolSeq}`
      s.log.append('user', 'toolCall', 'T0', { id, tool: String(tool), args: toolArgs ?? {} })
      const def = opts.tools.get(String(tool))
      if (!def) {
        s.log.append('plugin', 'toolResult', 'T0', { id, error: `unknown tool "${tool}"` })
        return { ok: false, error: `unknown tool "${tool}"（tool_list 查看已装配工具面）` }
      }
      const sideEffect = def.declaredSideEffect ?? 'write' // T-22 收口：未声明按最高约束
      if (sideEffect === 'write') {
        s.log.append('runtime', 'toolResult', 'T0', { id, error: 'authorization-denied', granted: false, mode: 'host-policy' })
        return { ok: false, error: 'CAR-E-HOST-AUTHZ: write 类工具经宿主面 policy 拒绝（mcp-serve 无人审回路——D-25 deny-by-default）' }
      }
      let result: unknown
      let toolError: string | undefined
      try { result = await def.run(toolArgs ?? {}) } catch (e) { toolError = String(e) }
      s.log.append('plugin', 'toolResult', 'T0', { id, result, ...(toolError ? { error: toolError } : {}) })
      return toolError !== undefined ? { ok: false, error: toolError } : { ok: true, result }
    },
  }
}
