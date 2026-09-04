/**
 * F5 · 最小 turn 级停止语义（ADR-001 实装）
 *
 * 口径（《系统设计》F5 / D4-D5 机制对照 / POC-3 I4）：
 *  - step 三结果：completed / max-tokens / null（null = 工具结果交回模型，非异常）
 *  - TurnEndReason 六值：completed / max-tokens / aborted / error / blocked / interrupted
 *    （aborted=运行期取消可清理；interrupted=进程消失后恢复层补记——不可混用，S1/S2 仅实装前者）
 *  - ADR-001：max-tokens 解析前收口（截断响应不解析工具调用，禁补全半截 JSON）；
 *    只读白名单可选补错重试（preset.maxTokens.retryReadOnly）；endReasonTrail 保守判定：
 *    turn 内任一 step 撞限 → turn/end 保留 max-tokens，不被后续成功 step 冲销
 *  - 工具收口：concludesTurn=OR（任一 true 即收口）；terminate=AND（整批 finalized 全 true 才中断）
 *  - 取消：未派发调用补记成对事件（toolCall + 合成错误 toolResult），日志无缺口
 */
import type { SessionLog } from '../session/log.ts'

export type StepOutcome = 'completed' | 'max-tokens' | 'null'
export type TurnEndReason = 'completed' | 'max-tokens' | 'aborted' | 'error' | 'blocked' | 'interrupted'
export type SideEffect = 'readonly' | 'write'

export interface ToolCall { id: string; tool: string; args: Record<string, unknown> }
export interface ToolDef {
  declaredSideEffect: SideEffect
  concludesTurn?: boolean
  terminate?: boolean
  run(args: Record<string, unknown>): Promise<unknown>
}
/** 模型单步响应（provider 形态；stopReason 为不可变透传——ADR-001） */
export interface ModelStep {
  text?: string
  stopReason: 'stop' | 'length' | 'toolUse' | 'error'
  /** 仅 stopReason=toolUse 时有意义；length 时 provider 可能给半截信息（CAR 不解析其 args） */
  toolCalls?: ToolCall[]
  /** length 时 provider 给出的「截断工具调用」：只有名字，args 不可信 */
  truncatedTools?: Array<{ id: string; tool: string }>
}

export interface TurnPreset {
  /** ADR-001：只读白名单补错重试开关（默认关） */
  maxTokensRetryReadOnly?: boolean
  /** 权限模式（F4 集成点）：confirm 下写操作需审批回调放行 */
  mode?: 'readonly' | 'confirm' | 'full'
  /** 确认模式审批回调：返回 true 放行 */
  authorize?: (call: ToolCall) => Promise<boolean>
  maxSteps?: number
}

export interface TurnResult { reason: TurnEndReason; steps: number; endReasonTrail: Array<{ seq: number; reason: TurnEndReason }> }

export class TurnAborted extends Error {
  constructor() { super('CAR-ABORTED: turn cancelled by user') }
}

export async function runTurn(opts: {
  log: SessionLog
  turnId: string
  model: () => Promise<ModelStep>
  tools: Map<string, ToolDef>
  preset?: TurnPreset
  signal?: { aborted: boolean }
}): Promise<TurnResult> {
  const { log, turnId, model, tools, preset = {}, signal } = opts
  const maxSteps = preset.maxSteps ?? 32
  const trail: Array<{ seq: number; reason: TurnEndReason }> = []
  let sawMaxTokens = false
  let steps = 0

  const executeBatch = async (calls: ToolCall[]): Promise<{ concludesTurn: boolean; terminateAll: boolean; allFinalized: boolean }> => {
    let concludesTurn = false
    let terminateVotes = 0
    let finalized = 0
    for (const call of calls) {
      if (signal?.aborted) {
        // 取消：未派发调用补记成对事件（日志无缺口）
        log.append('runtime', 'toolCall', turnId, call)
        log.append('runtime', 'toolResult', turnId, { id: call.id, error: 'aborted-before-dispatch' })
        continue
      }
      const def = tools.get(call.tool)
      log.append('model', 'toolCall', turnId, call)
      if (!def) {
        log.append('plugin', 'toolResult', turnId, { id: call.id, error: `unknown tool "${call.tool}"` })
        continue
      }
      // 权限门（F4 集成点）：write 类在 readonly/confirm 模式需放行
      if (def.declaredSideEffect === 'write' && preset.mode !== 'full') {
        const granted = preset.mode === 'confirm' ? await (preset.authorize?.(call) ?? Promise.resolve(false)) : false
        log.append('runtime', 'toolResult', turnId, { id: call.id, error: 'authorization-denied', granted, mode: preset.mode })
        if (!granted) continue
      }
      const result = await def.run(call.args)
      log.append('plugin', 'toolResult', turnId, { id: call.id, result })
      finalized++
      if (def.concludesTurn) concludesTurn = true   // OR 收口
      if (def.terminate) terminateVotes++
    }
    return { concludesTurn, terminateAll: finalized > 0 && terminateVotes === finalized, allFinalized: finalized > 0 }
  }

  try {
    while (steps < maxSteps) {
      if (signal?.aborted) {
        const seq = log.append('runtime', 'turnEnd', turnId, null, { reason: 'aborted' }).seq
        trail.push({ seq, reason: 'aborted' })
        return { reason: 'aborted', steps, endReasonTrail: trail }
      }
      steps++
      log.snapshotModelRequest() // agent-loop 集成点：请求时快照（N1）
      const step = await model()

      if (step.stopReason === 'error') {
        const seq = log.append('runtime', 'turnEnd', turnId, null, { reason: 'error' }).seq
        trail.push({ seq, reason: 'error' })
        return { reason: 'error', steps, endReasonTrail: trail }
      }

      // ===== ADR-001：解析前收口 =====
      if (step.stopReason === 'length') {
        sawMaxTokens = true
        const readonlyRetry = preset.maxTokensRetryReadOnly === true
        const trunc = step.truncatedTools ?? []
        const retryable = readonlyRetry && trunc.every(t => tools.get(t.tool)?.declaredSideEffect === 'readonly')
        if (retryable && trunc.length) {
          // Pi 式补错重试：只读白名单工具收到「参数可能被截断」错误结果，交回模型下轮
          for (const t of trunc) {
            log.append('runtime', 'toolCall', turnId, { id: t.id, tool: t.tool, args: {}, truncated: true })
            log.append('runtime', 'toolResult', turnId, { id: t.id, error: 'arguments may be truncated (max-tokens)' })
          }
          continue
        }
        // 默认收口：截断响应不解析、不执行任何工具调用
        const seq = log.append('runtime', 'turnEnd', turnId, null, { reason: 'max-tokens' }).seq
        trail.push({ seq, reason: 'max-tokens' })
        return { reason: 'max-tokens', steps, endReasonTrail: trail }
      }

      if (step.stopReason === 'toolUse' && step.toolCalls?.length) {
        const batch = await executeBatch(step.toolCalls)
        if (batch.terminateAll) { // AND：整批全部 finalized 且全部 terminate
          const seq = log.append('runtime', 'turnEnd', turnId, null, { reason: 'aborted' }).seq
          trail.push({ seq, reason: 'aborted' })
          return { reason: 'aborted', steps, endReasonTrail: trail }
        }
        if (batch.concludesTurn) { // OR：任一工具发现全局收口条件
          const reason: TurnEndReason = sawMaxTokens ? 'max-tokens' : 'completed'
          const seq = log.append('runtime', 'turnEnd', turnId, null, { reason }).seq
          trail.push({ seq, reason })
          return { reason, steps, endReasonTrail: trail }
        }
        // null：工具结果交回模型，继续下一 step（非异常）
        continue
      }

      // stopReason === 'stop'：模型自然完成
      const reason: TurnEndReason = sawMaxTokens ? 'max-tokens' : 'completed'
      const seq = log.append('runtime', 'turnEnd', turnId, null, { reason }).seq
      trail.push({ seq, reason })
      return { reason, steps, endReasonTrail: trail }
    }
    const seq = log.append('runtime', 'turnEnd', turnId, null, { reason: 'error', detail: 'max-steps' }).seq
    trail.push({ seq, reason: 'error' })
    return { reason: 'error', steps, endReasonTrail: trail }
  } catch (e) {
    if (e instanceof TurnAborted) {
      const seq = log.append('runtime', 'turnEnd', turnId, null, { reason: 'aborted' }).seq
      trail.push({ seq, reason: 'aborted' })
      return { reason: 'aborted', steps, endReasonTrail: trail }
    }
    const seq = log.append('runtime', 'turnEnd', turnId, null, { reason: 'error', detail: String(e) }).seq
    trail.push({ seq, reason: 'error' })
    return { reason: 'error', steps, endReasonTrail: trail }
  }
}
