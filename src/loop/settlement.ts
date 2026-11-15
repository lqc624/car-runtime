/**
 * 1.24-W2 · 回合结算回执（settlement receipt）
 *
 * 口径（《Qwen-Code 对照分析》§2.3/§5 / 借鉴四篇裁决记录 Q-W2 / 迭代规划 D-W2-1~6）：
 *  - 「结算必留回执」：任何 turn 无论成败都有一张结构化凭据——观测 / 恢复 / 审计消费同一张
 *  - 落链形态 = kind:'system' + payload.type:'settlement'（EventKind 零新增；payload.type 扩展
 *    沿 routing 'decide' / memory 'write|edit|delete|rollback' 先例）；一 turn 一张，llm 面与
 *    tool 节合并（D-W2-1）
 *  - 产出点仅两处：runTurn closeTurn（turnEnd 之前——turnEnd 保持终止标记语义）与
 *    recoverInterrupted 补记（部分链对账）；authz 台账 turnEnd 与 facade sessionStop 不经
 *    closeTurn、不触发（D-W2-2 登记）
 *  - 事实源 = 链（非运行时状态）：两本账按链上 toolCall/toolResult payload.id 对账；
 *    permissionDenialCount = toolResult error:'authorization-denied' 且 granted===false；
 *    hasUnknownOutcomes = 无配对 toolResult 或配对结果 recovered:true（副作用状态未知显式记账）；
 *    bounded = aborted-before-dispatch 补记形态在链（取消落在派发边界，未打断在途执行）
 *  - 字段 CAR 化：outcome 由 reason 映射（complete|interrupted|failed）；failureKind = 1.23
 *    meta.kind 诚实缺键；assistantSeq 代 Qwen assistantMessageUuid；Qwen nextMaxOutputTokens
 *    在 CAR 无对应机制 → 诚实缺键不预埋（D-W2-3 偏差登记）
 *  - turnEnd meta 零变化：settlement 是独立事件非 meta 尾键（D-W2-4，s78-16 字节兼容锚不动）；
 *    stopRequested 经 closeTurn hints 传递不落 meta
 *  - kill-switch：CAR_SETTLEMENT=off 跳过 append（K1 env 逐 turn 求值先例）；缺省开（D-W2-5）
 *  - 链量纪律（R-W2）：定长小 payload——账本数组 cap 64 + truncated 标记；内容类信息不进链
 */
import type { SessionLog } from '../session/log.ts'

export type SettlementOutcome = 'complete' | 'interrupted' | 'failed'

/** 账本数组上限（超出截断 + ledgerTruncated 标记——防病态长 turn 链量失控） */
export const SETTLEMENT_LEDGER_CAP = 64

export interface SettlementHints {
  /** terminate 型收口（工具主动 stop 语义，stop.ts closeTurn hints——不落 turnEnd meta） */
  stopRequested?: boolean
}

/** TurnEndReason → settlement outcome 映射（completed/max-tokens=complete；aborted/interrupted=interrupted；error/blocked=failed） */
export function outcomeFromReason(reason: string): SettlementOutcome {
  if (reason === 'completed' || reason === 'max-tokens') return 'complete'
  if (reason === 'aborted' || reason === 'interrupted') return 'interrupted'
  return 'failed'
}

/**
 * 结算回执落链（closeTurn / recover 共用单点）。meta = 同 turn turnEnd 将携带的 meta
 * （reason/kind 等事实同源）；usage/hints 缺省时从链自证（requestSent 由 usage 事件或
 * assistant 在场推导）。
 */
export function appendSettlement(
  log: SessionLog,
  turnId: string,
  meta: Record<string, unknown>,
  hints?: SettlementHints,
): void {
  if (process.env.CAR_SETTLEMENT === 'off') return
  const reason = typeof meta.reason === 'string' ? meta.reason : 'error'
  const kind = typeof meta.kind === 'string' ? meta.kind : undefined

  // 单次链扫描：两本账 + 拒绝计数 + unknown/bounded 事实 + requestSent 事实 + assistantSeq
  const declared: string[] = []
  const resultById = new Map<string, Record<string, unknown>>()
  let denialCount = 0
  let bounded = false
  let usageRequests = 0
  let assistantSeq: number | undefined
  for (const e of log.events) {
    if (e.turnId !== turnId) continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (e.kind === 'toolCall') {
      if (typeof p.id === 'string') declared.push(p.id)
    } else if (e.kind === 'toolResult') {
      if (typeof p.id === 'string') {
        resultById.set(p.id, p) // 1.6-S1 last-wins 同款口径
        if (p.error === 'authorization-denied' && p.granted === false) denialCount++
        if (p.error === 'aborted-before-dispatch') bounded = true
      }
    } else if (e.kind === 'usage') {
      usageRequests++
    } else if (e.kind === 'assistant') {
      assistantSeq = e.seq
    }
  }
  const dispatched = [...resultById.keys()]
  const unknownIds = declared.filter((id) => {
    const res = resultById.get(id)
    return !res || res.recovered === true
  })
  const cap = (arr: string[]) => (arr.length > SETTLEMENT_LEDGER_CAP ? arr.slice(0, SETTLEMENT_LEDGER_CAP) : arr)
  const ledgerTruncated = declared.length > SETTLEMENT_LEDGER_CAP || dispatched.length > SETTLEMENT_LEDGER_CAP

  log.append('runtime', 'system', turnId, {
    type: 'settlement',
    outcome: outcomeFromReason(reason),
    ...(kind ? { failureKind: kind } : {}),
    requestSent: usageRequests > 0 || assistantSeq !== undefined,
    ...(assistantSeq !== undefined ? { assistantSeq } : {}),
    declaredToolUseIds: cap(declared),
    dispatchedToolUseIds: cap(dispatched),
    ...(ledgerTruncated ? { ledgerTruncated: true } : {}),
    tool: {
      permissionDenialCount: denialCount,
      hasUnknownOutcomes: unknownIds.length > 0,
      ...(unknownIds.length ? { unknownToolUseIds: cap(unknownIds) } : {}),
      stopRequested: hints?.stopRequested === true,
      bounded,
    },
  })
}
