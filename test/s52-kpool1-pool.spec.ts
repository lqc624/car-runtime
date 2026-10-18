/**
 * s52 · K-POOL-1 模型池网关（1.14-S4 / D-42）
 *
 * 断言面（规划 §3 1.14-S4 判据）：
 *  - 降级必落链：首选失败 → fallback 下一候选；routing/decide 事件（selected/reason/retries/attempts）
 *    落链 + 链完整 + 不进模型消息流（model_visible=0，同 usage 纪律）；
 *  - 明文拒绝：endpoint key/apiKey 等明文凭据键显式拒绝（CR-05 专用文案）；keyEnv 非环境变量名拒绝；
 *  - retry 上限：maxAttempts 候选上限；全部耗尽 = providerUnreachable B080001 + exhausted 决策落链；
 *  - 池空回退单端点语义 = 1.13 兼容：无 modelPool 配置 → 零 routing 事件（行为零变化）；
 *  - health 预检：不可达端点跳过（skipped-unhealthy）+ TTL 缓存 + 真实传输 E2E（回环 404=可达）；
 *  - 候选序：priority 升序 → weight 降序 → 登记序；
 *  - keyEnv 凭据：成员级精确候选（仅该变量，缺省表不参与）→ Authorization Bearer 实证；
 *  - 成员改写：req.model 按成员（usage 按成员模型落账）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '../src/session/log.ts'
import { RuntimeCore } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'
import { CarM8Error, providerUnreachable } from '../src/runtime-core/errors.ts'
import { loadCarConfig } from '../src/load/config.ts'
import {
  orderPoolMembers,
  resolveModelPoolMembers,
  probePoolMember,
  createModelPoolAdapter,
  assembleModelPool,
  type PoolMember,
  type RoutingAttempt,
  type RoutingDecision,
} from '../src/load/pool.ts'
import type { LlmAdapter, LlmChunk, LlmRequest } from '../src/runtime-core/types.ts'

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s52-${name}-`))
  try {
    const r = fn(dir)
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理容错 */ } }
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
    return Promise.resolve()
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理容错 */ }
    throw e
  }
}

/** 恒失败成员（首块前抛 providerUnreachable——重试耗尽形态） */
function failingAdapter(id: string, err?: Error): LlmAdapter {
  return { id, chat() { return (async function* () { throw err ?? providerUnreachable('HTTP 500（尝试 3/3）') })() } }
}

/** 服务成员：脚本 chunk 流；记录收到的 req（成员改写断言用） */
function servingAdapter(id: string, chunks: LlmChunk[], seen: LlmRequest[] = []): LlmAdapter {
  return {
    id,
    chat(req: LlmRequest) {
      seen.push(req)
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}

async function collect(s: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = []
  for await (const c of s) out.push(c)
  return out
}

const member = (id: string, extra: Partial<PoolMember> = {}): PoolMember =>
  ({ id, baseUrl: `https://${id}.test/v1`, model: `m-${id}`, adapterId: 'openai-compat', ...extra })

const decideToLog = (log: SessionLog, fallbackTurn = 'T1') => (d: RoutingDecision): void => {
  log.append('runtime', 'routing', d.turnId ?? fallbackTurn, {
    type: 'decide', selected: d.selected, reason: d.reason, retries: d.retries, attempts: d.attempts,
  })
}

const lastRouting = (log: SessionLog): { type: string; selected: string | null; reason: string; retries: number; attempts: RoutingAttempt[] } => {
  const ev = log.events.filter(e => e.kind === 'routing').at(-1)!
  return ev.payload as never
}

// ==================== config schema（zod / CR-05） ====================

test('s52-1 config：modelPool 合法解析（endpoints/probe/maxAttempts + 派生 id + 候选序）', () => {
  withTempDir('valid', dir => {
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
      llm: { maxTokens: 512, allowEnvFallback: true },
      modelPool: {
        endpoints: [
          { id: 'primary', baseUrl: 'https://primary.test/v1', model: 'm-primary', keyEnv: 'PRIMARY_KEY', priority: 1 },
          { id: 'backup', baseUrl: 'https://backup.test', model: 'm-backup', adapterId: 'anthropic', keyEnv: 'BACKUP_KEY', priority: 2 },
        ],
        probe: { enabled: true, timeoutMs: 1000, ttlMs: 5000 },
        maxAttempts: 2,
      },
    }))
    const r = loadCarConfig({ explicitPath: join(dir, 'car.config.json') })
    assert.equal(r.error, undefined)
    const mp = r.config.modelPool!
    assert.equal(mp.endpoints.length, 2)
    assert.deepEqual(mp.probe, { enabled: true, timeoutMs: 1000, ttlMs: 5000 })
    assert.equal(mp.maxAttempts, 2)
    const resolved = resolveModelPoolMembers(mp)
    assert.equal(resolved.error, undefined)
    assert.deepEqual(resolved.members.map(m => m.id), ['primary', 'backup'], 'priority 升序候选序')
  })
})

test('s52-2 明文凭据显式拒绝（CR-05 专用文案，禁只报未知键）', () => {
  withTempDir('plaintext', dir => {
    for (const k of ['key', 'apiKey', 'api_key'] as const) {
      writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
        modelPool: { endpoints: [{ baseUrl: 'https://x.test/v1', model: 'm', [k]: 'sk-plaintext-value' }] },
      }))
      const r = loadCarConfig({ explicitPath: join(dir, 'car.config.json') })
      assert.match(r.error!, /CAR-E-CONFIG/, k)
      assert.match(r.error!, /明文凭据禁入/, k)
    }
  })
})

test('s52-3 keyEnv 必须为环境变量名（明文粘贴 sk-… 形态拒绝）', () => {
  withTempDir('keyenv', dir => {
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
      modelPool: { endpoints: [{ baseUrl: 'https://x.test/v1', model: 'm', keyEnv: 'sk-abc123' }] },
    }))
    const r = loadCarConfig({ explicitPath: join(dir, 'car.config.json') })
    assert.match(r.error!, /CAR-E-CONFIG/)
    assert.match(r.error!, /必须为环境变量名/)
  })
})

test('s52-4 池空 = CAR-E-CONFIG（endpoints 至少一个）+ 端点 id 重复拒绝', () => {
  withTempDir('empty', dir => {
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({ modelPool: { endpoints: [] } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'car.config.json') }).error!, /至少登记一个端点/)
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({
      modelPool: { endpoints: [
        { id: 'ep1', baseUrl: 'https://a.test/v1', model: 'mA' },
        { id: 'ep1', baseUrl: 'https://b.test/v1', model: 'mB' },
      ] },
    }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'car.config.json') }).error!, /重复/)
  })
})

test('s52-5 候选序：priority 升序（缺省 0）→ weight 降序 → 登记序', () => {
  assert.deepEqual(orderPoolMembers([member('a', { priority: 2 }), member('b', { priority: 1 }), member('c')]).map(m => m.id),
    ['c', 'b', 'a'], '缺省 0 在 priority 1/2 之前')
  assert.deepEqual(orderPoolMembers([member('a', { priority: 1, weight: 1 }), member('b', { priority: 1, weight: 5 }), member('c', { priority: 1 })]).map(m => m.id),
    ['b', 'a', 'c'], '同 priority：weight 大者先；无 weight 保持登记序')
  assert.deepEqual(orderPoolMembers([member('a'), member('b'), member('c')]).map(m => m.id),
    ['a', 'b', 'c'], '全缺省 = 登记序')
})

// ==================== 降级必落链（routing/decide） ====================

test('s52-6 降级必落链：首选抛错 → fallback 候选；事件 + 链完整 + 不进消息流；成员 model 改写', async () => {
  const log = new SessionLog('s52-fallback')
  log.append('user', 'user', 'T1', 'hi')
  const seen: LlmRequest[] = []
  const pool = createModelPoolAdapter({
    members: [
      { member: member('ep1'), adapter: failingAdapter('ep1') },
      { member: member('ep2'), adapter: servingAdapter('ep2', [{ delta: 'ok' }, { finishReason: 'stop' }], seen) },
    ],
    probe: { enabled: false },
    onDecide: decideToLog(log),
  })
  const core = new RuntimeCore()
  core.registry.register(pool, { default: true })
  await chatStep({ core, log, turnId: 'T1', model: 'mA', tools: [] })
  const routing = log.events.filter(e => e.kind === 'routing')
  assert.equal(routing.length, 1, '每次决策一条')
  const payload = lastRouting(log)
  assert.equal(payload.type, 'decide')
  assert.equal(payload.selected, 'ep2')
  assert.equal(payload.reason, 'fallback')
  assert.equal(payload.retries, 1)
  assert.deepEqual(payload.attempts, [
    { id: 'ep1', outcome: 'failed', detail: 'CAR-E-LLM-UNREACHABLE' },
    { id: 'ep2', outcome: 'selected' },
  ])
  assert.equal((routing[0]!.payload as { selected?: unknown }).selected, 'ep2')
  assert.equal(log.verifyChain(), null, 'routing 落链后链完整（只追加红线）')
  assert.deepEqual(log.deriveMessages().map(m => m.role), ['user', 'assistant'], 'routing 不进模型消息流（model_visible=0）')
  assert.equal(seen[0]!.model, 'm-ep2', '成员改写：fallback 成员收到自身 model（usage 按成员模型落账）')
})

test('s52-7 首选成功 = primary 决策（retries 0）；单成员池同形态（桌面端点单成员收敛语义）', async () => {
  for (const n of [1, 2]) {
    const log = new SessionLog(`s52-primary-${n}`)
    log.append('user', 'user', 'T1', 'hi')
    const members = [
      { member: member('ep1'), adapter: servingAdapter('ep1', [{ delta: 'ok' }, { finishReason: 'stop' }]) },
      ...(n === 2 ? [{ member: member('ep2'), adapter: failingAdapter('ep2') }] : []),
    ]
    const pool = createModelPoolAdapter({ members, probe: { enabled: false }, onDecide: decideToLog(log) })
    await collect(pool.chat({ model: 'm-ep1', messages: [{ role: 'user', content: 'x' }], tools: [] }))
    const payload = lastRouting(log)
    assert.equal(payload.selected, 'ep1')
    assert.equal(payload.reason, 'primary')
    assert.equal(payload.retries, 0)
    assert.equal(log.verifyChain(), null)
  }
})

test('s52-8 retry 上限：maxAttempts 截断候选；全部耗尽 = exhausted 决策 + B080001 抛出', async () => {
  const log = new SessionLog('s52-exhausted')
  log.append('user', 'user', 'T1', 'hi')
  const pool = createModelPoolAdapter({
    members: [
      { member: member('ep1'), adapter: failingAdapter('ep1') },
      { member: member('ep2'), adapter: failingAdapter('ep2') },
    ],
    probe: { enabled: false },
    maxAttempts: 1, // 候选请求尝试上限 = 1：ep1 失败后不再尝试 ep2
    onDecide: decideToLog(log),
  })
  await assert.rejects(
    () => collect(pool.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })),
    (e: unknown) => e instanceof CarM8Error && e.code === 'B080001',
  )
  const payload = lastRouting(log)
  assert.equal(payload.selected, null)
  assert.equal(payload.reason, 'exhausted')
  assert.equal(payload.retries, 1)
  assert.deepEqual(payload.attempts, [{ id: 'ep1', outcome: 'failed', detail: 'CAR-E-LLM-UNREACHABLE' }],
    'maxAttempts=1 → ep2 未被尝试（上限截断）')
  assert.equal(log.verifyChain(), null)
})

// ==================== health 预检（跳过 + TTL + 真实传输） ====================

test('s52-9 health 预检：不可达跳过（skipped-unhealthy）+ TTL 缓存；ttlMs=0 每请求重探', async () => {
  let probes = 0
  const probeImpl = async (m: Pick<PoolMember, 'baseUrl' | 'adapterId'>, _o?: { timeoutMs?: number }) => {
    probes++
    // 仅 ep1 探测不健康（探测对象为完整成员——按 id 区分）
    return (m as PoolMember).id === 'ep1'
      ? { ok: false, latencyMs: 1, errorCategory: 'network-error' }
      : { ok: true, status: 200, latencyMs: 1 }
  }
  const log = new SessionLog('s52-probe')
  log.append('user', 'user', 'T1', 'hi')
  const pool = createModelPoolAdapter({
    members: [
      { member: member('ep1'), adapter: servingAdapter('ep1', [{ delta: 'x' }, { finishReason: 'stop' }]) },
      { member: member('ep2'), adapter: servingAdapter('ep2', [{ delta: 'ok' }, { finishReason: 'stop' }]) },
    ],
    probe: { enabled: true, ttlMs: 60_000, probeImpl },
    onDecide: decideToLog(log),
  })
  const req: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }
  const first = await collect(pool.chat(req))
  assert.equal(first.find(c => c.delta)?.delta, 'ok', 'ep1 不健康 → ep2 服务')
  const payload = lastRouting(log)
  assert.equal(payload.selected, 'ep2')
  assert.equal(payload.reason, 'fallback', '健康跳过后的选中 = fallback（禁静默）')
  assert.equal(payload.retries, 0, '健康跳过不计降级重试（attempts 全量在册）')
  assert.deepEqual(payload.attempts, [
    { id: 'ep1', outcome: 'skipped-unhealthy', detail: 'network-error' },
    { id: 'ep2', outcome: 'selected' },
  ])
  await collect(pool.chat({ ...req }))
  assert.equal(probes, 2, '首次请求：ep1+ep2 各探一次')
  await collect(pool.chat({ ...req }))
  assert.equal(probes, 2, 'TTL 缓存内第二次请求不重探（防死主端点每请求烧探测预算）')

  // ttlMs=0：每请求重探
  let probes2 = 0
  const pool2 = createModelPoolAdapter({
    members: [{ member: member('ep1'), adapter: servingAdapter('ep1', [{ delta: 'ok' }, { finishReason: 'stop' }]) }],
    probe: { enabled: true, ttlMs: 0, probeImpl: async () => { probes2++; return { ok: true, status: 200, latencyMs: 1 } } },
  })
  await collect(pool2.chat({ ...req }))
  await collect(pool2.chat({ ...req }))
  assert.equal(probes2, 2, 'ttlMs=0 → 每请求重探')
})

test('s52-10 probePoolMember 真实传输：任意状态码=可达（404 ≠ 不健康）；不可达=network-error', async () => {
  const server = createServer((_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  try {
    const h = await probePoolMember({ baseUrl: `http://127.0.0.1:${addr.port}`, adapterId: 'openai-compat' }, { timeoutMs: 2000 })
    assert.equal(h.ok, true, '404 = 传输可达（真实连通性以发消息为准——doctor 先例）')
    assert.equal(h.status, 404)
  } finally {
    await new Promise<void>(r => server.close(() => r()))
  }
  const h2 = await probePoolMember({ baseUrl: 'http://127.0.0.1:1', adapterId: 'openai-compat' }, { timeoutMs: 1000 })
  assert.equal(h2.ok, false, '连接拒绝 = 不健康')
  assert.equal(h2.errorCategory, 'network-error')
})

// ==================== keyEnv 凭据 + 成员落账 ====================

test('s52-11 keyEnv 凭据：成员级精确候选（缺省表不参与）→ Authorization Bearer 实证', async () => {
  const envKey = 'CAR_S52_POOL_KEY'
  const prevKey = process.env[envKey]
  const prevOpenai = process.env.OPENAI_API_KEY
  const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
  process.env[envKey] = 'sk-pool-keyenv-value'
  process.env.OPENAI_API_KEY = 'sk-should-not-be-used'
  delete process.env.CAR_ALLOW_ENV_CREDENTIALS
  try {
    const auth: string[] = []
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    const { adapter } = assembleModelPool({
      pool: { endpoints: [{ id: 'ep1', baseUrl: 'https://cred.test/v1', model: 'mC', keyEnv: envKey }], probe: { enabled: false } },
      credentials: new CredentialService(),
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
        auth.push(String((init?.headers as Record<string, string>)?.authorization ?? ''))
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }) as typeof fetch,
      probe: { enabled: false },
    })
    await collect(adapter.chat({ model: 'x', messages: [{ role: 'user', content: 'x' }], tools: [] }))
    assert.equal(auth[0], 'Bearer sk-pool-keyenv-value', 'keyEnv 精确引用生效')
    assert.match(auth[0]!, /sk-pool-keyenv-value/, 'OPENAI_API_KEY 缺省表未参与（精确候选）')
  } finally {
    if (prevKey === undefined) delete process.env[envKey]; else process.env[envKey] = prevKey
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenai
    if (prevAllow === undefined) delete process.env.CAR_ALLOW_ENV_CREDENTIALS; else process.env.CAR_ALLOW_ENV_CREDENTIALS = prevAllow
  }
})

test('s52-12 成员模型落账：降级后 usage.model = 实际服务成员（真适配器 req.model 改写链）', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
    'data: [DONE]\n\n'
  const sseResponse = (text: string) => new Response(
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  const { adapter } = assembleModelPool({
    pool: { endpoints: [
      { id: 'epA', baseUrl: 'https://dead.test/v1', model: 'mA' },
      { id: 'epB', baseUrl: 'https://live.test/v1', model: 'mB' },
    ], probe: { enabled: false } },
    fetchImpl: (async (u: string | URL) => String(u).includes('dead.test')
      ? new Response('{"error":{"message":"upstream down"}}', { status: 500 })
      : sseResponse(sse)) as unknown as typeof fetch,
    retries: 0, // 首块前 500 → 立即 providerUnreachable（重试耗尽形态）
    sleep: async () => {},
    probe: { enabled: false },
  })
  const chunks = await collect(adapter.chat({ model: 'mA', messages: [{ role: 'user', content: 'x' }], tools: [] }))
  const usage = chunks.find(c => c.usage)?.usage
  assert.ok(usage, 'usage 事实在册')
  assert.equal(usage!.model, 'mB', 'req.model 按成员改写 → usage 按成员模型落账（计量按模型聚合不串账）')
  assert.equal(usage!.adapterId, 'openai-compat')
})

// ==================== 池空回退单端点语义 = 1.13 兼容 ====================

test('s52-13 池空回退单端点 = 1.13 兼容：无 modelPool → 零 routing 事件（行为零变化）', async () => {
  withTempDir('nopool', dir => {
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({ llm: { baseUrl: 'https://x.test/v1', model: 'm' } }))
    const r = loadCarConfig({ explicitPath: join(dir, 'car.config.json') })
    assert.equal(r.error, undefined)
    assert.equal(r.config.modelPool, undefined, '无 modelPool 配置 = 池路由零介入')
  })
  const log = new SessionLog('s52-nopool')
  log.append('user', 'user', 'T1', 'q')
  const core = new RuntimeCore()
  core.registry.register(servingAdapter('fake', [{ delta: 'ok' }, { finishReason: 'stop' }]), { default: true })
  await chatStep({ core, log, turnId: 'T1', model: 'm1', tools: [] })
  assert.equal(log.events.filter(e => e.kind === 'routing').length, 0, '无池 → 零 routing 事件（1.13 行为零变化）')
  assert.equal(log.verifyChain(), null)
})
