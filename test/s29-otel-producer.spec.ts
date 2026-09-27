/**
 * 1.2 · OTLP exporter 生产级策略（S29）：有界重试 / 采样 / 批上限 / env 通道 / mcp-serve meter 桥
 *
 * 覆盖（1.2-迭代规划 W3-3；M8 §4.4 登记后续出清；D-12b 口径修订 0 重试 → 有界 ≤2）：
 *  - 重试：429/5xx/网络错误退避重试（序列 1s/2s 可注入）→ 成功计数；耗尽 droppedExports 静默丢弃；
 *    4xx 业务错不重试；res.ok 语义（旧实现 5xx 也计成功——本代修正为显式状态判定）
 *  - 采样：always_on 缺省行为不变 / always_off 全采出 / ratio 概率边界；spansSampledOut 计数
 *  - 批上限：maxBatchSize 分批（tracesExported 按请求计）/ maxQueueSize 溢出丢最旧 queueOverflows
 *  - env 通道：telemetryConfigFromEnv（endpoint 唯一开关 / sampling 三形态 / 非法值保持缺省）
 *  - 生产调用点：mcp-serve 真进程 CAR_OTEL_ENDPOINT → 本地 http 捕获端点断言 OTLP metrics 出站
 *    （S17 counters 双写桥；快照面不变）；零依赖静态断言保持（telemetry 零 session import）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTelemetryFacade, telemetryConfigFromEnv, type TelemetryConfig } from '../src/runtime-core/telemetry.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

const sleepsOf = (log: number[]) => async (ms: number) => { log.push(ms) }
const okRes = () => ({ ok: true, status: 200 }) as unknown as Response
const statusRes = (status: number) => ({ ok: false, status }) as unknown as Response

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s29-${name}-`))
  try {
    const r = fn(dir)
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } }
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
    return Promise.resolve()
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
    throw e
  }
}

// ==================== env 通道 ====================

test('S29: telemetryConfigFromEnv——endpoint 唯一开关 / sampling 三形态 / 非法值保持缺省 / interval 解析', () => {
  assert.equal(telemetryConfigFromEnv({}), null, '无 endpoint = null（默认关）')
  const c1 = telemetryConfigFromEnv({ CAR_OTEL_ENDPOINT: 'https://otel.internal' })!
  assert.equal(c1.endpoint, 'https://otel.internal')
  assert.equal(c1.sampling, undefined, '缺省采样不写入（= always_on 行为）')
  assert.equal(telemetryConfigFromEnv({ CAR_OTEL_ENDPOINT: 'https://x', CAR_OTEL_SAMPLING: 'always_off' })!.sampling, 'always_off')
  assert.deepEqual(telemetryConfigFromEnv({ CAR_OTEL_ENDPOINT: 'https://x', CAR_OTEL_SAMPLING: '0.25' })!.sampling, { ratio: 0.25 })
  assert.equal(telemetryConfigFromEnv({ CAR_OTEL_ENDPOINT: 'https://x', CAR_OTEL_SAMPLING: 'bogus' })!.sampling, undefined, '非法值保持缺省（禁 fail-hard）')
  assert.equal(telemetryConfigFromEnv({ CAR_OTEL_ENDPOINT: 'https://x', CAR_OTEL_SAMPLING: '1.5' })!.sampling, undefined, '超界 ratio = 非法')
  const c2 = telemetryConfigFromEnv({ CAR_OTEL_ENDPOINT: 'https://x', CAR_OTEL_INTERVAL_MS: '5000', CAR_OTEL_SERVICE_NAME: 'svc' })!
  assert.equal(c2.intervalMs, 5000)
  assert.equal(c2.serviceName, 'svc')
})

// ==================== 有界重试（D-12b 口径） ====================

test('S29: 重试——5xx 退避后成功计数；耗尽 droppedExports 静默丢弃；4xx 不重试直接丢', async () => {
  await withTempDir('retry', async () => {
    const sleeps: number[] = []
    // 500 → 500 → 200：两次退避后成功
    let calls = 0
    const f1 = createTelemetryFacade({ endpoint: 'https://otel', retryBackoffMs: [10, 20], sleep: sleepsOf(sleeps) }, {
      fetchImpl: (async () => (calls++ === 2 ? okRes() : statusRes(500))) as typeof fetch,
    })
    f1.getTracer().startSpan('s').end()
    await f1.flush()
    assert.deepEqual(sleeps, [10, 20], '退避序列可注入且按序生效')
    assert.deepEqual(f1.stats(), { spansEnded: 1, spansSampledOut: 0, tracesExported: 1, metricsExported: 0, droppedExports: 0, queueOverflows: 0 })

    // 恒 429：耗尽 2 次重试（3 次尝试）→ 静默丢弃，flush 不抛错
    let tries = 0
    const f2 = createTelemetryFacade({ endpoint: 'https://otel', retryLimit: 2, retryBackoffMs: [1, 1], sleep: sleepsOf([]) }, {
      fetchImpl: (async () => (tries++, statusRes(429))) as typeof fetch,
    })
    f2.getTracer().startSpan('s').end()
    await f2.flush()
    assert.equal(tries, 3, '1 原始 + 2 重试')
    assert.equal(f2.stats().droppedExports, 1)
    assert.equal(f2.stats().tracesExported, 0)

    // 400 业务错：不重试，立即丢弃
    let tries4xx = 0
    const f3 = createTelemetryFacade({ endpoint: 'https://otel', sleep: sleepsOf([]) }, {
      fetchImpl: (async () => (tries4xx++, statusRes(400))) as typeof fetch,
    })
    f3.getTracer().startSpan('s').end()
    await f3.flush()
    assert.equal(tries4xx, 1, '4xx 不重试')
    assert.equal(f3.stats().droppedExports, 1)

    // 网络错误（fetch throw）：可重试，耗尽后静默
    let netTries = 0
    const f4 = createTelemetryFacade({ endpoint: 'https://otel', retryLimit: 1, retryBackoffMs: [1], sleep: sleepsOf([]) }, {
      fetchImpl: (async () => (netTries++, Promise.reject(new Error('ECONNREFUSED')))) as unknown as typeof fetch,
    })
    f4.getTracer().startSpan('s').end()
    await f4.flush()
    assert.equal(netTries, 2)
    assert.equal(f4.stats().droppedExports, 1)
  })
})

test('S29: res.ok 显式语义——5xx 不再被计为成功（旧实现口径修正的回归钉）', async () => {
  await withTempDir('ok-semantics', async () => {
    const f = createTelemetryFacade({ endpoint: 'https://otel', retryLimit: 0, sleep: sleepsOf([]) }, {
      fetchImpl: (async () => statusRes(503)) as typeof fetch,
    })
    f.getTracer().startSpan('s').end()
    await f.flush()
    assert.equal(f.stats().tracesExported, 0, '非 2xx 不计成功')
    assert.equal(f.stats().droppedExports, 1)
  })
})

// ==================== 采样 ====================

test('S29: 采样——always_on 缺省全量（1.1 行为不变）/ always_off 全采出 / ratio=0 与 1 边界', async () => {
  await withTempDir('sampling', async () => {
    const posts: unknown[] = []
    const mk = (cfg: TelemetryConfig) => createTelemetryFacade({ endpoint: 'https://otel', ...cfg }, {
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => { posts.push(init?.body); return okRes() }) as typeof fetch,
    })
    // always_on（缺省不写 sampling）：全量出站
    const f1 = mk({})
    for (let i = 0; i < 3; i++) f1.getTracer().startSpan(`s${i}`).end()
    await f1.flush()
    assert.equal(f1.stats().spansSampledOut, 0)
    assert.equal(f1.stats().tracesExported, 1)
    // always_off：全采出，零出站
    const f2 = mk({ sampling: 'always_off' })
    for (let i = 0; i < 3; i++) f2.getTracer().startSpan(`s${i}`).end()
    await f2.flush()
    assert.equal(f2.stats().spansSampledOut, 3)
    assert.equal(f2.stats().tracesExported, 0)
    // ratio 0 / 1 边界
    const f3 = mk({ sampling: { ratio: 0 } })
    f3.getTracer().startSpan('s').end()
    assert.equal(f3.stats().spansSampledOut, 1)
    const f4 = mk({ sampling: { ratio: 1 } })
    f4.getTracer().startSpan('s').end()
    assert.equal(f4.stats().spansSampledOut, 0)
  })
})

// ==================== 批上限 ====================

test('S29: 批上限——maxBatchSize 分批（tracesExported 按请求计）/ maxQueueSize 溢出丢最旧', async () => {
  await withTempDir('batch', async () => {
    const bodies: any[] = []
    const f = createTelemetryFacade({ endpoint: 'https://otel', maxBatchSize: 2, maxQueueSize: 5 }, {
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
    })
    for (let i = 0; i < 5; i++) f.getTracer().startSpan(`s${i}`).end()
    await f.flush()
    assert.equal(bodies.length, 3, '5 spans / batch=2 → 3 请求')
    assert.deepEqual(bodies.map(b => b.scopeSpans[0].spans.length), [2, 2, 1])
    assert.equal(f.stats().tracesExported, 3, 'tracesExported 按成功出站请求计数')

    // 溢出丢最旧：queue=3，end 5 个 → 丢最旧 2 个，flush 导出最新 3 个
    const f2 = createTelemetryFacade({ endpoint: 'https://otel', maxQueueSize: 3 }, {
      fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
    })
    for (let i = 0; i < 5; i++) f2.getTracer().startSpan(`s${i}`).end()
    assert.equal(f2.stats().queueOverflows, 2)
    await f2.flush()
    const names = bodies[bodies.length - 1]!.scopeSpans[0].spans.map((s: { name: string }) => s.name)
    assert.deepEqual(names, ['s2', 's3', 's4'], '溢出丢最旧（保留最新）')
  })
})

// ==================== 默认关（noop）不变 ====================

test('S29: 默认关三原则——无 endpoint = noop 零出站（fetch 不被调用）+ stats 全零', async () => {
  await withTempDir('default-off', async () => {
    let called = 0
    const f = createTelemetryFacade(null, { fetchImpl: (async () => (called++, okRes())) as typeof fetch })
    assert.equal(f.enabled, false)
    f.getTracer().startSpan('s').end()
    f.getMeter().createCounter('c').add(1)
    await f.flush()
    await f.shutdown()
    assert.equal(called, 0, '零出站')
    assert.deepEqual(f.stats(), { spansEnded: 0, spansSampledOut: 0, tracesExported: 0, metricsExported: 0, droppedExports: 0, queueOverflows: 0 })
  })
})

// ==================== 零依赖解耦红线（静态断言保持） ====================

test('S29: 严格解耦——telemetry.ts 零 import 自 session/*（静态断言）', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime-core', 'telemetry.ts'), 'utf-8')
  assert.equal(/from\s+'\.\.\/session\//.test(src), false)
  assert.equal(/from\s+'\.\/\.\.\/session\//.test(src), false)
})

// ==================== 生产调用点：mcp-serve meter 桥（真进程 + 本地捕获端点） ====================

test('S29: mcp-serve 生产接线——CAR_OTEL_ENDPOINT 显式开 → S17 counters 双写出站 OTLP metrics（快照面不变）', async () => {
  await withTempDir('mcp-otel', async dir => {
    const bodies: any[] = []
    let done: (v: void) => void = () => {}
    const closed = new Promise<void>(r => { done = r })
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        if (req.url === '/v1/metrics') bodies.push(JSON.parse(body))
        res.writeHead(200).end()
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve'], {
        cwd: dir,
        env: { ...process.env, CAR_OTEL_ENDPOINT: `http://127.0.0.1:${port}`, CAR_OTEL_INTERVAL_MS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', d => { err += d })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's29' } } }) + '\n')
      child.stdin.end()
      child.on('exit', () => done())
      await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error(`mcp-serve 超时\n${err}`)), 20_000))])
      // S17 快照面不变（双写非迁移）
      assert.match(err, /snapshot=/)
      assert.match(err, /zeroContent=true/)
      assert.match(err, /otel=enabled/)
      // OTLP metrics 出站：counter 名 + 零内容 labels 到达用户端点
      assert.ok(bodies.length >= 1, 'metrics POST 到达捕获端点')
      const names = bodies.flatMap(b => b.scopeMetrics[0].metrics.map((m: { name: string }) => m.name))
      assert.ok(names.includes('car_registry_decision'), 'S17 counter 名出站')
      assert.equal(/sk-|ghp_/.test(JSON.stringify(bodies)), false, '出站体无凭据形态（零内容口径）')
    } finally {
      server.close()
    }
  })
})
