/**
 * 1.21 · R-TOKENHUB-1 thinking 捕获与工具环回传（S67）
 *
 * 覆盖（《内核1.21-thinking捕获与工具环回传设计.md》§4）：
 *  - s67：anthropic SSE 捕获——thinking_delta → thinkingDelta chunk、signature_delta →
 *    thinkingSignatureDelta、redacted_thinking → thinkingRedacted（data 全文单发）；
 *    纯 text 流形态零变化（无 thinking chunk）
 *  - s68：chatStep 落链——thinking chunk 存在 → 'thinking' 事件（actor='model'，链序
 *    thinking → assistant(text)；signature/redacted/secretsRedacted 随 meta；payload 禁改写）；
 *    无 thinking chunk = 零新事件（D-T5 字节兼容）
 *  - s69：deriveMessages 投影——同 turn thinking → 首个 toolCall 附加 thinking 三元组；
 *    standalone / user·system 隔断 / 跨 turn 不投影；多 toolCall 单块消费（首条附加后清）
 *  - s70：toAnthropic 回传——thinking 块前置（{type:'thinking',thinking,signature?} /
 *    {type:'redacted_thinking',data}）+ tool_use；无 thinking → 1.20 形态逐字节（deepEqual）
 *  - s71：E2E enforce 契约假网关（R-TOKENHUB-1 复现闭环）——续轮缺 thinking 块 → HTTP 400
 *    tokenhub 同文（chatStep 抛 providerUnreachable）；有 → 200 两轮工具环全通
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createAnthropicAdapter, RuntimeCore } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'
import { SessionLog } from '../src/session/log.ts'
import { Context } from '../src/kernel/context.ts'
import type { LlmChunk } from '../src/runtime-core/types.ts'

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

const TEXT_EVENTS = (text: string): object[] => [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]

/** thinking + text + tool_use 全形态流（tokenhub 实测同构：thinking 块 → text 块 → tool_use 块） */
const THINKING_TOOLUSE_EVENTS = (opts: { thinking: string; signature?: string; text?: string; id: string; name: string; args: string }): object[] => {
  const out: object[] = [{ type: 'message_start', message: { role: 'assistant' } }]
  out.push(
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: opts.thinking } },
    ...(opts.signature ? [{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: opts.signature } }] : []),
    { type: 'content_block_stop', index: 0 },
  )
  let idx = 1
  if (opts.text) {
    out.push(
      { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: opts.text } },
      { type: 'content_block_stop', index: idx },
    )
    idx++
  }
  out.push(
    { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: opts.id, name: opts.name } },
    { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: opts.args } },
    { type: 'content_block_stop', index: idx },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  )
  return out
}

function coreWith(fetchImpl: typeof fetch): RuntimeCore {
  const cred = new CredentialService({ keychainReader: () => null })
  const core = new RuntimeCore(cred)
  core.bindContext(new Context())
  core.registerLlmAdapter(createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl }), { default: true })
  return core
}

// ==================== s67：SSE 捕获 ====================

test('S67: anthropic SSE——thinking_delta/signature_delta/redacted_thinking 捕获；纯 text 流零新 chunk 形态', async () => {
  const mk = (events: object[]) => createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl: (async () => sseResponse(anthropicSse(events))) as typeof fetch })

  const full = await drain(mk(THINKING_TOOLUSE_EVENTS({
    thinking: '需要先查天气', signature: 'sig-abc=', text: '好的', id: 'toolu_1', name: 'weather', args: '{"city":"北京"}',
  })).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as LlmChunk[]
  const thinkingJoined = full.filter(c => c.thinkingDelta !== undefined).map(c => c.thinkingDelta).join('')
  assert.equal(thinkingJoined, '需要先查天气', 'thinking_delta 增量捕获')
  const sig = full.filter(c => c.thinkingSignatureDelta !== undefined).map(c => c.thinkingSignatureDelta).join('')
  assert.equal(sig, 'sig-abc=', 'signature_delta 增量捕获')
  assert.equal(full.at(-1)!.finishReason, 'toolUse', '终态不受捕获影响')
  assert.ok(full.some(c => c.delta === '好的'), 'text_delta 正常放行')

  const redacted = await drain(mk([
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'REDACTED-DATA-B64' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as LlmChunk[]
  assert.deepEqual(redacted.filter(c => c.thinkingRedacted !== undefined).map(c => c.thinkingRedacted), ['REDACTED-DATA-B64'], 'redacted 全文单发')
  assert.equal(redacted.at(-1)!.finishReason, 'stop')

  const plain = await drain(mk(TEXT_EVENTS('ok')).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) as LlmChunk[]
  assert.ok(plain.every(c => c.thinkingDelta === undefined && c.thinkingSignatureDelta === undefined && c.thinkingRedacted === undefined), '纯 text 流零 thinking chunk（1.20 形态）')
})

// ==================== s68：chatStep 落链 ====================

test('S68: chatStep——thinking 落链（actor=model 链序 thinking→assistant；signature/redacted/secrets 计数随 meta；禁改写）', async () => {
  // 夹具凭据经拼接注入（G-03 文件级扫描无完整字面量——dc6dc40 同款纪律）；运行时拼出全串供 scanSecrets 命中
  const awsFixture = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
  const core = coreWith((async () => sseResponse(anthropicSse(THINKING_TOOLUSE_EVENTS({
    thinking: `推理过程 ${awsFixture} 结束`, signature: 'sig-xyz=', text: '我来查', id: 'toolu_9', name: 'f', args: '{}',
  })))) as typeof fetch)
  const log = new SessionLog('S-s68')
  log.append('user', 'user', 'T1', '查一下')
  await chatStep({ core, log, turnId: 'T1', model: 'm', tools: [] })

  const th = log.events.find(e => e.kind === 'thinking')
  assert.ok(th, 'thinking 事件落链')
  assert.equal(th!.actor, 'model')
  assert.equal(th!.turnId, 'T1')
  assert.equal(th!.payload, `推理过程 ${awsFixture} 结束`, 'payload = thinking 原文（禁改写字节保真）')
  assert.equal(th!.meta?.signature, 'sig-xyz=')
  assert.equal(th!.meta?.secretsRedacted, 1, 'secrets 命中仅计数留痕（不复写）')
  const ai = log.events.findIndex(e => e.kind === 'thinking')
  const ui = log.events.findIndex(e => e.kind === 'user')
  const asi = log.events.findIndex(e => e.kind === 'assistant')
  assert.ok(ui >= 0 && ui < ai && ai < asi, '链序 user → thinking → assistant（thinking 先于 assistant 落链——投影附加前提）')
  assert.equal(log.assertModelVisibleLogged().ok, true, 'N1 快照自洽')
})

test('S68: chatStep——无 thinking 流零新事件（D-T5 字节兼容）+ redacted 形态落链', async () => {
  const core1 = coreWith((async () => sseResponse(anthropicSse(TEXT_EVENTS('ok')))) as typeof fetch)
  const log1 = new SessionLog('S-s68b')
  log1.append('user', 'user', 'T1', 'x')
  await chatStep({ core: core1, log: log1, turnId: 'T1', model: 'm', tools: [] })
  assert.ok(!log1.events.some(e => e.kind === 'thinking'), '无 thinking chunk = 零 thinking 事件')

  const core2 = coreWith((async () => sseResponse(anthropicSse([
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'R-DATA' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]))) as typeof fetch)
  const log2 = new SessionLog('S-s68c')
  log2.append('user', 'user', 'T1', 'x')
  await chatStep({ core: core2, log: log2, turnId: 'T1', model: 'm', tools: [] })
  const th = log2.events.find(e => e.kind === 'thinking')
  assert.ok(th, 'redacted 落链')
  assert.equal(th!.payload, 'R-DATA')
  assert.equal(th!.meta?.redacted, true)
})

// ==================== s69：deriveMessages 投影 ====================

test('S69: deriveMessages——同 turn thinking 附加首个 toolCall；多 toolCall 单块消费；standalone/隔断/跨 turn 不投影', () => {
  // 同 turn：thinking → assistant → toolCall×2 → thinking 后被 user 隔断
  const log = new SessionLog('S-s69')
  log.append('user', 'user', 'T1', 'q1')
  log.append('model', 'thinking', 'T1', 'think-A', { signature: 'sig-1' })
  log.append('model', 'assistant', 'T1', 'text-A')
  log.append('model', 'toolCall', 'T1', { id: 'tu-1', tool: 'f1', args: {} })
  log.append('model', 'toolCall', 'T1', { id: 'tu-2', tool: 'f2', args: {} })
  log.append('user', 'user', 'T2', 'q2') // 跨 turn 边界（user 隔断 + turnId 变更）
  log.append('model', 'thinking', 'T2', 'think-B')
  log.append('model', 'assistant', 'T2', 'text-B') // standalone thinking（T2 无 toolCall）

  const msgs = log.deriveMessages()
  const tc1 = msgs.find(m => (m as { toolCall?: { id?: string } }).toolCall?.id === 'tu-1') as { thinking?: { text: string; signature?: string } }
  const tc2 = msgs.find(m => (m as { toolCall?: { id?: string } }).toolCall?.id === 'tu-2') as { thinking?: unknown }
  assert.ok(tc1, 'tu-1 投影在场')
  assert.deepEqual(tc1.thinking, { text: 'think-A', signature: 'sig-1' }, '首个 toolCall 附加 thinking 三元组')
  assert.equal(tc2.thinking, undefined, '多 toolCall 单块消费（首条附加后清）')
  assert.ok(!msgs.some(m => (m as { content?: unknown }).content === 'think-B'), 'standalone thinking 不单独成消息（T2 无 toolCall）')

  // N1：快照断言跨 thinking 事件自洽（投影纯函数）
  assert.equal(log.assertModelVisibleLogged().ok, true)
})

// ==================== s70：toAnthropic 回传 ====================

test('S70: toAnthropic——thinking 块前置（signature 透传 / redacted 形态）；无 thinking = 1.20 形态逐字节', async () => {
  const seen: RequestInit[] = []
  const adapter = createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
    seen.push(init!)
    return sseResponse(anthropicSse(TEXT_EVENTS('done')))
  }) as typeof fetch })

  await drain(adapter.chat({
    model: 'm',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: { toolCall: { id: 'tu-1', tool: 'f', args: { a: 1 } }, thinking: { text: '推理', signature: 'sg=' } } },
      { role: 'toolResult', content: { id: 'tu-1', result: 'r' } },
    ],
    tools: [],
  }))
  const body1 = JSON.parse(seen[0]!.body as string)
  assert.deepEqual(body1.messages[1], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '推理', signature: 'sg=' },
      { type: 'tool_use', id: 'tu-1', name: 'f', input: { a: 1 } },
    ],
  }, 'thinking 块前置 + signature 透传（Anthropic thinking+tool_use 规范形态）')

  await drain(adapter.chat({
    model: 'm',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: { toolCall: { id: 'tu-2', tool: 'g', args: {} }, thinking: { text: 'R-DATA', redacted: true } } },
      { role: 'toolResult', content: { id: 'tu-2', result: 'r' } },
    ],
    tools: [],
  }))
  const body2 = JSON.parse(seen[1]!.body as string)
  assert.deepEqual(body2.messages[1].content[0], { type: 'redacted_thinking', data: 'R-DATA' }, 'redacted 回传形态')

  await drain(adapter.chat({
    model: 'm',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: { toolCall: { id: 'tu-3', tool: 'h', args: {} } } },
      { role: 'toolResult', content: { id: 'tu-3', result: 'r' } },
    ],
    tools: [],
  }))
  const body3 = JSON.parse(seen[2]!.body as string)
  assert.deepEqual(body3.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-3', name: 'h', input: {} }],
  }, '无 thinking = 1.20 形态逐字节（D-T5 兼容线，golden 不动）')
})

// ==================== s70b：1.21.1 同轮合并（tools 声明在场严格路径——二分实证 P-B/P-C 400 vs P-D 200） ====================

test('S70b: 同轮合并——[text][tu(thinking)] → 单条 [thinking,text,tu]；连续 tu 聚合；tu-only / text-only 形态不变', async () => {
  const seen: RequestInit[] = []
  const adapter = createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
    seen.push(init!)
    return sseResponse(anthropicSse(TEXT_EVENTS('done')))
  }) as typeof fetch })
  const run = (messages: unknown[]) => drain(adapter.chat({ model: 'm', messages: messages as never, tools: [{ name: 'fs_read', description: 'x', parameters: { type: 'object' }, declaredSideEffect: 'readonly' }] }))

  // 合并：text 紧邻 thinking+tu（桌面 400 实况同构）→ 单条 [thinking, text, tool_use]
  await run([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '推理文本' },
    { role: 'assistant', content: { toolCall: { id: 'tu-1', tool: 'fs_read', args: { p: 1 } }, thinking: { text: 'TH' } } },
    { role: 'toolResult', content: { id: 'tu-1', result: 'r' } },
  ])
  assert.deepEqual(JSON.parse(seen[0]!.body as string).messages, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'TH' }, { type: 'text', text: '推理文本' }, { type: 'tool_use', id: 'tu-1', name: 'fs_read', input: { p: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '"r"' }] },
  ], '合并 = provider 原始单条形态（严格路径过审形态）')

  // 连续 tu 聚合（同 turn 多 tool_use 单条 + 前驱 text 弹回）
  await run([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '文本' },
    { role: 'assistant', content: { toolCall: { id: 'tu-a', tool: 'f1', args: {} } } },
    { role: 'assistant', content: { toolCall: { id: 'tu-b', tool: 'f2', args: {} } } },
    { role: 'toolResult', content: { id: 'tu-a', result: 'ra' } },
    { role: 'toolResult', content: { id: 'tu-b', result: 'rb' } },
  ])
  assert.deepEqual(JSON.parse(seen[1]!.body as string).messages[1].content, [
    { type: 'text', text: '文本' },
    { type: 'tool_use', id: 'tu-a', name: 'f1', input: {} },
    { type: 'tool_use', id: 'tu-b', name: 'f2', input: {} },
  ], '连续 toolCall 消息聚合单条 + text 弹回合并')

  // tu-only（无相邻文本）形态不变（[tool_use]，thinking 前置）；text-only 字符串形态不变
  await run([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: { toolCall: { id: 'tu-c', tool: 'f3', args: {} }, thinking: { text: 'T3' } } },
    { role: 'toolResult', content: { id: 'tu-c', result: 'r' } },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: '纯文本回复' },
  ])
  assert.deepEqual(JSON.parse(seen[2]!.body as string).messages, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'T3' }, { type: 'tool_use', id: 'tu-c', name: 'f3', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-c', content: '"r"' }] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: '纯文本回复' },
  ], 'tu-only / text-only 形态与 1.21.0 逐字节一致（D-T5 兼容线维持）')
})

// ==================== s71：E2E enforce 契约假网关（R-TOKENHUB-1 复现闭环） ====================

test('S71: E2E——enforce 契约假网关：续轮缺 thinking → 400 tokenhub 同文复现；有 thinking → 两轮工具环全通', async () => {
  let sawMissingThinking400 = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
      const hasToolResult = parsed.messages.some(m => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(b => b.type === 'tool_result'))
      if (hasToolResult) {
        const hasThinking = parsed.messages.some(m => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(b => b.type === 'thinking' || b.type === 'redacted_thinking'))
        if (!hasThinking) {
          sawMissingThinking400 = true
          res.writeHead(400, { 'content-type': 'application/json', connection: 'close' })
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'The `reasoning_content` in the thinking mode must be passed back to the API.' } }))
          return
        }
      }
      // 有 tool_result 历史且 thinking 在场 → 终轮 text；否则首轮 → thinking + tool_use
      const isContinuation = hasToolResult
      const sse = isContinuation
        ? anthropicSse(TEXT_EVENTS('全部完成'))
        : anthropicSse(THINKING_TOOLUSE_EVENTS({ thinking: '推理中', signature: 'sg-e2e=', text: '查一下', id: 'toolu_e2e', name: 'echo_tool', args: '{"v":1}' }))
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      res.end(sse)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const core = coreWith(((url: string | URL, init?: RequestInit) => fetch(`http://127.0.0.1:${port}/v1/messages`, init)) as typeof fetch)
    const log = new SessionLog('S-s71')
    // T1：user → thinking+toolUse 流落链
    log.append('user', 'user', 'T1', '帮我查')
    const r1 = await chatStep({ core, log, turnId: 'T1', model: 'm', tools: [{ name: 'echo_tool', description: 'x', parameters: { type: 'object' }, declaredSideEffect: 'readonly' }] })
    assert.equal(r1.stopReason, 'toolUse')
    // runTurn 落链口径（stop.ts:176 同构）：toolCall + toolResult
    log.append('model', 'toolCall', 'T1', r1.toolCalls![0]!)
    log.append('plugin', 'toolResult', 'T1', { id: r1.toolCalls![0]!.id, result: { ok: true } })
    // T2：续轮——假网关 enforce thinking 回传；修复后 200 全通
    log.append('user', 'user', 'T2', '继续')
    const r2 = await chatStep({ core, log, turnId: 'T2', model: 'm', tools: [] })
    assert.equal(r2.stopReason, 'stop')
    assert.equal(r2.text, '全部完成')
    assert.equal(sawMissingThinking400, false, 'thinking 回传在场——契约未触发 400')
    assert.equal(log.events.filter(e => e.kind === 'thinking').length, 1, '仅 T1 落一条 thinking 事件')

    // 反向复现（R-TOKENHUB-1 原始缺陷形态）：1.20 时代链形态（无 thinking 事件、toolCall/toolResult
    // 照落——1.20 chatStep 不落 thinking，此处手工摆链等价）→ 续轮 400
    const log2 = new SessionLog('S-s71-neg')
    log2.append('user', 'user', 'T1', '帮我查')
    log2.append('model', 'toolCall', 'T1', { id: 'toolu_e2e', tool: 'echo_tool', args: { v: 1 } })
    log2.append('plugin', 'toolResult', 'T1', { id: 'toolu_e2e', result: { ok: true } })
    log2.append('user', 'user', 'T2', '继续')
    await assert.rejects(
      () => chatStep({ core, log: log2, turnId: 'T2', model: 'm', tools: [] }),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        return msg.includes('400') && msg.includes('reasoning_content')
      },
      '缺 thinking 回传 → 假网关 400 → providerUnreachable（R-TOKENHUB-1 复现）',
    )
    assert.equal(sawMissingThinking400, true, '反向场景确实触发了网关 400')
  } finally {
    server.close()
  }
})
