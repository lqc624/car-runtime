/**
 * s81 · 1.24.2 F5 wire 级工具环相邻性（连续多步工具环 → anthropic wire 形态守门）
 *
 * 判据（桌面 B-2 真模型演练 2026-11-15 实锤——tokenhub 400「tool_calls must be followed by
 * tool messages」，requestSent:false 首块前失败）：
 *  - 连续多步工具环第二次请求的 wire = assistant(tool_use A) → user[tool_result A] →
 *    assistant(tool_use B) → user[tool_result B] → user(新 prompt)；
 *  - 修复前形态（缺陷）：assistant(A) → assistant(B) → user[A,B 合并]——tool_result 缓冲跨
 *    assistant 滞后（toAnthropic toolCall 分支缺 flushToolResults——挂起结果先出站修复）；
 *  - 单步环形态不变（兼容线：assistant → user[tool_result] → user 逐字节同 1.24.1）；
 *  - 教训重申（1.21.1 同案）：形态级契约缺口只有真网关 wire 捕获能暴露——enforce 假网关
 *    抓 wire 断言为永久回归锚点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createAnthropicAdapter } from '../src/runtime-core/llm.ts'

/** anthropic 形假网关：抓请求 body + 回合法 SSE 流 */
function wireServer(bodies: unknown[]): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((q: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      q.on('data', (c) => (raw += c))
      q.on('end', () => {
        bodies.push(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`)
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

/** chatStep 归一形消息（第二次请求 = 连续工具环历史）——chatStep.ts L86-93 同构 */
const twoStepLoopMessages = [
  { role: 'user', content: '连点两个按钮' },
  { role: 'assistant', content: { toolCall: { id: 'call-A', tool: 'toolA', args: {} }, thinking: { text: 'step1-thought' } } },
  { role: 'toolResult', content: { id: 'call-A', result: 'a-ok' } },
  { role: 'assistant', content: { toolCall: { id: 'call-B', tool: 'toolB', args: {} }, thinking: { text: 'step2-thought' } } },
  { role: 'toolResult', content: { id: 'call-B', result: 'b-ok' } },
  { role: 'user', content: '继续' },
]

const summarize = (body: { messages: Array<{ role: string; content: unknown }> }) =>
  body.messages.map((m) => {
    if (!Array.isArray(m.content)) return m.role + '[' + String(m.content).slice(0, 20) + ']'
    return (
      m.role +
      '[' +
      m.content
        .map((b: { type: string; id?: string; tool_use_id?: string; text?: string; thinking?: string }) =>
          b.type === 'tool_use' ? 'tool_use(' + b.id + ')' : b.type === 'tool_result' ? 'tool_result(' + b.tool_use_id + ')' : b.type + (b.type === 'thinking' ? '[' + (b.thinking || '').slice(0, 10) + ']' : ''),
        )
        .join(' | ') +
      ']'
    )
  })

test('S81-1 连续多步工具环 wire：assistant(tu)→user[tool_result]→assistant(tu) 相邻性完整（F5 回归锚点）', async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const srv = await wireServer(bodies)
  try {
    const adapter = createAnthropicAdapter({ baseUrl: `http://127.0.0.1:${srv.port}`, provider: 'anthropic', retries: 0, firstByteMs: 5000, timeoutMs: 10000 })
    const chunks = []
    for await (const c of adapter.chat({ model: 'm1', messages: twoStepLoopMessages, tools: [], maxTokens: 300 } as Parameters<typeof adapter.chat>[0])) chunks.push(c)
    assert.equal(chunks.at(-1)!.finishReason, 'stop', '假网关正常收口')
    assert.equal(bodies.length, 1)
    const seq = summarize(bodies[0]!)
    assert.deepEqual(seq, [
      'user[连点两个按钮]',
      'assistant[thinking[step1-thou] | tool_use(call-A)]',
      'user[tool_result(call-A)]',
      'assistant[thinking[step2-thou] | tool_use(call-B)]',
      'user[tool_result(call-B)]',
      'user[继续]',
    ], 'F5 修复形态：每个 assistant(tool_use) 后紧跟其 tool_result（挂起缓冲先出站）')
    // 协议级断言（与 1.21.1 D-T7 合并形态并存）：assistant 带 tool_use → 下一条 user 恰好含对应 tool_result
    for (let i = 0; i < bodies[0]!.messages.length; i++) {
      const m = bodies[0]!.messages[i]!
      if (!Array.isArray(m.content)) continue
      const tus = (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use')
      if (!tus.length) continue
      const nxt = bodies[0]!.messages[i + 1]
      assert.ok(nxt && nxt.role === 'user', `assistant(tool_use @${i}) 下一条 = user（anthropic Messages 协议）`)
      for (const tu of tus) {
        const matched = (nxt!.content as Array<{ type: string; tool_use_id?: string }>).some((b) => b.type === 'tool_result' && b.tool_use_id === tu.id)
        assert.ok(matched, `tool_use(${tu.id}) 有配对 tool_result 且紧邻`)
      }
    }
  } finally { await srv.close() }
})

test('S81-2 单步环 wire 兼容：assistant → user[tool_result] → user 形态不变（1.24.1 逐字节兼容线）', async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const srv = await wireServer(bodies)
  try {
    const adapter = createAnthropicAdapter({ baseUrl: `http://127.0.0.1:${srv.port}`, provider: 'anthropic', retries: 0, firstByteMs: 5000, timeoutMs: 10000 })
    for await (const c of adapter.chat({
      model: 'm1',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: { toolCall: { id: 'call-1', tool: 't', args: {} } } },
        { role: 'toolResult', content: { id: 'call-1', result: 'r' } },
        { role: 'user', content: 'next' },
      ],
      tools: [],
      maxTokens: 300,
    } as Parameters<typeof adapter.chat>[0])) { void c }
    assert.deepEqual(summarize(bodies[0]!), [
      'user[q]',
      'assistant[tool_use(call-1)]',
      'user[tool_result(call-1)]',
      'user[next]',
    ], '单步环无回归（无 thinking = 1.20 形态）')
  } finally { await srv.close() }
})

test('S81-3 卡未决插队 user：steer 消息夹在 toolCall 与 toolResult 之间 → 协议正常化（F6 回归锚点）', async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const srv = await wireServer(bodies)
  try {
    const adapter = createAnthropicAdapter({ baseUrl: `http://127.0.0.1:${srv.port}`, provider: 'anthropic', retries: 0, firstByteMs: 5000, timeoutMs: 10000 })
    for await (const c of adapter.chat({
      model: 'm1',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: { toolCall: { id: 'call-X', tool: 't', args: {} } } },
        { role: 'user', content: 'steer-插队消息（授权门未决期间用户发的话）' },
        { role: 'toolResult', content: { id: 'call-X', error: 'authorization-denied', result: undefined } },
        { role: 'user', content: 'q2' },
      ],
      tools: [],
      maxTokens: 300,
    } as Parameters<typeof adapter.chat>[0])) { void c }
    const seq = summarize(bodies[0]!)
    assert.deepEqual(seq, [
      'user[q1]',
      'assistant[tool_use(call-X)]',
      'user[tool_result(call-X)]',
      'user[steer-插队消息（授权门未决期间用户]', // summarize 截断 20 字符
      'user[q2]',
    ], 'F6 修复形态：tool_result 先出站，插队 user 顺延其后（协议相邻性）')
  } finally { await srv.close() }
})
