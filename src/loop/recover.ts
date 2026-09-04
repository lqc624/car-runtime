/**
 * F13 · 恢复层：interrupted 补记（进程消失后恢复层给未闭合 turn 补状态）
 *
 * 口径（D4 §18 / D5 §19）：
 *  - interrupted = 进程消失后恢复层补记，与 aborted（运行期取消可清理）不可混用
 *  - 未配对 toolCall 补合成错误 toolResult（日志无缺口红线）
 *  - 副作用审计：补记事件带 recovered=true 标记（副作用是否落地由恢复层显式声明为未知）
 */
import type { SessionLog, SessionEvent } from '../session/log.ts'

export interface RecoveryReport {
  /** 补记 interrupted 的 turn 数 */
  turnsClosed: number
  /** 补记合成 toolResult 的未配对调用数 */
  pairedCalls: number
}

/** 扫描日志中未闭合的 turn（有 turnStart 语义的用户事件但没有 turnEnd）与未配对 toolCall */
export function recoverInterrupted(log: SessionLog): RecoveryReport {
  const report: RecoveryReport = { turnsClosed: 0, pairedCalls: 0 }
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  const openTurns = new Set<string>()
  const closedTurns = new Set<string>()
  for (const e of log.events) {
    if (e.kind === 'toolCall') callIds.add((e.payload as any).id)
    if (e.kind === 'toolResult') resultIds.add((e.payload as any).id)
    if (e.kind === 'user') openTurns.add(e.turnId)
    if (e.kind === 'turnEnd') { closedTurns.add(e.turnId); openTurns.delete(e.turnId) }
  }
  // 未配对 toolCall → 合成错误 toolResult（副作用状态未知：recovered=true 显式声明）
  for (const e of log.events) {
    if (e.kind !== 'toolCall') continue
    const id = (e.payload as any).id
    if (resultIds.has(id)) continue
    if (closedTurns.has(e.turnId)) continue // 已闭合 turn 内成对由原逻辑保证
    log.append('runtime', 'toolResult', e.turnId, { id, error: 'recovered: process interrupted before dispatch result', recovered: true })
    resultIds.add(id)
    report.pairedCalls++
  }
  // 未闭合 turn → 补记 turnEnd=interrupted（不可与 aborted 混用）
  for (const turnId of openTurns) {
    log.append('runtime', 'turnEnd', turnId, null, { reason: 'interrupted', recovered: true })
    report.turnsClosed++
  }
  return report
}
