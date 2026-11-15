/**
 * s78 · 1.23-W1 失败细类标注（kind 九类产出 + turnEnd meta 传播 + abortedAt 三路径 + 字节兼容线）
 *
 * 判据（《内核1.23-W1失败细类标注-迭代规划.md》D-W1-1~6 / W-0 审计 F-W0-1~3）：
 *  - kind 九类逐类产出：共享引擎 transport-4xx / context-limit-suspect / transport-exhausted /
 *    stream-midbreak / no-finish-reason；两族 parse unmapped-finish / refusal（双族对齐）/
 *    provider-stream-error；chatStep proto-invalid-args；
 *  - error chunk kind → chatStep providerUnreachable → runTurn turnEnd meta.kind（加法尾键）；
 *  - abortedAt：循环头 = before-request / 流中 chunk 间隙 = in-flight / 零 chunk 流结束 = before-request；
 *    terminate 型 abort 不带键（工具主动收口语义非取消）；
 *  - 字节兼容线：正常 turn 的 turnEnd meta 与 1.22 形态逐字段一致（无 kind/abortedAt 键）；
 *    正常流 chunk 无 error 键。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createOpenAICompatAdapter, createAnthropicAdapter, RuntimeCore, type LlmAdapter, type LlmChunk, type LlmRequest } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { runTurn, type ToolDef } from '../src/loop/stop.ts'
import { SessionLog } from '../src/session/log.ts'

const BASE_REQ: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }

/** 本地 SSE 服务（handler 自主控制响应形态；loopback TLS 豁免面内） */
function sseServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

const openaiAdapterAt = (port: number) => createOpenAICompatAdapter({
  baseUrl: `http://127.0.0.1:${port}/v1`, provider: 'openai-compat',
  retries: 0, firstByteMs: 5_000, timeoutMs: 10_000, backoffMs: [1],
})
const anthropicAdapterAt = (port: number) => createAnthropicAdapter({
  baseUrl: `http://127.0.0.1:${port}`, retries: 0, firstByteMs: 5_000, timeoutMs: 10_000, backoffMs: [1],
})

// ==================== 共享引擎产出点（streamSsePost——两族同享） ====================

test('S78-1 transport-4xx：4xx 错误体未命中 overflow 特征 → kind=transport-4xx', async () => {
  const srv = await sseServer((_q, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad request"}') })
  try {
    const chunks = await collect(openaiAdapterAt(srv.port).chat(BASE_REQ))
    const last = chunks.at(-1)!
    assert.equal(last.finishReason, 'error')
    assert.equal(last.error?.kind, 'transport-4xx')
    assert.match(last.error!.message, /HTTP 400/)
  } finally { await srv.close() }
})

test('S78-2 context-limit-suspect：4xx 错误体命中 overflow 特征词（确定性规则非估算）', async () => {
  const srv = await sseServer((_q, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"prompt is too long: 9000 tokens > 8000 maximum context length"}}') })
  try {
    const chunks = await collect(openaiAdapterAt(srv.port).chat(BASE_REQ))
    assert.equal(chunks.at(-1)!.error?.kind, 'context-limit-suspect')
  } finally { await srv.close() }
})

test('S78-3 transport-exhausted：重试耗尽（503 + retries=0）→ CarM8Error.kind=transport-exhausted', async () => {
  const srv = await sseServer((_q, res) => { res.writeHead(503); res.end() })
  try {
    await assert.rejects(
      () => collect(openaiAdapterAt(srv.port).chat(BASE_REQ)),
      (e: unknown) => {
        const m8 = e as { name?: string; kind?: string; code?: string }
        assert.equal(m8.name, 'CarM8Error')
        assert.equal(m8.kind, 'transport-exhausted')
        assert.equal(m8.code, 'B080001')
        return true
      },
    )
  } finally { await srv.close() }
})

test('S78-4 stream-midbreak：流中途连接破坏（已消费 chunk 不可重放）→ error chunk kind=stream-midbreak', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n')
    setTimeout(() => res.destroy(), 20) // 无 finish_reason 即断
  })
  try {
    const chunks = await collect(openaiAdapterAt(srv.port).chat(BASE_REQ))
    const last = chunks.at(-1)!
    assert.equal(last.finishReason, 'error')
    assert.equal(last.error?.kind, 'stream-midbreak')
  } finally { await srv.close() }
})

test('S78-5 no-finish-reason：流自然结束无 finish_reason（AL-05）→ kind=no-finish-reason', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
    res.end() // 无 finish_reason、无 [DONE]
  })
  try {
    const chunks = await collect(openaiAdapterAt(srv.port).chat(BASE_REQ))
    assert.equal(chunks.at(-1)!.error?.kind, 'no-finish-reason')
  } finally { await srv.close() }
})

// ==================== 两族 parse 产出点 ====================

test('S78-6 unmapped-finish（openai）：finish_reason 不在 FINISH_MAP → fail-visible error chunk + 细类', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{},"finish_reason":"weird_signal"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  try {
    const chunks = await collect(openaiAdapterAt(srv.port).chat(BASE_REQ))
    const last = chunks.at(-1)!
    assert.equal(last.finishReason, 'error')
    assert.equal(last.error?.kind, 'unmapped-finish')
    assert.match(last.error!.message, /weird_signal/)
  } finally { await srv.close() }
})

test('S78-7 refusal（anthropic）：stop_reason=refusal → finishReason 映射不动 + 附加 error chunk kind=refusal', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n')
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"no"}}\n\n')
    res.write('data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":5}}\n\n')
    res.end()
  })
  try {
    const chunks = await collect(anthropicAdapterAt(srv.port).chat(BASE_REQ))
    const last = chunks.at(-1)!
    assert.equal(last.finishReason, 'aborted', 'refusal 映射保持 1.22 形态（不动）')
    assert.equal(last.error?.kind, 'refusal', '1.23-W1：附加 error chunk 细类（F-W0-1 语义两跳修复）')
    assert.match(last.error!.message, /refusal/)
  } finally { await srv.close() }
})

test('S78-8 provider-stream-error（anthropic）：流内 error 事件（overloaded_error）→ kind=provider-stream-error', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
    res.end()
  })
  try {
    const chunks = await collect(anthropicAdapterAt(srv.port).chat(BASE_REQ))
    assert.equal(chunks.at(-1)!.error?.kind, 'provider-stream-error')
  } finally { await srv.close() }
})

test('S78-9 unmapped-finish（anthropic）：stop_reason 不在映射表 → kind=unmapped-finish', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n')
    res.write('data: {"type":"message_delta","delta":{"stop_reason":"mystery"},"usage":{"output_tokens":2}}\n\n')
    res.end()
  })
  try {
    const chunks = await collect(anthropicAdapterAt(srv.port).chat(BASE_REQ))
    assert.equal(chunks.at(-1)!.error?.kind, 'unmapped-finish')
  } finally { await srv.close() }
})

test('S78-9b refusal（openai content_filter）：与 anthropic stop_reason=refusal 同款对齐', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  try {
    const chunks = await collect(openaiAdapterAt(srv.port).chat(BASE_REQ))
    const last = chunks.at(-1)!
    assert.equal(last.finishReason, 'aborted')
    assert.equal(last.error?.kind, 'refusal')
  } finally { await srv.close() }
})

// ==================== chatStep / runTurn 传播与 abortedAt ====================

function coreWith(id: string, script: Array<LlmChunk[]>): RuntimeCore {
  const core = new RuntimeCore()
  let call = 0
  core.registry.register({
    id,
    async *chat(): AsyncIterable<LlmChunk> {
      yield* script[Math.min(call++, script.length - 1)]!
    },
  } as LlmAdapter)
  return core
}

const turnEndMeta = (log: SessionLog, turnId: string): Record<string, unknown> | undefined =>
  log.events.filter((e) => e.kind === 'turnEnd' && e.turnId === turnId).at(-1)?.meta as Record<string, unknown> | undefined

test('S78-10 proto-invalid-args：toolUse args 非法 JSON → CarM8Error（转形后 code/userHint/retryable/kind 齐）', async () => {
  const log = new SessionLog('s78-proto')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-proto', [[
    { toolCallDelta: { index: 0, id: 'tc1', name: 'fs_read', argumentsDelta: '{"x":' } },
    { toolCallDelta: { index: 0, argumentsDelta: '}' } }, // '{"x":}' = 非法 JSON
    { finishReason: 'toolUse' },
  ]])
  await assert.rejects(
    () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] }),
    (e: unknown) => {
      const m8 = e as { name?: string; kind?: string; code?: string; retryable?: boolean; message?: string }
      assert.equal(m8.name, 'CarM8Error')
      assert.equal(m8.kind, 'proto-invalid-args')
      assert.equal(m8.code, 'B080001')
      assert.equal(m8.retryable, false)
      assert.match(m8.message!, /CAR-E-LLM-PROTO.*（B080001）/)
      return true
    },
  )
})

test('S78-11 turnEnd meta.kind 传播：error chunk kind → providerUnreachable → closeTurn（加法尾键）', async () => {
  const log = new SessionLog('s78-propagate')
  log.append('user', 'user', 'T1', 'hi')
  const core = coreWith('fake-kind', [[
    { finishReason: 'error', error: { code: 'B080001', message: 'provider HTTP 400：bad', kind: 'transport-4xx' } },
  ]])
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] }),
    tools: new Map<string, ToolDef>(),
  })
  assert.equal(result.reason, 'error')
  const meta = turnEndMeta(log, 'T1')!
  assert.equal(meta.kind, 'transport-4xx')
  assert.equal(meta.code, 'B080001')
  assert.equal(meta.retryable, true)
  assert.match(String(meta.detail), /CAR-E-LLM-UNREACHABLE/)
})

test('S78-12 abortedAt=before-request：循环头取消（model 回调不得被调用）', async () => {
  const log = new SessionLog('s78-before')
  log.append('user', 'user', 'T1', 'hi')
  const signal = { aborted: true }
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => { throw new Error('model must not be called') },
    tools: new Map<string, ToolDef>(),
    signal,
  })
  assert.equal(result.reason, 'aborted')
  const meta = turnEndMeta(log, 'T1')!
  assert.equal(meta.abortedAt, 'before-request')
})

test('S78-13 abortedAt=in-flight：流中 chunk 间隙取消（在途打断）', async () => {
  const log = new SessionLog('s78-mid')
  log.append('user', 'user', 'T1', 'hi')
  const signal = { aborted: false }
  const core = new RuntimeCore()
  core.registry.register({
    id: 'fake-abort-mid',
    async *chat(): AsyncIterable<LlmChunk> {
      yield { delta: 'a' }
      signal.aborted = true // 首块后置位——下一 chunk 到达即触发 chunk 间隙路径
      yield { delta: 'b' }
      yield { finishReason: 'stop' }
    },
  } as LlmAdapter)
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [], signal }),
    tools: new Map<string, ToolDef>(),
    signal,
  })
  assert.equal(result.reason, 'aborted')
  const meta = turnEndMeta(log, 'T1')!
  assert.equal(meta.abortedAt, 'in-flight')
})

test('S78-14 abortedAt=before-request（零 chunk 路径）：attempt 前静默收口 = 请求未发出', async () => {
  const log = new SessionLog('s78-zerofetch')
  log.append('user', 'user', 'T1', 'hi')
  const signal = { aborted: false }
  const wrapped = new RuntimeCore()
  wrapped.registry.register({
    id: 'fake-abort-pre',
    async *chat(): AsyncIterable<LlmChunk> {
      signal.aborted = true // attempt 前置位（模拟 D-19 attempt 前检查静默收口）
      return
    },
  } as LlmAdapter)
  const result = await runTurn({
    log, turnId: 'T1',
    model: () => chatStep({ core: wrapped, log, turnId: 'T1', model: 'm1', tools: [], signal }),
    tools: new Map<string, ToolDef>(),
    signal,
  })
  assert.equal(result.reason, 'aborted')
  const meta = turnEndMeta(log, 'T1')!
  assert.equal(meta.abortedAt, 'before-request')
})

test('S78-15 terminate 型 abort 不带 abortedAt 键（工具主动收口语义，非用户取消）', async () => {
  const log = new SessionLog('s78-term')
  log.append('user', 'user', 'T1', 'hi')
  const tools = new Map<string, ToolDef>([['finish', { declaredSideEffect: 'readonly', terminate: true, run: async () => ({ ok: true }) }]])
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => ({ stopReason: 'toolUse', toolCalls: [{ id: '1', tool: 'finish', args: {} }] }),
    tools,
  })
  assert.equal(result.reason, 'aborted')
  const meta = turnEndMeta(log, 'T1')!
  assert.equal('abortedAt' in meta, false, 'terminate 收口不是取消——不带键（D-W1-6）')
})

test('S78-16 字节兼容线：正常 turn 的 turnEnd meta 无 kind/abortedAt 键（1.22 形态不变）', async () => {
  const log = new SessionLog('s78-compat')
  log.append('user', 'user', 'T1', 'hi')
  const result = await runTurn({
    log, turnId: 'T1',
    model: async () => ({ stopReason: 'stop', text: 'ok' }),
    tools: new Map<string, ToolDef>(),
  })
  assert.equal(result.reason, 'completed')
  const meta = turnEndMeta(log, 'T1')!
  assert.deepEqual(meta, { reason: 'completed' }, 'meta 与 1.22 逐字段一致（usage 缺席形态）')
})

test('S78-17 正常流 chunk 无 error 键（finishReason=stop 形态与 1.22 一致）', async () => {
  const srv = await sseServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  try {
    const chunks = await collect(openaiAdapterAt(srv.port).chat(BASE_REQ))
    const last = chunks.at(-1)!
    assert.equal(last.finishReason, 'stop')
    assert.equal('error' in last, false, '正常终态 chunk 不带 error 键（1.22 形态）')
  } finally { await srv.close() }
})
