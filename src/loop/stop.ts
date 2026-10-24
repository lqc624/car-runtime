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
 *  - 1.11-S2（D-33 / 计量设计 §3.3）：turnEnd meta.usage = 本 turn usage 事件四分量求和
 *    （聚合在内核消费侧单点 closeTurn——适配器无状态 ACL；无 usage 事件 → meta 不带 usage 键，
 *    缺省=未采集向后兼容；撞限/异常 turn 照常聚合，截断前已完成请求的 usage 事实不吞）
 */
import type { SessionLog } from '../session/log.ts'
import { CarM8Error } from '../runtime-core/errors.ts'

export type StepOutcome = 'completed' | 'max-tokens' | 'null'
export type TurnEndReason = 'completed' | 'max-tokens' | 'aborted' | 'error' | 'blocked' | 'interrupted'
export type SideEffect = 'readonly' | 'write'

export interface ToolCall { id: string; tool: string; args: Record<string, unknown> }
export interface ToolDef {
  declaredSideEffect: SideEffect
  concludesTurn?: boolean
  terminate?: boolean
  run(args: Record<string, unknown>): Promise<unknown>
  // —— 1.4-S1 声明面加法（进模型 ToolDefinition；执行面与声明面同一对象——声明面=授权面红线）——
  description?: string
  parameters?: unknown
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
  /**
   * 1.13.0（K-FS-1）：authorizeAll=true 将 confirm 模式的授权门扩展到 readonly 类工具
   * （文件安全规则轴的读取面——读取的询问/拒绝规则可达）；缺省 false = 既有行为零变化
   * （readonly 模式契约不变：写类一律拒、只读类照常放行；full 整体旁路）。
   */
  authorizeAll?: boolean
  maxSteps?: number
  /** F13：OR/AND 收口可配置（默认 any/all = M1 行为等价） */
  aggregate?: { concludesTurn?: 'any' | 'all'; terminate?: 'any' | 'all' }
  /** F13：授权拒绝即收口 blocked（默认 false = 模型继续调整）；1.17-K4（V2-a）缺省随档位收敛——readonly 恒 true（显式传参可覆盖） */
  blockOnDeny?: boolean
  /**
   * 1.17-K4（D-50 / G8）：拒绝累计熔断——同 turn denies 累计 ≥ N 即收口 blocked（gate:'denyBreaker'）。
   * 缺省 3（预防性闸门：真实样本从未超过 1 次/turn——设计 §10.4-3 诚实定位）；0 = 关。
   */
  denyBreaker?: number
  /**
   * 1.17-K4（D-50 / G9）：重复失败熔断——失败签名（tool + 归一化错误串）同 turn 连续 ≥ N 后，
   * 下一次同签名不再派发（成对补记 no-dispatch 事件）并收口 blocked（gate:'repeatFailureBreaker'）。
   * 异签名放行（允许探索，禁撞墙）；成功派发重置连击。缺省 2；0 = 关。
   */
  repeatFailureBreaker?: number
}

export interface TurnResult { reason: TurnEndReason; steps: number; endReasonTrail: Array<{ seq: number; reason: TurnEndReason }> }

export class TurnAborted extends Error {
  constructor() { super('CAR-ABORTED: turn cancelled by user') }
}

/**
 * 1.11-S2（D-33 / 计量设计 §3.3）：turn 级 usage 聚合——扫描本 turn 的 'usage' 事件（事实本体
 * 在 JSONL，聚合由事实行求和而非运行时状态；字段非数值容错跳过不吞计数）。无 usage 事件
 * 返回 undefined → turnEnd meta 不带 usage 键（缺省=未采集，旧格式向后兼容）。
 */
function turnUsageFrom(log: SessionLog, turnId: string): { input: number; output: number; cacheRead: number; cacheCreation: number; requests: number; segments?: { reasoningTokens: number } } | undefined {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreation = 0
  let requests = 0
  let reasoning: number | undefined
  for (const e of log.events) {
    if (e.kind !== 'usage' || e.turnId !== turnId) continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (typeof p.input === 'number') input += p.input
    if (typeof p.output === 'number') output += p.output
    if (typeof p.cacheRead === 'number') cacheRead += p.cacheRead
    if (typeof p.cacheCreation === 'number') cacheCreation += p.cacheCreation
    // 1.14-S3（K-MP-2b / D-41）：分段聚合——任一请求携带 segments.reasoningTokens 即求和；
    // 全 turn 无分段事实 = meta.usage 不带 segments 键（禁估算补造）
    const seg = (p.segments ?? null) as { reasoningTokens?: unknown } | null
    if (seg && typeof seg.reasoningTokens === 'number') reasoning = (reasoning ?? 0) + seg.reasoningTokens
    requests++
  }
  if (!requests) return undefined
  return { input, output, cacheRead, cacheCreation, requests, ...(reasoning !== undefined ? { segments: { reasoningTokens: reasoning } } : {}) }
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

  // 1.11-S2（D-33）：turnEnd 落链单点包装——聚合本 turn usage 事件（无 usage 不带键，
  // 缺省=未采集向后兼容）；reason 保持 meta 首键，usage 恒为加法尾键
  const closeTurn = (meta: Record<string, unknown>) => {
    const usage = turnUsageFrom(log, turnId)
    return log.append('runtime', 'turnEnd', turnId, null, { ...meta, ...(usage ? { usage } : {}) })
  }

  // 1.17-K4（D-50 / V2-a）：blockOnDeny 缺省随档位收敛——readonly 恒 true（拒绝即收口，禁在
  // 错误理解模式的路上烧 token；「看一眼再决定」应切 confirm——三档设计本义）；confirm/full
  // 缺省 false 不变；显式传参可覆盖任何档位
  const blockOnDeny = preset.blockOnDeny ?? preset.mode === 'readonly'
  // 1.17-K4（D-50）：G8/G9 熔断阈值（缺省 3/2；0 = 关——A/B 与回退通道）
  const denyBreaker = preset.denyBreaker ?? 3
  const repeatFailureBreaker = preset.repeatFailureBreaker ?? 2
  let totalDenies = 0
  // G9 失败签名连击（turn 级）：成功派发重置；授权拒绝不重置（拒绝 ≠ 探索进展）
  let lastSignature: string | null = null
  let lastFailureTool: string | null = null
  let signatureStreak = 0
  /** 失败签名 = tool + 归一化错误串（去空白/时间戳/长 hex id、截断 200——确定性好比对） */
  const failureSignature = (tool: string, err: string) =>
    (tool + ':' + err.replace(/\s+/g, ' ').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>').replace(/\b[0-9a-f]{8,}\b/g, '<id>')).slice(0, 200)
  const advanceStreak = (tool: string, err: string) => {
    const sig = failureSignature(tool, err)
    if (sig === lastSignature) signatureStreak++
    else { lastSignature = sig; signatureStreak = 1 }
    lastFailureTool = tool
  }

  const executeBatch = async (calls: ToolCall[]): Promise<{ concludesTurn: boolean; concludesAll: boolean; terminateVotes: number; terminateAll: boolean; finalized: number; denies: number; breakerTripped: string | null }> => {
    let concludesTurn = false
    let concludesVotes = 0
    let terminateVotes = 0
    let finalized = 0
    let denies = 0
    let breakerTripped: string | null = null
    for (const call of calls) {
      if (signal?.aborted) {
        // 取消：未派发调用补记成对事件（日志无缺口）
        log.append('runtime', 'toolCall', turnId, call)
        log.append('runtime', 'toolResult', turnId, { id: call.id, error: 'aborted-before-dispatch' })
        continue
      }
      const def = tools.get(call.tool)
      log.append('model', 'toolCall', turnId, call)
      // G9（D-50）熔断预检：同签名连击已达阈值且本次同工具 → 不再派发（错误串须派发方知，
      // 预检口径 = 同工具紧邻重试——换工具探索不受影响；换参数异错误的甄别发生在 streak < 阈值期）。
      // 未派发也成对落链（与取消补记同纪律——日志无缺口），breakerTripped 交主循环收口。
      // 位置在 def 查找前：unknown tool 连击（def 缺失分支 continue）同样要被拦
      if (repeatFailureBreaker > 0 && signatureStreak >= repeatFailureBreaker && lastFailureTool === call.tool) {
        log.append('runtime', 'toolResult', turnId, {
          id: call.id,
          error: 'repeated-identical-failure: breaker tripped (no dispatch)',
          signature: lastSignature,
        })
        breakerTripped = lastSignature
        continue
      }
      if (!def) {
        log.append('plugin', 'toolResult', turnId, { id: call.id, error: `unknown tool "${call.tool}"` })
        // G9：unknown tool 同为失败面（模型反复叫错工具名 = 撞墙形态之一）
        advanceStreak(call.tool, `unknown tool "${call.tool}"`)
        continue
      }
      // 权限门（F4 集成点）：write 类在 readonly/confirm 模式需放行；1.13.0（K-FS-1）：
      // authorizeAll=true 且 confirm 时 readonly 类同门（规则轴读取面），readonly 模式契约不变
      const gated = preset.mode !== 'full' &&
        (def.declaredSideEffect === 'write' || (preset.authorizeAll === true && preset.mode === 'confirm'))
      if (gated) {
        const granted = preset.mode === 'confirm' ? await (preset.authorize?.(call) ?? Promise.resolve(false)) : false
        log.append('runtime', 'toolResult', turnId, { id: call.id, error: 'authorization-denied', granted, mode: preset.mode })
        if (!granted) { denies++; continue }
      }
      // 工具错误 = 成对 toolResult 交回模型（US-5/D5 语义：工具错误是结果而非 turn 中断——
      // 与取消补记成对事件同纪律；turn 级 error 仅保留给模型请求/协议层失败）
      let result: unknown
      let toolError: string | undefined
      try {
        result = await def.run(call.args)
      } catch (e) {
        result = undefined
        toolError = String(e)
      }
      log.append('plugin', 'toolResult', turnId, { id: call.id, result, ...(toolError ? { error: toolError } : {}) })
      // G9 连击推进：同签名 streak++，异签名重开（允许探索——换参数后不同错误 = 不同签名）；
      // 成功派发重置（拒绝不重置——拒绝 ≠ 探索进展）
      if (toolError) advanceStreak(call.tool, toolError)
      else { lastSignature = null; lastFailureTool = null; signatureStreak = 0 }
      finalized++
      if (def.concludesTurn) { concludesTurn = true; concludesVotes++ }
      if (def.terminate) terminateVotes++
    }
    return {
      concludesTurn, concludesAll: finalized > 0 && concludesVotes === finalized,
      terminateVotes, terminateAll: finalized > 0 && terminateVotes === finalized,
      finalized, denies, breakerTripped,
    }
  }

  try {
    while (steps < maxSteps) {
      if (signal?.aborted) {
        const seq = closeTurn({ reason: 'aborted' }).seq
        trail.push({ seq, reason: 'aborted' })
        return { reason: 'aborted', steps, endReasonTrail: trail }
      }
      steps++
      // 1.15-S2（K-STEER-1 / D-47）：快照带活跃 turn 口径——与请求投影（chatStep 内
      // activeTurnId 过滤）同构，N1 逐快照自洽；无引导事件时与 1.14.1 逐字节一致
      log.snapshotModelRequest({ activeTurnId: turnId }) // agent-loop 集成点：请求时快照（N1）
      const step = await model()

      if (step.stopReason === 'error') {
        const seq = closeTurn({ reason: 'error' }).seq
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
        const seq = closeTurn({ reason: 'max-tokens' }).seq
        trail.push({ seq, reason: 'max-tokens' })
        return { reason: 'max-tokens', steps, endReasonTrail: trail }
      }

      if (step.stopReason === 'toolUse' && step.toolCalls?.length) {
        const batch = await executeBatch(step.toolCalls)
        totalDenies += batch.denies
        // F13：授权拒绝即收口（blockOnDeny 产出点——blocked 仅新增产出点，枚举不增）；
        // 1.17-K4（V2-a）：blockOnDeny 缺省随档位（readonly 恒 true）——G6 单次拒绝即收口，
        // 开则 G8 无机会触发（设计 §5.4 共存口径）
        if (blockOnDeny && batch.denies > 0) {
          const seq = closeTurn({ reason: 'blocked', denies: batch.denies }).seq
          trail.push({ seq, reason: 'blocked' })
          return { reason: 'blocked', steps, endReasonTrail: trail }
        }
        // G8（D-50）：拒绝累计熔断——同 turn denies 累计 ≥ 阈值收口 blocked（止损优先于
        // conclude/terminate 判定；denies 为 turn 级累计跨 batch）
        if (denyBreaker > 0 && totalDenies >= denyBreaker) {
          const seq = closeTurn({ reason: 'blocked', denies: totalDenies, gate: 'denyBreaker' }).seq
          trail.push({ seq, reason: 'blocked' })
          return { reason: 'blocked', steps, endReasonTrail: trail }
        }
        // G9（D-50）：重复失败熔断——executeBatch 已补记 no-dispatch 成对事件，此处收口
        if (batch.breakerTripped) {
          const seq = closeTurn({ reason: 'blocked', gate: 'repeatFailureBreaker', signature: batch.breakerTripped }).seq
          trail.push({ seq, reason: 'blocked' })
          return { reason: 'blocked', steps, endReasonTrail: trail }
        }
        const agg = preset.aggregate ?? {}
        const abortedNow = (agg.terminate ?? 'all') === 'any' ? batch.terminateVotes > 0 : batch.terminateAll
        if (abortedNow) { // terminate 收口：默认 AND（整批），可配置 any
          const seq = closeTurn({ reason: 'aborted' }).seq
          trail.push({ seq, reason: 'aborted' })
          return { reason: 'aborted', steps, endReasonTrail: trail }
        }
        const concludedNow = (agg.concludesTurn ?? 'any') === 'any' ? batch.concludesTurn : batch.concludesAll && batch.finalized > 0
        if (concludedNow) { // concludesTurn 收口：默认 OR，可配置 all
          const reason: TurnEndReason = sawMaxTokens ? 'max-tokens' : 'completed'
          const seq = closeTurn({ reason }).seq
          trail.push({ seq, reason })
          return { reason, steps, endReasonTrail: trail }
        }
        // null：工具结果交回模型，继续下一 step（非异常）
        continue
      }

      // stopReason === 'stop'：模型自然完成
      const reason: TurnEndReason = sawMaxTokens ? 'max-tokens' : 'completed'
      const seq = closeTurn({ reason }).seq
      trail.push({ seq, reason })
      return { reason, steps, endReasonTrail: trail }
    }
    const seq = closeTurn({ reason: 'error', detail: 'max-steps' }).seq
    trail.push({ seq, reason: 'error' })
    return { reason: 'error', steps, endReasonTrail: trail }
  } catch (e) {
    if (e instanceof TurnAborted) {
      const seq = closeTurn({ reason: 'aborted' }).seq
      trail.push({ seq, reason: 'aborted' })
      return { reason: 'aborted', steps, endReasonTrail: trail }
    }
    // 1.4-S4：CarM8Error 保形——code/userHint/retryable 进 turnEnd（A080001 引导文案「请运行
    // car doctor」可达用户；非 CarM8Error 维持 String(e) 口径不变）
    const m8 = e instanceof CarM8Error
    const detail = m8 ? `${e.slug}: ${e.message}` : String(e)
    const seq = closeTurn({
      reason: 'error', detail,
      ...(m8 ? { code: e.code, userHint: e.userHint, retryable: e.retryable } : {}),
    }).seq
    trail.push({ seq, reason: 'error' })
    return { reason: 'error', steps, endReasonTrail: trail }
  }
}
