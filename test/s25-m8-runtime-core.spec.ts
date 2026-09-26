/**
 * M8 · 运行时底座收口测试（s25）——增量 1：注册表 / finishReason 守卫 / RuntimeCore + Effect 可逆
 *
 * 断言全部对齐 src/runtime-core 真实实现（llm.ts / types.ts / errors.ts）；
 * 增量 2（credentials/redaction/telemetry）、增量 3（chatStep/openai-compat SSE）随后追加。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AdapterRegistry, RuntimeCore, withFinishReasonGuard } from '../src/runtime-core/llm.ts'
import type { LlmAdapter, LlmChunk, LlmRequest } from '../src/runtime-core/types.ts'
import { Context } from '../src/kernel/context.ts'

function fakeAdapter(id: string, chunks: LlmChunk[] = []): LlmAdapter {
  return { id, async *chat(_req: LlmRequest) { yield* chunks } }
}

test('M8: AdapterRegistry——注册/默认回退/重复 id 显式报错/未注册显式报错/list/dispose 幂等', () => {
  const reg = new AdapterRegistry()
  assert.throws(() => reg.get(), /CAR-E-LLM-NOADAPTER.*无/, '空注册表显式报错（禁静默降级）')
  const d1 = reg.register(fakeAdapter('openai-compat'))
  assert.equal(reg.get().id, 'openai-compat', '首个注册即默认')
  const d2 = reg.register(fakeAdapter('anthropic'))
  assert.equal(reg.get().id, 'openai-compat', '后注册不改默认')
  assert.equal(reg.get('anthropic').id, 'anthropic', '显式 id 路由')
  assert.throws(() => reg.register(fakeAdapter('openai-compat')), /CAR-E-LLM-DUP.*already registered/, '重复 id 禁静默覆盖')
  assert.throws(() => reg.get('missing'), /CAR-E-LLM-NOADAPTER.*在册：openai-compat, anthropic/, '未注册 id 报错附在册清单')
  assert.deepEqual(reg.list().map(a => a.id), ['openai-compat', 'anthropic'])
  assert.deepEqual(reg.list().map(a => a.isDefault), [true, false])
  d2.dispose()
  assert.throws(() => reg.get('anthropic'), /CAR-E-LLM-NOADAPTER/)
  d2.dispose() // 幂等：二次 dispose 不抛（登记口径）
  assert.equal(reg.list().length, 1)
  const d3 = reg.register(fakeAdapter('anthropic')) // Effect 可逆：dispose 后可重注册
  assert.equal(reg.get('anthropic').id, 'anthropic')
  d3.dispose()
  d1.dispose()
  assert.throws(() => reg.get(), /CAR-E-LLM-NOADAPTER.*无/, '全空后显式报错')
})

test('M8: withFinishReasonGuard——首个定格透传 / 冲突显式抛错（不可变透传契约）/ 同值重复放行 / 无 finish 透传', async () => {
  async function* src(chunks: LlmChunk[]): AsyncIterable<LlmChunk> { yield* chunks }
  const out1: LlmChunk[] = []
  for await (const c of withFinishReasonGuard(src([{ delta: 'a' }, { finishReason: 'stop' }, { delta: 'b' }]))) out1.push(c)
  assert.equal(out1.length, 3, 'chunk 原样透传（finishReason 后续 chunk 不截断）')
  await assert.rejects(
    async () => { for await (const _c of withFinishReasonGuard(src([{ finishReason: 'stop' }, { finishReason: 'length' }]))) { /* 消费 */ } },
    /CAR-E-LLM-FINISH.*已定格为 "stop".*"length"/,
    '冲突 finishReason = 契约违规显式抛（改写/吞没均禁止）',
  )
  const out2: LlmChunk[] = []
  for await (const c of withFinishReasonGuard(src([{ finishReason: 'stop' }, { finishReason: 'stop' }]))) out2.push(c)
  assert.equal(out2.length, 2, '同值重复放行')
  const out3: LlmChunk[] = []
  for await (const c of withFinishReasonGuard(src([{ delta: 'x' }]))) out3.push(c)
  assert.equal(out3.length, 1, '无 finishReason 透传（守卫不注入；AL-05 显式化在适配器层）')
})

test('M8: RuntimeCore.chat——默认路由 / 显式 adapterId / 未注册显式报错', async () => {
  const core = new RuntimeCore()
  const req: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }
  core.registerLlmAdapter(fakeAdapter('openai-compat', [{ delta: 'he' }, { finishReason: 'stop' }]))
  core.registerLlmAdapter(fakeAdapter('anthropic', [{ delta: 'yo' }, { finishReason: 'stop' }]), { default: true })
  const out1: LlmChunk[] = []
  for await (const c of core.chat(req)) out1.push(c)
  assert.equal(out1.length, 2, 'delta chunk + finishReason chunk')
  assert.equal(out1[0]!.delta, 'yo', '无 adapterId → 默认适配器')
  assert.equal(out1[1]!.finishReason, 'stop')
  const out2: LlmChunk[] = []
  for await (const c of core.chat({ ...req, adapterId: 'openai-compat' })) out2.push(c)
  assert.equal(out2[0]!.delta, 'he', '显式 adapterId 路由')
  assert.equal(out2[1]!.finishReason, 'stop')
  await assert.rejects(
    async () => { for await (const _c of core.chat({ ...req, adapterId: 'nope' })) { /* 消费 */ } },
    /CAR-E-LLM-NOADAPTER/,
  )
})

test('M8: registerLlmAdapter Effect 可逆——disposeRuntime 回卷后适配器出册、可重注册', async () => {
  const core = new RuntimeCore()
  const ctx = new Context()
  core.bindContext(ctx)
  core.registerLlmAdapter(fakeAdapter('openai-compat', [{ finishReason: 'stop' }]), { default: true })
  assert.equal(core.registry.get().id, 'openai-compat')
  const report = await ctx.disposeRuntime()
  assert.equal(report.errors.length, 0, '回卷零错误')
  assert.throws(() => core.registry.get(), /CAR-E-LLM-NOADAPTER/, '回卷后适配器出册（注册即逆变换，POC-2 同源）')
  core.registerLlmAdapter(fakeAdapter('openai-compat', [{ finishReason: 'stop' }]), { default: true })
  assert.equal(core.registry.get().id, 'openai-compat', '回卷后可重注册')
})

// ==================== 增量 2：credentials / redaction / telemetry ====================

import { keychainService, probeKeychainChannel, CredentialService } from '../src/runtime-core/credentials.ts'
import { redact, StreamRedactor } from '../src/runtime-core/redaction.ts'
import { createTelemetryFacade } from '../src/runtime-core/telemetry.ts'
import { readFileSync } from 'node:fs'

// F12 三层检测（L2 熵 ≥3.5）下保证命中：连接串形态豁免熵检（s7 同源判据）；mongodb 亦在 M8 流式锚点表内
const SECRET = 'mongodb://car:S3cretPw9xK2mQ7@cluster0.abc.mongodb.net/db'

test('M8: keychainService 命名空间 + 平台通道探测（win32 读通道缺席显式降级）', () => {
  assert.equal(keychainService('openai'), 'car-runtime/openai')
  const win = probeKeychainChannel('win32')
  assert.equal(win.reader, null, 'win32 无零依赖读通道')
  assert.match(win.note, /缺席|显式降级/)
  assert.ok(probeKeychainChannel('darwin').reader, 'darwin 探测构造读取器（调用时才 spawn）')
  assert.ok(probeKeychainChannel('linux').reader, 'linux 探测构造读取器')
})

test('M8: CredentialService.resolve——keychain 命中出 ref（零明文）+ 审计留痕', () => {
  const audits: Array<Record<string, unknown>> = []
  const svc = new CredentialService({ keychainReader: s => (s === 'car-runtime/openai' ? 'sk-keychain-secret-value' : null) })
  const ref = svc.resolve('openai', { audit: e => audits.push(e as Record<string, unknown>) })
  assert.deepEqual(ref, { provider: 'openai', source: 'keychain', origin: 'car-runtime/openai' })
  assert.equal(JSON.stringify(ref).includes('sk-keychain-secret-value'), false, 'ref 不落明文（O-13）')
  assert.equal(audits.length, 1)
  assert.equal(audits[0]!.action, 'resolve')
  assert.equal('value' in audits[0]!, false, '审计事件零明文')
})

test('M8: resolve——全落空 A080001（不重试 + 引导 car doctor）+ env fallback 显式开启语义', () => {
  const svc = new CredentialService({ keychainReader: () => null })
  assert.throws(() => svc.resolve('openai', { env: {} }), (e: unknown) => {
    const err = e as { message: string; userHint?: string }
    assert.match(err.message, /A080001/, '错误码在 message')
    assert.match(err.userHint ?? '', /car doctor/, '用户文案在 userHint 字段（独立于 message）')
    return true
  })
  // env fallback 默认关：env 有值也不取（provider 命名空间 = 适配器 id，'openai-compat'）
  assert.throws(() => svc.resolve('openai-compat', { env: { OPENAI_API_KEY: SECRET } }), /A080001/, 'fallback 未显式开启 = 不取 env')
  // 显式开启 → env 命中 + keychain 通道缺席降级留痕（win32 无读通道 = 真缺席；() => null 是空 keychain 非缺席）
  const noChannel = new CredentialService({ platform: 'win32' })
  assert.equal(noChannel.channelStatus.available, false)
  const ref = noChannel.resolve('openai-compat', { env: { OPENAI_API_KEY: SECRET }, allowEnvFallback: true })
  assert.deepEqual(ref, { provider: 'openai-compat', source: 'env', origin: 'OPENAI_API_KEY', degraded: noChannel.channelStatus.note })
  // CAR_ALLOW_ENV_CREDENTIALS=1 等效
  const ref2 = noChannel.resolve('openai-compat', { env: { OPENAI_API_KEY: SECRET, CAR_ALLOW_ENV_CREDENTIALS: '1' } })
  assert.equal(ref2.source, 'env')
  // 未知 provider → CAR_LLM_API_KEY 通用兜底
  const ref3 = noChannel.resolve('unknown-provider', { env: { CAR_LLM_API_KEY: SECRET }, allowEnvFallback: true })
  assert.equal(ref3.origin, 'CAR_LLM_API_KEY')
})

test('M8: reveal——按需取值 + 审计留痕 + 值消失显式报错 + 值不入错误信息', () => {
  const audits: Array<Record<string, unknown>> = []
  const audit = (e: unknown) => audits.push(e as Record<string, unknown>)
  const svc = new CredentialService({ keychainReader: s => (s === 'car-runtime/openai' ? SECRET : null) })
  const ref = svc.resolve('openai', { audit })
  const value = svc.reveal(ref, { audit })
  assert.equal(value, SECRET)
  assert.equal(audits.length, 2, 'resolve + reveal 各一条')
  assert.equal(audits[1]!.action, 'reveal')
  assert.equal(JSON.stringify(audits).includes(SECRET), false, '审计零明文')
  // 值消失（resolve 后被删）→ 显式报错
  const gone = new CredentialService({ keychainReader: () => null })
  assert.throws(() => gone.reveal({ provider: 'openai', source: 'keychain', origin: 'car-runtime/openai' }), /A080001/)
  // env ref reveal
  const envSvc = new CredentialService({ keychainReader: () => null })
  const v2 = envSvc.reveal({ provider: 'openai', source: 'env', origin: 'OPENAI_API_KEY' }, { env: { OPENAI_API_KEY: SECRET } })
  assert.equal(v2, SECRET)
})

test('M8: redact——遮蔽不漏原文 + 计数 + 幂等', () => {
  const text = `my key is ${SECRET} end`
  const r = redact(text)
  assert.equal(r.redacted.includes(SECRET), false, '原文不残留')
  assert.equal(r.hits.length, 1)
  assert.equal(r.redactedCount, 1)
  assert.equal(redact(r.redacted).redactedCount, 0, '幂等：遮蔽后不再命中')
})

test('M8: StreamRedactor——跨 chunk 命中不泄漏 / 假锚点不误遮 / 尾窗防拼合 / flush 收口', () => {
  // 跨 chunk：锚点在前块，命中体在后块
  const r = new StreamRedactor()
  const out1 = r.push('my key is sk-')
  assert.equal(out1.includes('sk-'), false, '疑似锚点起驻留')
  const out2 = r.push('abcdefghijklmnop'.repeat(2))
  const out3 = r.flush()
  assert.equal((out1 + out2 + out3).includes(SECRET), false, '跨 chunk 命中被遮蔽')
  // 假锚点不误遮：'task-' 含锚点子串但不成命中 → flush 原样放行
  const r2 = new StreamRedactor()
  const o1 = r2.push('a task-')
  const o2 = r2.push(' for the job')
  const o3 = r2.flush()
  assert.equal(o1 + o2 + o3, 'a task- for the job', '假锚点原文放行（不误遮）')
  // 无锚点：尾窗驻留防跨 chunk 拼合
  const r3 = new StreamRedactor()
  const p1 = r3.push('plain text without any anchor here!!')
  assert.equal(p1.length, 20, '放行长度 = 输入 36 - 尾窗 16')
  assert.equal(r3.pendingLength, 16)
  assert.equal(r3.flush(), 'ny anchor here!!', 'flush 收口驻留尾（末 16 字符）')
})

test('M8: 遥测默认关——noop 句柄 + 零出站 + 零积累（可机器断言）', async () => {
  const t = createTelemetryFacade(undefined)
  assert.equal(t.enabled, false)
  t.getTracer().startSpan('op').setAttribute('k', 'v').end()
  t.getMeter().createCounter('c').add(1)
  await t.flush()
  await t.shutdown()
  assert.deepEqual(t.stats(), { spansEnded: 0, tracesExported: 0, metricsExported: 0, droppedExports: 0 })
})

test('M8: 遥测显式开——OTLP/HTTP 形状出站 + stats + 端点不可达静默丢弃（BD-05）', async () => {
  const bodies: Array<{ path: string; body: unknown }> = []
  const fetchImpl = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    bodies.push({ path: String(url).replace('https://otel.test', ''), body: JSON.parse(String(init!.body)) })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const t = createTelemetryFacade({ endpoint: 'https://otel.test', serviceName: 'car-test' }, { fetchImpl })
  assert.equal(t.enabled, true)
  const span = t.getTracer().startSpan('chat', { attributes: { model: 'gpt' } })
  assert.match(span.traceId, /^[0-9a-f]{32}$/)
  span.recordException(new Error('boom')).end()
  t.getMeter().createCounter('car_calls').add(2, { result: 'ok' })
  await t.flush()
  const traces = bodies.find(b => b.path === '/v1/traces')!
  assert.ok(traces, 'traces 出站')
  assert.equal((traces.body as { resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }).resource.attributes[0]!.value.stringValue, 'car-test')
  assert.ok(bodies.find(b => b.path === '/v1/metrics'), 'metrics 出站')
  assert.equal(t.stats().tracesExported, 1)
  assert.equal(t.stats().metricsExported, 1)
  // 端点不可达：flush resolve 不 reject（BD-05 静默丢弃）
  const down = createTelemetryFacade({ endpoint: 'https://down.test' }, { fetchImpl: (async () => { throw new Error('unreachable') }) as typeof fetch })
  down.getTracer().startSpan('x').end()
  await down.flush()
  assert.equal(down.stats().droppedExports, 1)
  await down.shutdown()
  // 严格解耦静态断言：telemetry.ts 零 import 自 session/*
  const src = readFileSync(new URL('../src/runtime-core/telemetry.ts', import.meta.url), 'utf-8')
  assert.equal(/from\s+'\.\.\/session/.test(src), false, '遥测与审计日志严格解耦（§3.2.M8.5）')
})

// ==================== 增量 3：chatStep 集成 + openai-compat 适配器 ====================

import { SessionLog } from '../src/session/log.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { createOpenAICompatAdapter } from '../src/runtime-core/llm.ts'
import { CarM8Error } from '../src/runtime-core/errors.ts'

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const OK_DONE = [dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of it) out.push(c)
  return out
}
