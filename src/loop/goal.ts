/**
 * F13 · Goal 层（五层停止第五层）：phase 持久化 + activation 进程内
 *
 * 口径（dsh goal/goal/src/types.ts:45,75,87-89 源码级已核实 + M2 系统设计增补 T-1）：
 *  - GoalPhase = active | paused | blocked | complete —— 持久化：经会话日志 goalUpdate 事件
 *  - GoalActivation = armed | disarmed —— 进程内、never persisted：
 *    新实例默认 disarmed = 「session-start 重置 disarmed」零分支天然满足（AC-4.5）
 *  - update_goal(complete) 不立刻掐断 turn：先写持久状态，turn 由既有收口逻辑完成（D5 §9）
 *  - blocked 产出点：授权门 blockOnDeny / 策略门（stop.ts 集成）
 */
import type { SessionLog, SessionEvent } from '../session/log.ts'

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'
export type GoalActivation = 'armed' | 'disarmed'

export class GoalDriver {
  #log: SessionLog
  #phase: GoalPhase = 'active'
  #activation: GoalActivation = 'disarmed' // 重启/新实例默认 disarmed（不会把历史任务叫醒）
  #disarmReasons: string[] = []

  constructor(log: SessionLog) { this.#log = log }

  get phase(): GoalPhase { return this.#phase }
  get activation(): GoalActivation { return this.#activation }

  /** 持久状态变更：写 goalUpdate 事件（重启后由恢复层读取重放） */
  setPhase(phase: GoalPhase, reason: string): void {
    this.#phase = phase
    this.#log.append('runtime', 'goalUpdate', 'GOAL', { phase, reason })
  }

  /** 进程内激活（不持久化——重启后默认 disarmed） */
  arm(): void { this.#activation = 'armed' }
  disarm(reason: string): void {
    this.#activation = 'disarmed'
    this.#disarmReasons.push(reason)
  }

  /** 超限/撞限/错误自动 disarm（D5 §9：Round 超限、max-tokens、Agent error 都会 disarm） */
  autoDisarmOnTurnEnd(reason: string): void {
    if (reason !== 'completed') this.disarm(`turn ended with ${reason}`)
  }

  /** 恢复层：从已落盘日志重放 goalUpdate 重建 phase（activation 不恢复——保持 disarmed） */
  static replay(events: readonly SessionEvent[]): { phase: GoalPhase; activation: GoalActivation } {
    let phase: GoalPhase = 'active'
    for (const e of events) {
      if (e.kind === 'goalUpdate' && (e.payload as any)?.phase) phase = (e.payload as any).phase
    }
    return { phase, activation: 'disarmed' } // activation 永不持久化
  }
}
