/**
 * 1.22 · thinking 完形批（S72~S77）
 *
 * 覆盖（《内核1.22-thinking完形批-迭代规划.md》§5）：
 *  - s72：openai 形捕获——delta.reasoning_content → thinkingDelta chunk（复用 1.21 字段，
 *    chatStep 零改动）；纯 content 流零 thinking chunk；reasoning+content 共存事件双键
 *  - s73：多块捕获落链——双 thinking 块 → 两事件（签名随块独立不再拼接、blockIndex 块序）；
 *    redacted 独立块（原「后块覆盖前块」缺陷消除）；单块链 meta 无 blockIndex = 1.21.1 逐字节同形
 *  - s74：投影——单块三元组（1.21 形态 deepEqual）/ 多块 blocks 数组（顶层 text 键缺席）；
 *    首 toolCall 消费即清；user 隔断清空
 *  - s75：toAnthropic 双形态消费——单块 1.21.1 形态不变；多块按序展开前置（redacted 混合保真）；
 *    无 thinking = 1.20 形态
 *  - s76：onDelta.thinkingDelta——掩蔽流（密钥原文零泄漏，链侧禁改写不变）；之和 + flush
 *    ≡ 掩蔽(payload)；缺省零行为变化；textDelta/toolName 红线回归
 *  - s77：E2E——多块 enforce 假网关（续轮须回传双 thinking 块，缺/少 → 400 tokenhub 同文；
 *    全 → 200 两轮全通）；openai reasoning_content 假网关落链 E2E
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  createAnthropicAdapter,
  createOpenAICompatAdapter,
  RuntimeCore,
  type LlmAdapter,
  type LlmChunk,
  type LlmRequest,
} from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'
import { SessionLog } from '../src/session/log.ts'
import { Context } from '../src/kernel/context.ts'

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of it) out.push(c)
  return out
}

function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(text)); c.close() },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (events: object[]) => events.map(dataLine).join('')
const openaiSse = (events: object[]) => events.map(dataLine).join('') + 'data: [DONE]\n\n'

const TEXT_EVENTS = (text: string): object[] => [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]

/** 1.22 多块流：N 个 thinking 块（各带独立签名）+ 可选 text/tool_use（官方 interleaved 内容形态，非 enforce 契约建模） */
const MULTI_BLOCK_EVENTS = (opts: {
  blocks: Array<{ text: string; signature?: string } | { redacted: string }>
  text?: string
  toolUse?: { id: string; name: string; args: string }
}): object[] => {
  const out: object[] = [{ type: 'message_start', message: { role: 'assistant' } }]
  let idx = 0
  for (const b of opts.blocks) {
    if ('redacted' in b) {
      out.push({ type: 'content_block_start', index: idx, content_block: { type: 'redacted_thinking', data: b.redacted } })
    } else {
      out.push(
        { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: b.text } },
        ...(b.signature ? [{ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: b.signature } }] : []),
      )
    }
    out.push({ type: 'content_block_stop', index: idx })
    idx++
  }
  if (opts.text) {
    out.push(
      { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: opts.text } },
      { type: 'content_block_stop', index: idx },
    )
    idx++
  }
  if (opts.toolUse) {
    out.push(
      { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name } },
      { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: opts.toolUse.args } },
      { type: 'content_block_stop', index: idx },
    )
    idx++
  }
  out.push({ type: 'message_delta', delta: { stop_reason: opts.toolUse ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' })
  return out
}

function anthropicCoreWith(events: object[]): RuntimeCore {
  const cred = new CredentialService({ keychainReader: () => null })
  const core = new RuntimeCore(cred)
  core.bindContext(new Context())
  core.registerLlmAdapter(
    createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl: (async () => sseResponse(anthropicSse(events))) as typeof fetch }),
    { default: true },
  )
  return core
}

function fakeAdapter(id: string, script: Array<LlmChunk[]>): LlmAdapter {
  let call = 0
  return {
    id,
    async *chat(_req: LlmRequest) {
      yield* script[Math.min(call, script.length - 1)]!
      call++
    },
  }
}

const fakeCoreWith = (id: string, script: Array<LlmChunk[]>) => {
  const core = new RuntimeCore()
  core.registerLlmAdapter(fakeAdapter(id, script))
  return core
}

// ==================== s72：openai 形捕获（D-A2） ====================

test('S72: openai SSE——delta.reasoning_content → thinkingDelta；共存事件双键；纯 content 流零 thinking chunk', async () => {
  const mk = (events: object[]) =>
    createOpenAICompatAdapter({ baseUrl: 'https://api.test/v1', fetchImpl: (async () => sseResponse(openaiSse(events))) as typeof fetch })

  // 思考流先于正文（DeepSeek reasoner 顺序形态）
  const stream = await drain(mk([
    { choices: [{ delta: { reasoning_content: '先想' } }] },
    { choices: [{ delta: { reasoning_content: '一步' } }] },
    { choices: [{ delta: { content: '正文' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as LlmChunk[]
  const thinkingJoined = stream.filter(c => c.thinkingDelta !== undefined).map(c => c.thinkingDelta).join('')
  assert.equal(thinkingJoined, '先想一步', 'reasoning_content 增量捕获（1.21 同款字段，chatStep 零改动）')
  assert.ok(stream.some(c => c.delta === '正文'), 'content 正常放行')
  assert.equal(stream.at(-1)!.finishReason, 'stop', '终态不受捕获影响')

  // 共存事件（网关单事件双键形态）：thinking + text 同 chunk 顺序展开
  const coexist = await drain(mk([
    { choices: [{ delta: { reasoning_content: 'R', content: 'T' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as LlmChunk[]
  assert.ok(coexist.some(c => c.thinkingDelta === 'R' && c.delta === 'T'), '共存事件双键同 chunk')

  // 纯 content 流零 thinking chunk（既有形态不变）
  const plain = await drain(mk([
    { choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as LlmChunk[]
  assert.ok(plain.every(c => c.thinkingDelta === undefined), '纯 content 流零 thinking chunk')
})

// ==================== s73：多块捕获落链（D-B1） ====================

test('S73: 多块落链——双 thinking 块两事件（签名随块独立/blockIndex 块序）；单块链 meta 无 blockIndex（1.21.1 同形）', async () => {
  // 双块：签名不再跨块拼接（1.21 单累加器会把 s1+s2 拼成损坏签名——缺陷修复实证）
  const core = anthropicCoreWith(MULTI_BLOCK_EVENTS({ blocks: [{ text: '块一', signature: 'sig-1=' }, { text: '块二', signature: 'sig-2=' }] }))
  const log = new SessionLog('S-s73')
  log.append('user', 'user', 'T1', 'x')
  await chatStep({ core, log, turnId: 'T1', model: 'm', tools: [] })

  const ths = log.events.filter(e => e.kind === 'thinking')
  assert.equal(ths.length, 2, '一块一事件（D-B1）')
  assert.deepEqual(ths.map(e => e.payload), ['块一', '块二'], 'payload = 各块原文（禁改写）')
  assert.deepEqual(ths.map(e => e.meta?.signature), ['sig-1=', 'sig-2='], '签名随块独立（不再拼接）')
  assert.deepEqual(ths.map(e => e.meta?.blockIndex), [0, 1], '多块链 blockIndex 块序')
  assert.equal(log.assertModelVisibleLogged().ok, true, 'N1 快照自洽')

  // 单块回归：meta 无 blockIndex = 1.21.1 逐字节同形（兼容线）
  const core1 = anthropicCoreWith(MULTI_BLOCK_EVENTS({ blocks: [{ text: '单块', signature: 'sg=' }], text: '正文' }))
  const log1 = new SessionLog('S-s73-single')
  log1.append('user', 'user', 'T1', 'x')
  await chatStep({ core: core1, log: log1, turnId: 'T1', model: 'm', tools: [] })
  const th1 = log1.events.find(e => e.kind === 'thinking')!
  assert.equal(th1.payload, '单块')
  assert.deepEqual(th1.meta, { signature: 'sg=' }, '单块 meta 与 1.21.1 同形（无 blockIndex）')

  // redacted 独立块：前文本块不被覆盖（原缺陷：后块 data 覆盖前块 text）
  const core2 = anthropicCoreWith(MULTI_BLOCK_EVENTS({ blocks: [{ text: '前块', signature: 'sg-a=' }, { redacted: 'R-DATA' }] }))
  const log2 = new SessionLog('S-s73-redacted')
  log2.append('user', 'user', 'T1', 'x')
  await chatStep({ core: core2, log: log2, turnId: 'T1', model: 'm', tools: [] })
  const ths2 = log2.events.filter(e => e.kind === 'thinking')
  assert.equal(ths2.length, 2, 'redacted 封为独立块')
  assert.equal(ths2[0]!.payload, '前块')
  assert.deepEqual(ths2[0]!.meta, { signature: 'sg-a=', blockIndex: 0 })
  assert.equal(ths2[1]!.payload, 'R-DATA')
  assert.equal(ths2[1]!.meta?.redacted, true, 'redacted meta 保真')

  // redacted 单块：无 blockIndex + meta.redacted（1.21 同形回归）
  const core3 = anthropicCoreWith(MULTI_BLOCK_EVENTS({ blocks: [{ redacted: 'R-ONLY' }] }))
  const log3 = new SessionLog('S-s73-redonly')
  log3.append('user', 'user', 'T1', 'x')
  await chatStep({ core: core3, log: log3, turnId: 'T1', model: 'm', tools: [] })
  const th3 = log3.events.find(e => e.kind === 'thinking')!
  assert.deepEqual(th3.meta, { redacted: true }, 'redacted 单块 1.21 同形（无 blockIndex）')
})

// ==================== s74：投影（D-B2） ====================

test('S74: 投影——单块三元组（1.21 形态 deepEqual）/ 多块 blocks 数组（顶层 text 缺席）；首 toolCall 消费即清', () => {
  // 多块链
  const logM = new SessionLog('S-s74-multi')
  logM.append('user', 'user', 'T1', 'q')
  logM.append('model', 'thinking', 'T1', '块一', { signature: 'sig-1=', blockIndex: 0 })
  logM.append('model', 'thinking', 'T1', '块二', { signature: 'sig-2=', blockIndex: 1 })
  logM.append('model', 'toolCall', 'T1', { id: 'tu-1', tool: 'f', args: {} })
  logM.append('model', 'toolCall', 'T1', { id: 'tu-2', tool: 'g', args: {} })
  const msgsM = logM.deriveMessages()
  const tc1 = msgsM.find(m => (m as { toolCall?: { id?: string } }).toolCall?.id === 'tu-1') as { thinking?: unknown }
  assert.deepEqual(tc1.thinking, {
    blocks: [{ text: '块一', signature: 'sig-1=' }, { text: '块二', signature: 'sig-2=' }],
  }, '多块 = blocks 数组（按序、签名保真）')
  assert.ok(tc1.thinking && !(tc1.thinking as { text?: unknown }).text, '多块顶层 text 键缺席（D-B2 形态判据）')
  const tc2 = msgsM.find(m => (m as { toolCall?: { id?: string } }).toolCall?.id === 'tu-2') as { thinking?: unknown }
  assert.equal(tc2.thinking, undefined, '首 toolCall 消费即清')

  // 单块链：三元组形态与 1.21 逐字节同形
  const log1 = new SessionLog('S-s74-single')
  log1.append('user', 'user', 'T1', 'q')
  log1.append('model', 'thinking', 'T1', '单块', { signature: 'sg=' })
  log1.append('model', 'toolCall', 'T1', { id: 'tu-3', tool: 'h', args: {} })
  const tc3 = log1.deriveMessages().find(m => (m as { toolCall?: { id?: string } }).toolCall?.id === 'tu-3') as { thinking?: unknown }
  assert.deepEqual(tc3.thinking, { text: '单块', signature: 'sg=' }, '单块三元组（1.21 形态，字节兼容线）')

  // user 隔断清空（多块后隔断 → 不投影）
  const logB = new SessionLog('S-s74-barrier')
  logB.append('user', 'user', 'T1', 'q')
  logB.append('model', 'thinking', 'T1', '块一', { blockIndex: 0 })
  logB.append('model', 'thinking', 'T1', '块二', { blockIndex: 1 })
  logB.append('user', 'user', 'T2', '打断')
  logB.append('model', 'toolCall', 'T2', { id: 'tu-4', tool: 'k', args: {} })
  const tc4 = logB.deriveMessages().find(m => (m as { toolCall?: { id?: string } }).toolCall?.id === 'tu-4') as { thinking?: unknown }
  assert.equal(tc4.thinking, undefined, '跨 turn + user 隔断不投影')
})

// ==================== s75：toAnthropic 双形态消费（D-B3） ====================

test('S75: toAnthropic——单块形态不变；多块按序展开前置（redacted 混合保真）；无 thinking = 1.20 形态', async () => {
  const seen: RequestInit[] = []
  const adapter = createAnthropicAdapter({
    baseUrl: 'https://api.test',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
      seen.push(init!)
      return sseResponse(anthropicSse(TEXT_EVENTS('done')))
    }) as typeof fetch,
  })
  const run = (messages: unknown[]) =>
    drain(adapter.chat({ model: 'm', messages: messages as never, tools: [] }))

  // 多块：双 thinking 块按序前置 + tool_use（各块独立签名）
  await run([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: { toolCall: { id: 'tu-1', tool: 'f', args: { a: 1 } }, thinking: { blocks: [{ text: '块一', signature: 'sig-1=' }, { text: '块二', signature: 'sig-2=' }] } } },
    { role: 'toolResult', content: { id: 'tu-1', result: 'r' } },
  ])
  assert.deepEqual(JSON.parse(seen[0]!.body as string).messages[1], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '块一', signature: 'sig-1=' },
      { type: 'thinking', thinking: '块二', signature: 'sig-2=' },
      { type: 'tool_use', id: 'tu-1', name: 'f', input: { a: 1 } },
    ],
  }, '多块按序展开前置（Anthropic content 数组多 thinking 块形态）')

  // redacted 混合块序保真
  await run([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: { toolCall: { id: 'tu-2', tool: 'g', args: {} }, thinking: { blocks: [{ text: 'R-DATA', redacted: true }, { text: '块二', signature: 'sg-2=' }] } } },
    { role: 'toolResult', content: { id: 'tu-2', result: 'r' } },
  ])
  assert.deepEqual(JSON.parse(seen[1]!.body as string).messages[1].content.slice(0, 2), [
    { type: 'redacted_thinking', data: 'R-DATA' },
    { type: 'thinking', thinking: '块二', signature: 'sg-2=' },
  ], 'redacted 混合块序保真')

  // 单块三元组：1.21.1 形态不变（回归）
  await run([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: { toolCall: { id: 'tu-3', tool: 'h', args: {} }, thinking: { text: '推理', signature: 'sg=' } } },
    { role: 'toolResult', content: { id: 'tu-3', result: 'r' } },
  ])
  assert.deepEqual(JSON.parse(seen[2]!.body as string).messages[1], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '推理', signature: 'sg=' },
      { type: 'tool_use', id: 'tu-3', name: 'h', input: {} },
    ],
  }, '单块形态与 1.21.1 逐字节一致')

  // 无 thinking：1.20 形态
  await run([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: { toolCall: { id: 'tu-4', tool: 'k', args: {} } } },
    { role: 'toolResult', content: { id: 'tu-4', result: 'r' } },
  ])
  assert.deepEqual(JSON.parse(seen[3]!.body as string).messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-4', name: 'k', input: {} }],
  }, '无 thinking = 1.20 形态（D-T5 兼容线）')
})

// ==================== s76：onDelta.thinkingDelta（D-C1/D-C2） ====================

type Delta = { textDelta?: string; toolName?: string; thinkingDelta?: string }

test('S76: thinkingDelta 掩蔽流——之和 + flush ≡ 落链 payload（无密钥恒等）；密钥原文零泄漏（链侧禁改写不变）', async () => {
  // 无密钥：流式之和 ≡ payload 之和（掩蔽恒等）
  const core = fakeCoreWith('fake-think', [[
    { thinkingBlockStart: 0 },
    { thinkingDelta: '思考第一段，' },
    { thinkingDelta: '第二段继续；' },
    { thinkingBlockStart: 1 },
    { thinkingDelta: '第二块。' },
    { finishReason: 'stop' },
  ]])
  const log = new SessionLog('S-s76')
  log.append('user', 'user', 'T1', 'hi')
  const seen: Delta[] = []
  await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], onDelta: (d) => seen.push(d) })
  const streamed = seen.map((d) => d.thinkingDelta ?? '').join('')
  const payloads = log.events.filter((e) => e.kind === 'thinking').map((e) => e.payload as string)
  assert.equal(streamed, payloads.join(''), 'thinkingDelta 之和 + flush ≡ 掩蔽(payload)（无密钥掩蔽恒等）')
  assert.equal(payloads.length, 2, '双块落链（跨块流式连续）')

  // 密钥：回调零原文泄漏（遮蔽生效）；链 payload 禁改写原文保真
  const credCanary = ['sk-live-', 'abc123def456', 'ghi789'].join('')
  const core2 = fakeCoreWith('fake-think-sec', [[
    { thinkingDelta: '密钥是 ' },
    { thinkingDelta: credCanary.slice(0, 10) },
    { thinkingDelta: credCanary.slice(10) + ' 请妥善保管。' },
    { finishReason: 'stop' },
  ]])
  const log2 = new SessionLog('S-s76-sec')
  log2.append('user', 'user', 'T1', 'hi')
  const seen2: Delta[] = []
  await chatStep({ core: core2, log: log2, turnId: 'T1', model: 'm1', tools: [], onDelta: (d) => seen2.push(d) })
  const streamed2 = seen2.map((d) => d.thinkingDelta ?? '').join('')
  assert.ok(!streamed2.includes(credCanary), '思考流式回调不含密钥原文（掩蔽流，D-C1）')
  const payload2 = log2.events.find((e) => e.kind === 'thinking')!.payload as string
  assert.equal(payload2, `密钥是 ${credCanary} 请妥善保管。`, '链侧 payload 禁改写（签名完整性 > 脱敏改写，D-T2 延续）')
  assert.equal(log2.events.find((e) => e.kind === 'thinking')!.meta?.secretsRedacted, 1, 'secretsRedacted 计数留痕')
})

test('S76: 缺省零行为变化 + textDelta/toolName 红线回归', async () => {
  const script: Array<LlmChunk[]> = [[
    { thinkingDelta: '想想' },
    { delta: '回答' },
    { toolCallDelta: { index: 0, id: 'tc1', name: 'fs_read', argumentsDelta: '{"p":1}' } },
    { finishReason: 'toolUse' },
  ]]
  const logA = new SessionLog('S-s76-off')
  logA.append('user', 'user', 'T1', 'hi')
  await chatStep({ core: fakeCoreWith('fake-x', script), log: logA, turnId: 'T1', model: 'm1', tools: [] })
  const logB = new SessionLog('S-s76-on')
  logB.append('user', 'user', 'T1', 'hi')
  const seen: Delta[] = []
  await chatStep({ core: fakeCoreWith('fake-x', script), log: logB, turnId: 'T1', model: 'm1', tools: [], onDelta: (d) => seen.push(d) })
  // 事件逐字段一致（剥 seq/ts/hash/prevHash 链易变字段——onDelta 为渲染提示面不落链）
  const strip = (es: Array<Record<string, unknown>>) => es.map(e => ({ actor: e.actor, kind: e.kind, turnId: e.turnId, payload: e.payload, meta: e.meta }))
  assert.deepEqual(strip(logA.events as never), strip(logB.events as never), 'onDelta 缺省/在场落链事件逐字段一致（渲染提示面零影响）')
  assert.ok(seen.some(d => d.thinkingDelta === '想想'), 'thinkingDelta 回调在场')
  assert.ok(seen.some(d => d.textDelta === '回答'), 'textDelta 回调不变')
  assert.ok(seen.some(d => d.toolName === 'fs_read'), 'toolName 回调不变')
})

// ==================== s77：E2E（多块 enforce 假网关 + openai 落链 E2E） ====================

test('S77: E2E 多块 enforce 假网关——续轮须回传双 thinking 块（缺/少 → 400 tokenhub 同文；全 → 200 全通）', async () => {
  const firstResponse = anthropicSse(MULTI_BLOCK_EVENTS({
    blocks: [{ text: '推理一', signature: 'sg-e2e-1=' }, { text: '推理二', signature: 'sg-e2e-2=' }],
    toolUse: { id: 'toolu_mb', name: 'echo_tool', args: '{"v":1}' },
  }))
  let sawMissing400 = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
      const hasToolResult = parsed.messages.some(m => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(b => b.type === 'tool_result'))
      if (hasToolResult) {
        // 多块 enforce 契约：续轮须回传首轮签发的两块（块数与签名逐一核对）
        const thBlocks = parsed.messages.flatMap(m => m.role === 'assistant' && Array.isArray(m.content)
          ? (m.content as Array<{ type?: string; thinking?: string; signature?: string }>).filter(b => b.type === 'thinking')
          : [])
        if (thBlocks.length < 2 || thBlocks[0]?.thinking !== '推理一' || thBlocks[1]?.thinking !== '推理二'
          || thBlocks[0]?.signature !== 'sg-e2e-1=' || thBlocks[1]?.signature !== 'sg-e2e-2=') {
          sawMissing400 = true
          res.writeHead(400, { 'content-type': 'application/json', connection: 'close' })
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'The `reasoning_content` in the thinking mode must be passed back to the API.' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
        res.end(anthropicSse(TEXT_EVENTS('全部完成')))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      res.end(firstResponse)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const cred = new CredentialService({ keychainReader: () => null })
    const core = new RuntimeCore(cred)
    core.bindContext(new Context())
    core.registerLlmAdapter(createAnthropicAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: ((url: string | URL, init?: RequestInit) => fetch(url, init)) as typeof fetch,
    }), { default: true })

    // 正向：两轮工具环全通（多块捕获 → 落链 → 投影 blocks → 合并重放双块前置）
    const log = new SessionLog('S-s77')
    log.append('user', 'user', 'T1', '帮我查')
    const r1 = await chatStep({ core, log, turnId: 'T1', model: 'm', tools: [{ name: 'echo_tool', description: 'x', parameters: { type: 'object' }, declaredSideEffect: 'readonly' }] })
    assert.equal(r1.stopReason, 'toolUse')
    log.append('model', 'toolCall', 'T1', r1.toolCalls![0]!)
    log.append('plugin', 'toolResult', 'T1', { id: r1.toolCalls![0]!.id, result: { ok: true } })
    log.append('user', 'user', 'T2', '继续')
    const r2 = await chatStep({ core, log, turnId: 'T2', model: 'm', tools: [] })
    assert.equal(r2.stopReason, 'stop')
    assert.equal(r2.text, '全部完成')
    assert.equal(sawMissing400, false, '多块回传在场——契约未触发 400')
    assert.equal(log.events.filter(e => e.kind === 'thinking').length, 2, '两块两事件落链')

    // 反向（1.21 单块时代缺陷形态）：链上只摆一块（第二块丢失）→ 续轮回传单块 → 400
    const log2 = new SessionLog('S-s77-neg')
    log2.append('user', 'user', 'T1', '帮我查')
    log2.append('model', 'thinking', 'T1', '推理一', { signature: 'sg-e2e-1=' })
    log2.append('model', 'toolCall', 'T1', { id: 'toolu_mb', tool: 'echo_tool', args: { v: 1 } })
    log2.append('plugin', 'toolResult', 'T1', { id: 'toolu_mb', result: { ok: true } })
    log2.append('user', 'user', 'T2', '继续')
    await assert.rejects(
      () => chatStep({ core, log: log2, turnId: 'T2', model: 'm', tools: [] }),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        return msg.includes('400') && msg.includes('reasoning_content')
      },
      '少块回传 → 假网关 400（多块缺陷复现）',
    )
    assert.equal(sawMissing400, true, '反向场景确实触发了网关 400')
  } finally {
    server.close()
  }
})

test('S77: E2E openai reasoning_content 假网关——落链（无 signature meta）+ 正文链序', async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      res.end(openaiSse([
        { choices: [{ delta: { reasoning_content: '先想一步' } }] },
        { choices: [{ delta: { content: '正文回答' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const core = new RuntimeCore(new CredentialService({ keychainReader: () => null }))
    core.bindContext(new Context())
    core.registerLlmAdapter(createOpenAICompatAdapter({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      fetchImpl: ((url: string | URL, init?: RequestInit) => fetch(url, init)) as typeof fetch,
    }), { default: true })
    const log = new SessionLog('S-s77-openai')
    log.append('user', 'user', 'T1', 'x')
    const r = await chatStep({ core, log, turnId: 'T1', model: 'm', tools: [] })
    assert.equal(r.stopReason, 'stop')
    const th = log.events.find(e => e.kind === 'thinking')
    assert.ok(th, 'openai 形 thinking 落链（捕获全价值：审计/计量/UI 数据源）')
    assert.equal(th!.payload, '先想一步')
    assert.equal(th!.meta?.signature, undefined, 'openai 形无签名概念')
    const ui = log.events.findIndex(e => e.kind === 'user')
    const ai = log.events.findIndex(e => e.kind === 'thinking')
    const asi = log.events.findIndex(e => e.kind === 'assistant')
    assert.ok(ui < ai && ai < asi, '链序 user → thinking → assistant')
    assert.equal(log.assertModelVisibleLogged().ok, true, 'N1 快照自洽')
  } finally {
    server.close()
  }
})
