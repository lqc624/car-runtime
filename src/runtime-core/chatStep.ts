/**
 * M8 · SQ-07 模型接入集成（chat → 流式消费 → assistant 落 M7 → ModelStep 交 M4 状态机）
 *
 * 时序对齐（§3.2.M8.4 SQ-07 逐行）：
 *  1. 请求前断言：assertModelVisibleLogged（配合 M7，N1 不变量前置）；
 *  2. 请求消息 = log.deriveMessages() 投影——Model-visible means logged 由构造保证
 *     （本层不引入任何未落链的模型可见输入：新增可见输入必须新增事件类型，§3.5.5 红线；
 *     system prompt 组装属 M4/M2 职责，v1 不在本层旁路）；
 *  3. 凭据解析在适配器内（resolve→reveal，A080001 在首块前抛出 → runTurn catch → turn error，
 *     用户文案引导 car doctor）；
 *  4. 流式消费：delta 过 StreamRedactor（跨 chunk 命中不泄漏）+ toolCallDelta 聚合
 *     （半截 JSON 不解析——ADR-001 同纪律，length 时只交 truncatedTools）；
 *  5. assistant 文本事件落 M7（脱敏后 + secretsRedacted 计数留痕 meta）；
 *  6. finishReason 不可变透传为 ModelStep.stopReason（error/aborted → 'error'，BD-04 收口
 *     由 runTurn 落 turnEnd）；工具调用事件由 runTurn executeBatch 落（本层不重复）。
 */
import type { SessionLog } from '../session/log.ts'
import type { ModelStep, ToolCall } from '../loop/stop.ts'
import type { RuntimeCore } from './llm.ts'
import type { ToolDefinition } from './types.ts'
import { StreamRedactor } from './redaction.ts'
import { scanSecrets } from '../security/secrets.ts'
import { providerUnreachable } from './errors.ts'

export interface ChatStepOptions {
  core: RuntimeCore
  log: SessionLog
  turnId: string
  /** 模型名（provider 侧路由） */
  model: string
  /** 工具声明面（ToolDefinition 含 declaredSideEffect；不出站权限面仅 schema） */
  tools: ToolDefinition[]
  maxTokens?: number
  adapterId?: string
}

/** ModelStep 加法扩展：脱敏计数留痕（S15 secretsRedacted 同名口径） */
export type ChatStepResult = ModelStep & { secretsRedacted: number }

export async function chatStep(opts: ChatStepOptions): Promise<ChatStepResult> {
  const { core, log, turnId, model, tools, maxTokens, adapterId } = opts

  // 1. 请求前断言（SQ-07 #2）：N1 失守 = 带病请求，显式拒绝
  const asserted = log.assertModelVisibleLogged()
  if (!asserted.ok) {
    throw new Error(`CAR-E-N1: 模型请求前快照与日志投影失配 @ atSeq=${asserted.failedAt}（Model-visible means logged 违规）`)
  }

  // 2. 请求消息 = 投影（角色系统：user/assistant/toolResult 与 LlmRequest 对齐；
  //    assistant 工具调用以 { toolCall } content 形态原样透传——deriveMessages 投影即模型可见流）
  const messages = log.deriveMessages().map(m => ({
    role: m.role as 'user' | 'assistant' | 'toolResult',
    content: m.content,
  }))

  // 4. 流式消费（3. 凭据解析在适配器首块前，A080001 由此传播）
  const redactor = new StreamRedactor()
  let text = ''
  const calls = new Map<number, { id?: string; name?: string; argsBuf: string }>()
  let stopReason: ModelStep['stopReason'] | undefined
  let errorDetail: string | undefined

  const stream = core.chat({
    model,
    messages,
    tools,
    ...(maxTokens != null ? { maxTokens } : {}),
    ...(adapterId ? { adapterId } : {}),
    ...(opts.log.sessionId ? { metadata: { sessionId: opts.log.sessionId, turnId, traceId: `${opts.log.sessionId}:${turnId}` } } : {}),
  })
  for await (const chunk of stream) {
    if (chunk.delta !== undefined) text += redactor.push(chunk.delta)
    if (chunk.toolCallDelta) {
      const idx = chunk.toolCallDelta.index ?? 0
      const cur = calls.get(idx) ?? { argsBuf: '' }
      if (chunk.toolCallDelta.id) cur.id = chunk.toolCallDelta.id
      if (chunk.toolCallDelta.name) cur.name = chunk.toolCallDelta.name
      if (chunk.toolCallDelta.argumentsDelta) cur.argsBuf += chunk.toolCallDelta.argumentsDelta
      calls.set(idx, cur)
    }
    if (chunk.error) errorDetail = chunk.error.message
    if (chunk.finishReason !== undefined) stopReason = chunk.finishReason === 'aborted' ? 'error' : chunk.finishReason
  }
  if (stopReason === undefined) {
    // 适配器层已保证首 finishReason（AL-05）；防御性兜底显式化
    throw new Error('CAR-E-LLM-FINISH: 流结束无 finishReason（适配器契约违规）')
  }
  text += redactor.flush()

  // 5. assistant 文本落 M7（脱敏后 + 计数留痕；空文本不产事件）
  //    flush 后兜底复扫只计数不复写：流式遮蔽已生效，>0 即流式边界逃逸的审计信号
  let secretsRedacted = 0
  if (text.length) {
    secretsRedacted = scanSecrets(text).hits.length
    log.append('model', 'assistant', turnId, text, { secretsRedacted })
  }

  // 6. finishReason → ModelStep（不可变透传；length 不解析 args——ADR-001 解析前收口）
  if (stopReason === 'length') {
    const truncated = [...calls.values()].filter(c => c.id || c.name).map(c => ({ id: c.id ?? `tc-${c.name ?? 'unknown'}`, tool: c.name ?? 'unknown' }))
    return { stopReason: 'length', ...(text ? { text } : {}), truncatedTools: truncated, secretsRedacted }
  }
  if (stopReason === 'toolUse') {
    const toolCalls: ToolCall[] = []
    for (const [idx, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.name) continue
      let args: Record<string, unknown>
      try { args = c.argsBuf ? JSON.parse(c.argsBuf) as Record<string, unknown> : {} } catch {
        // toolUse 声明下 args 非法 JSON = 协议违规显式化（非 length 场景无 truncatedTools 口径）
        throw new Error(`CAR-E-LLM-PROTO: 工具调用 ${c.name} 参数非法 JSON（finishReason=${stopReason}，${errorDetail ?? '无附加错误'}）`)
      }
      toolCalls.push({ id: c.id ?? `tc-${idx}-${c.name}`, tool: c.name, args })
    }
    return { stopReason: 'toolUse', ...(text ? { text } : {}), ...(toolCalls.length ? { toolCalls } : {}), secretsRedacted }
  }
  // error（含 aborted 映射）：以 B080001 抛出 → runTurn catch → turnEnd error 携带 detail（BD-04 收口）
  if (stopReason === 'error') {
    throw providerUnreachable(errorDetail ?? 'provider 返回 error 终止（无附加说明）')
  }
  return { stopReason: 'stop', ...(text ? { text } : {}), secretsRedacted }
}
