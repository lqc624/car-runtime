/**
 * 1.6-S1 · 投影收敛（S37）：deriveMessages 同 id toolResult last-wins（D-23）
 *
 * 覆盖：
 *  - runTurn confirm 全链：写类工具 granted 流——事件面两条 toolResult（runtime 授权 + plugin 执行，
 *    M4 既有语义不动 = 审计全量留痕），投影单条且内容 = 执行结果；N1 快照一致性由构造保持
 *  - denied 流：授权拒绝单条保留（唯一结果，原样投影）
 *  - readonly 工具：单 plugin toolResult（无收敛对象——回归）
 *  - id 缺席不收敛：无 id 载荷原样投影（golden ④ 投影语义兼容）；id 与无 id 混存互不影响
 *  - 适配器出站体（1.6-GO-5 生产调用点核查）：收敛投影经 openai-compat / anthropic 双适配器
 *    出站体无重复 tool 消息 / tool_result 块（真实 provider 重复 id 拒绝面出清）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { runTurn, type ModelStep } from '../src/loop/stop.ts'
import { createOpenAICompatAdapter, createAnthropicAdapter } from '../src/runtime-core/llm.ts'

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const openaiSse = (finish: string) =>
  dataLine({ choices: [{ delta: {}, finish_reason: finish }] }) + 'data: [DONE]\n\n'
const sseResponse = (text: string) => {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text)); c.close() } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const anthropicSse = (events: object[]) => events.map(dataLine).join('')
const ANTHROPIC_STOP = [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]

/** chatStep 消息映射同款复刻（deriveMessages → LlmRequest.messages 的唯一路径） */
function toLlmMessages(log: SessionLog) {
  return log.deriveMessages().map(m => ({
    role: m.role as 'system' | 'user' | 'assistant' | 'toolResult',
    content: (m as unknown as { toolCall?: unknown }).toolCall !== undefined
      ? { toolCall: (m as unknown as { toolCall: unknown }).toolCall }
      : m.content,
  }))
}

test('S37: 写类工具 granted 流——事件面两条 toolResult（M4 语义不动），投影单条且为执行结果 + N1 一致', async () => {
  const log = new SessionLog('s37-granted')
  const steps: ModelStep[] = [
    { stopReason: 'toolUse', toolCalls: [{ id: 'tc1', tool: 'save_note', args: { text: 'hi' } }] },
    { stopReason: 'stop' },
  ]
  const r = await runTurn({
    log, turnId: 'T1',
    model: async () => steps.shift()!,
    tools: new Map([['save_note', { declaredSideEffect: 'write', run: async () => '已保存' }]]),
    preset: { mode: 'confirm', authorize: async () => true },
  })
  assert.equal(r.reason, 'completed')
  // 事件面不动：授权决策（runtime）+ 执行结果（plugin）两条都落链（审计全量留痕）
  const resultEvents = log.events.filter(e => e.kind === 'toolResult')
  assert.equal(resultEvents.length, 2, 'M4 既有语义冻结：runtime 授权记录 + plugin 执行结果均落链')
  assert.equal(resultEvents[0]!.actor, 'runtime')
  assert.equal(resultEvents[1]!.actor, 'plugin')
  // 投影收敛：同 id last-wins，模型可见流单条且为执行结果
  const proj = log.deriveMessages().filter(m => m.role === 'toolResult')
  assert.equal(proj.length, 1, 'D-23：授权中间记录不再进模型可见流')
  assert.deepEqual(proj[0]!.content, { id: 'tc1', result: '已保存' })
  // N1 快照一致性（runTurn 每步 snapshotModelRequest；收敛激活下重算同函数构造一致）
  assert.deepEqual(log.assertModelVisibleLogged(), { ok: true })
})

test('S37: denied 流——授权拒绝单条保留（唯一结果原样投影）', async () => {
  const log = new SessionLog('s37-denied')
  const steps: ModelStep[] = [
    { stopReason: 'toolUse', toolCalls: [{ id: 'tc2', tool: 'save_note', args: {} } ] },
    { stopReason: 'stop' },
  ]
  await runTurn({
    log, turnId: 'T1',
    model: async () => steps.shift()!,
    tools: new Map([['save_note', { declaredSideEffect: 'write', run: async () => '不应执行' }]]),
    preset: { mode: 'confirm', authorize: async () => false },
  })
  assert.equal(log.events.filter(e => e.kind === 'toolResult').length, 1, '拒绝即终态：仅 runtime 授权拒绝事件')
  const proj = log.deriveMessages().filter(m => m.role === 'toolResult')
  assert.equal(proj.length, 1, '唯一结果原样保留（不误收敛）')
  assert.equal((proj[0]!.content as { error?: string }).error, 'authorization-denied')
})

test('S37: readonly 工具单条 toolResult 无收敛对象（回归）', async () => {
  const log = new SessionLog('s37-readonly')
  const steps: ModelStep[] = [
    { stopReason: 'toolUse', toolCalls: [{ id: 'tc3', tool: 'echo', args: {} }] },
    { stopReason: 'stop' },
  ]
  await runTurn({
    log, turnId: 'T1',
    model: async () => steps.shift()!,
    tools: new Map([['echo', { declaredSideEffect: 'readonly', run: async () => 'pong' }]]),
    preset: { mode: 'readonly' },
  })
  assert.equal(log.events.filter(e => e.kind === 'toolResult').length, 1)
  const proj = log.deriveMessages().filter(m => m.role === 'toolResult')
  assert.equal(proj.length, 1)
  assert.deepEqual(proj[0]!.content, { id: 'tc3', result: 'pong' })
})

test('S37: id 缺席不收敛——无 id 载荷原样投影（golden ④ 兼容），id 与无 id 混存互不影响', () => {
  const log = new SessionLog('s37-idless')
  log.append('runtime', 'toolResult', 'T1', { ok: 1 })
  log.append('runtime', 'toolResult', 'T1', { ok: 2 })
  log.append('plugin', 'toolResult', 'T1', { id: 'tc9', error: 'authorization-denied', granted: true })
  log.append('plugin', 'toolResult', 'T1', { id: 'tc9', result: 'final' })
  const proj = log.deriveMessages().filter(m => m.role === 'toolResult')
  assert.equal(proj.length, 3, '无 id 两条原样保留 + 同 id 收敛为最后一条')
  assert.deepEqual(proj[0]!.content, { ok: 1 })
  assert.deepEqual(proj[1]!.content, { ok: 2 })
  assert.deepEqual(proj[2]!.content, { id: 'tc9', result: 'final' })
  // 前缀投影（upTo）语义：前缀内 last-wins 独立成立
  const half = log.deriveMessages(3).filter(m => m.role === 'toolResult')
  assert.equal(half.length, 3, '前缀 [0,3)：无 id 两条 + tc9 授权记录（前缀内 tc9 授权记录即终态）')
  assert.deepEqual(half[2]!.content, { id: 'tc9', error: 'authorization-denied', granted: true })
})

test('S37: openai-compat 出站体——收敛后单 tool 消息（重复 tool_call_id 出清）', async () => {
  const log = new SessionLog('s37-openai')
  log.append('user', 'user', 'T1', '查天气')
  log.append('model', 'toolCall', 'T1', { id: 'tc1', tool: 'weather', args: { city: '北京' } })
  log.append('runtime', 'toolResult', 'T1', { id: 'tc1', error: 'authorization-denied', granted: true, mode: 'confirm' })
  log.append('plugin', 'toolResult', 'T1', { id: 'tc1', result: '晴 25 度' })
  const seen: RequestInit[] = []
  const adapter = createOpenAICompatAdapter({
    baseUrl: 'https://api.test',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { seen.push(init!); return sseResponse(openaiSse('stop')) }) as typeof fetch,
  })
  for await (const _ of adapter.chat({ model: 'm', messages: toLlmMessages(log), tools: [] })) void _
  const body = JSON.parse(seen[0]!.body as string)
  const toolMsgs = body.messages.filter((m: { role: string }) => m.role === 'tool')
  assert.equal(toolMsgs.length, 1, '1.6-GO-5：出站体单 tool 消息（收敛前为两条）')
  assert.equal(toolMsgs[0].tool_call_id, 'tc1')
  assert.equal(toolMsgs[0].content, JSON.stringify('晴 25 度'), '内容 = 执行结果（非授权中间记录）')
})

test('S37: anthropic 出站体——收敛后单 tool_result 块（重复 tool_use_id 400 面出清）', async () => {
  const log = new SessionLog('s37-anthropic')
  log.append('user', 'user', 'T1', '查天气')
  log.append('model', 'toolCall', 'T1', { id: 'toolu_1', tool: 'weather', args: { city: '北京' } })
  log.append('runtime', 'toolResult', 'T1', { id: 'toolu_1', error: 'authorization-denied', granted: true, mode: 'confirm' })
  log.append('plugin', 'toolResult', 'T1', { id: 'toolu_1', result: '晴 25 度' })
  const seen: RequestInit[] = []
  const adapter = createAnthropicAdapter({
    baseUrl: 'https://api.test',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { seen.push(init!); return sseResponse(anthropicSse(ANTHROPIC_STOP)) }) as typeof fetch,
  })
  for await (const _ of adapter.chat({ model: 'm', messages: toLlmMessages(log), tools: [] })) void _
  const body = JSON.parse(seen[0]!.body as string)
  const blocks = body.messages.flatMap((m: { content: unknown }) =>
    Array.isArray(m.content) ? m.content : []).filter((b: { type: string }) => b.type === 'tool_result')
  assert.equal(blocks.length, 1, '1.6-GO-5：出站体单 tool_result 块（重复 tool_use_id 会被 provider 400）')
  assert.equal(blocks[0].tool_use_id, 'toolu_1')
  assert.equal(blocks[0].content, JSON.stringify('晴 25 度'))
  assert.ok(!('is_error' in blocks[0]), '执行结果非错误形态')
})
