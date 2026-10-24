/**
 * 1.14-S2 · 历史压缩面（K-MP-2 / D-40）——策略器 + 执行器 + 确定性摘要
 *
 * 口径（红线先立后码）：
 *  - **append-only 红线**：压缩 = 追加一条 'compact' 事件（payload 携带摘要 + 折叠前缀边界
 *    compactedUpTo），**不改写 / 不删除任何已落链事件**——SessionLog 无 update/delete API，
 *    压缩只走 append；node:test 断言压缩前后 verifyChain() 均 null 且旧事件逐字节不变；
 *  - **投影语义**：compact 只影响其后请求的投影（deriveMessages last-wins），压缩前快照
 *    （atSeq ≤ compact.seq）投影仍为全量形态——N1 不变量（Model-visible means logged）
 *    逐快照自洽，无需豁免；
 *  - **保护段**：首个 system 事件（会话级提示）+ 最近 N turn（protectLastTurns，缺省 4）
 *    不进折叠区间；中途 system 事件按普通事件折叠（内容保留进摘要，信息不丢——D-40 执行期细化）；
 *  - **工具对完整性（toolPairIntegrity）**：折叠边界若落在 toolCall↔toolResult 配对中间
 *    （call 在区间内、result 在保护段）→ 边界回退到该 toolCall（成对整体移出），循环至不动点；
 *  - **fail-visible**：无可压缩区间（全部在保护段 / 已压缩过）→ CAR-E-COMPACT-NORANGE 显式报错，
 *    禁静默成功；摘要生成产物非非空字符串 → CAR-E-COMPACT-SUMMARY 显式报错；
 *  - **零新依赖**：摘要缺省为确定性生成器（轮次意图 + 工具调用统计 + 收口状态——事实拼装，
 *    禁估算）；宿主可注入 LLM 摘要（summarize 缝——内核不依赖 LLM 做压缩）；
 *  - **触发面**：shouldCompact 判定（thresholdEvents 事实计数 + thresholdTokens provider 报告
 *    事实——两维度均禁 tokenizer 估算）+ applyCompaction 立即 API；自动挂载点在宿主装配层
 *    （runTurn 之间调用，内核不改 runTurn 语义）。
 */
import type { SessionEvent, SessionLog } from './log.ts'

export interface CompactionConfig {
  /** 缺省 false = 行为零变化（1.13 兼容线） */
  enabled?: boolean
  /** 距上次压缩以来的新增事件数阈值（事实计数，非 token 估算）；缺省 200 */
  thresholdEvents?: number
  /**
   * 1.18-K5（D-51）：token 维度阈值——事实源 = 链上最近一条 'usage' 事件（provider 报告，
   * 禁 tokenizer 估算）的 input + cacheRead + cacheCreation 之和（两族归一化后统一口径
   * = 最近一次请求的全上下文：openai prompt_tokens 含 cached 已减法归一、anthropic
   * input_tokens 天然不含 cache——types.ts §1.1）。与 thresholdEvents **任一命中即触发**（OR）。
   * 缺省缺席 = 行为零变化；≤ 0 不生效。补的缺口：真实使用若长期 10~30 轮，事件阈值
   * 永不触及而上下文持续增长到撞 provider 上限（设计 §10.4-2 附带发现）。
   * 子链甄别（实核消解）：K2 子 Agent 子链为独立 SessionLog，其 usage 事件只落子链
   * （汇总走 system kind 防双计）——主链日志内 'usage' 事件必然全部来自主链请求，无污染。
   */
  thresholdTokens?: number
  /** 保护最近 N 个 turn 不折叠；缺省 4 */
  protectLastTurns?: number
}

export interface CompactionPlan {
  /** 折叠前缀边界 [0, compactedUpTo)——compact 事件 payload 原样携带 */
  compactedUpTo: number
  /** 折叠区间覆盖的 turn 数（去重） */
  compactedTurns: number
  /** 折叠区间事件引用（供摘要生成；只读） */
  events: readonly SessionEvent[]
}

/** 上次压缩边界（无 compact 事件 = 0）——重复压缩不越界（幂等区间的下界） */
function lastCompactedUpTo(log: SessionLog): number {
  let last = 0
  for (const e of log.events) {
    if (e.kind !== 'compact') continue
    const p = (e.payload ?? {}) as { compactedUpTo?: unknown }
    if (typeof p.compactedUpTo === 'number' && p.compactedUpTo > last) last = p.compactedUpTo
  }
  return last
}

/**
 * shouldCompact：事件阈值 OR token 阈值任一命中（enabled 缺省关 = 零变化）。
 * 事件维度 = 距上次压缩的新增事件数 ≥ thresholdEvents；
 * token 维度（D-51）= 最近一条 usage 事实的全上下文（input+cacheRead+cacheCreation）
 * ≥ thresholdTokens——无 usage（首轮前）不触发；非数值字段容错按 0（stop.ts 聚合同纪律）。
 */
export function shouldCompact(log: SessionLog, cfg: CompactionConfig | undefined): boolean {
  if (!cfg || cfg.enabled !== true) return false
  const threshold = cfg.thresholdEvents ?? 200
  if (log.events.length - lastCompactedUpTo(log) >= threshold) return true
  const thresholdTokens = cfg.thresholdTokens
  if (typeof thresholdTokens === 'number' && thresholdTokens > 0) {
    for (let i = log.events.length - 1; i >= 0; i--) {
      const e = log.events[i]!
      if (e.kind !== 'usage') continue
      const p = (e.payload ?? {}) as { input?: unknown; cacheRead?: unknown; cacheCreation?: unknown }
      const num = (v: unknown) => (typeof v === 'number' ? v : 0)
      return num(p.input) + num(p.cacheRead) + num(p.cacheCreation) >= thresholdTokens
    }
  }
  return false
}

/**
 * planCompaction：计算折叠区间（纯函数，不落链）。
 * 保护段 = 首个 system 事件 + 最近 protectLastTurns 个 turn（按 turnId 首次出现序）；
 * 边界回退保证 toolCall↔toolResult 成对（toolPairIntegrity）；无可压缩区间显式报错。
 */
export function planCompaction(log: SessionLog, protectLastTurns = 4): CompactionPlan {
  const events = log.events
  const floor = lastCompactedUpTo(log) // 上界不越过上次压缩边界（幂等）

  // 保护起点候选：最近 N 个 turn 的首事件 seq
  const turnFirst = new Map<string, number>()
  for (const e of events) {
    if (e.turnId === 'compaction') continue // 压缩事件自身不构成 turn
    if (!turnFirst.has(e.turnId)) turnFirst.set(e.turnId, e.seq)
  }
  const recentTurns = [...turnFirst.entries()].slice(-protectLastTurns)
  let protectStart = recentTurns.length ? Math.min(...recentTurns.map(([, seq]) => seq)) : events.length

  // 统一规则：折叠区间 = [lowerBound, protectStart)，lowerBound = max(上次压缩边界, 首个 system.seq + 1)
  // ——首个 system（会话级提示）恒不被折叠；floor 已含它时（上次压缩边界在其后）不受限
  const firstSystem = events.find(e => e.kind === 'system')
  const lowerBound = firstSystem ? Math.max(floor, firstSystem.seq + 1) : floor
  if (protectStart <= lowerBound) {
    throw new Error(`CAR-E-COMPACT-NORANGE: 无可压缩区间（保护段 = 首个 system + 最近 ${protectLastTurns} turn，上次压缩边界 = ${floor}）——禁静默成功`)
  }

  // toolPairIntegrity：边界落在配对中间 → 回退到 toolCall（成对整体移出），循环至不动点
  for (let guard = 0; guard < 1000; guard++) {
    const callIds = new Map<string, number>() // id → call seq（区间内）
    for (let i = lowerBound; i < protectStart; i++) {
      const e = events[i]!
      if (e.kind === 'toolCall') {
        const id = (e.payload as { id?: unknown } | null)?.id
        if (typeof id === 'string') callIds.set(id, e.seq)
      }
    }
    let earliestCallSeq: number | undefined
    for (let i = protectStart; i < events.length; i++) {
      const e = events[i]!
      if (e.kind !== 'toolResult') continue
      const id = (e.payload as { id?: unknown } | null)?.id
      if (typeof id === 'string' && callIds.has(id)) {
        const callSeq = callIds.get(id)!
        if (earliestCallSeq === undefined || callSeq < earliestCallSeq) earliestCallSeq = callSeq
      }
    }
    if (earliestCallSeq === undefined) break // 无破裂配对——边界成立
    protectStart = earliestCallSeq // 成对整体移出
    if (protectStart <= lowerBound) {
      throw new Error(`CAR-E-COMPACT-NORANGE: 工具对回退后无区间（toolCall↔toolResult 成对完整性不可满足）——禁静默成功`)
    }
  }

  const compacted = events.slice(lowerBound, protectStart)
  const turns = new Set(compacted.map(e => e.turnId))
  return { compactedUpTo: protectStart, compactedTurns: turns.size, events: compacted }
}

/** 确定性摘要（缺省生成器）：事实拼装（轮次意图 + 工具统计 + 收口状态），禁估算禁 LLM 依赖 */
export function defaultSummarizer(events: readonly SessionEvent[]): string {
  const cut = (v: unknown, n: number) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > n ? s.slice(0, n) + '…' : s
  }
  const lines: string[] = [`[会话压缩摘要] 折叠事件 ${events.length} 条（${events[0]?.seq ?? 0}–${events.at(-1)?.seq ?? 0}）：`]
  const toolCounts = new Map<string, number>()
  const endReasons = new Map<string, number>()
  for (const e of events) {
    if (e.kind === 'user') lines.push(`- [${e.turnId}] 用户：${cut(e.payload, 200)}`)
    else if (e.kind === 'assistant' && typeof e.payload === 'string' && e.payload.trim()) lines.push(`- [${e.turnId}] 助手：${cut(e.payload, 160)}`)
    else if (e.kind === 'toolCall') {
      const p = e.payload as { tool?: unknown }
      const name = typeof p?.tool === 'string' ? p.tool : '?'
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    } else if (e.kind === 'turnEnd') {
      const r = (e.meta as { reason?: unknown } | null)?.reason
      const key = typeof r === 'string' ? r : 'unknown'
      endReasons.set(key, (endReasons.get(key) ?? 0) + 1)
    }
  }
  if (toolCounts.size) {
    lines.push(`工具调用：${[...toolCounts.entries()].map(([t, n]) => `${t} ×${n}`).join('、')}`)
  }
  if (endReasons.size) {
    lines.push(`turn 收口：${[...endReasons.entries()].map(([r, n]) => `${r} ×${n}`).join('、')}`)
  }
  return lines.join('\n')
}

/**
 * applyCompaction：执行压缩（唯一落链动作 = append 一条 'compact' 事件——原事件链不改写）。
 * summarize 缝：宿主可注入 LLM 摘要（返回非空字符串；缺省确定性生成器）。
 */
export function applyCompaction(
  log: SessionLog,
  opts: { protectLastTurns?: number; turnId?: string; summarize?: (events: readonly SessionEvent[]) => string } = {},
): SessionEvent {
  const plan = planCompaction(log, opts.protectLastTurns ?? 4)
  const summary = opts.summarize ? opts.summarize(plan.events) : defaultSummarizer(plan.events)
  if (typeof summary !== 'string' || !summary.trim().length) {
    throw new Error(`CAR-E-COMPACT-SUMMARY: 摘要生成产物为空（fail-visible，禁静默折叠空摘要）`)
  }
  return log.append('runtime', 'compact', opts.turnId ?? 'compaction', {
    summary,
    compactedUpTo: plan.compactedUpTo,
    compactedTurns: plan.compactedTurns,
    compactedEvents: plan.events.length,
  })
}
