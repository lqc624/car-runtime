/**
 * 1.7-S2 · metrics CUMULATIVE 时序语义修正（D-27）：累计基数保持
 *
 * 覆盖（1.7-迭代规划 TELE-2；1.2-S3 起 clear() 与 AGGREGATION_TEMPORALITY_CUMULATIVE 标注矛盾出清）：
 *  - 同计数器双 flush：第二次导出仍为全量累计（5 → 7），非增量（5 → 2）——真 CUMULATIVE；
 *    intervalMs>0 自动导出场景下下游（Prometheus 转换器等）不再解读为总量回落；
 *  - labels 形态与 temporality 标注不变；DELTA 备选不采纳（D-27：生态主流 + S17 计数语义即累计）；
 *  - 内存有界由 label 基数保证（零内容枚举红线——AllowedLabels 3 计数器）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTelemetryFacade } from '../src/runtime-core/telemetry.ts'

const okRes = () => ({ ok: true, status: 200 }) as unknown as Response

test('S40: 累计基数保持——同计数器双 flush 导出全量累计快照（真 CUMULATIVE，非增量）', async () => {
  const bodies: any[] = []
  const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
  })
  const c = f.getMeter().createCounter('car_test_total')
  c.add(5, { result: 'ok' })
  await f.flush()
  c.add(2, { result: 'ok' })
  await f.flush()
  assert.equal(bodies.length, 2, '两次 flush 各一次 metrics 出站')
  const values = bodies.map(b => b.scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt)
  assert.deepEqual(values, [5, 7], '第二次导出 = 累计 7（1.7 前为增量 2——CUMULATIVE 语义错误）')
  for (const b of bodies) {
    const m = b.scopeMetrics[0].metrics[0]
    assert.equal(m.name, 'car_test_total')
    assert.equal(m.sum.aggregationTemporality, 'AGGREGATION_TEMPORALITY_CUMULATIVE')
    const dp = m.sum.dataPoints[0]
    assert.equal(dp.attributes[0].key, 'result', 'labels 形态不变')
    assert.equal(dp.attributes[0].value.stringValue, 'ok')
  }
  assert.equal(f.stats().metricsExported, 2)
})

test('S40: 无新增计数 interval 下重复 flush——全量快照幂等重出（CUMULATIVE 口径正确形态）', async () => {
  const bodies: any[] = []
  const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
  })
  f.getMeter().createCounter('car_load_total').add(3, { result: 'ok' })
  await f.flush()
  await f.flush()
  const values = bodies.map(b => b.scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt)
  assert.deepEqual(values, [3, 3], '无新增 = 同值重出（累计快照，非清零/缺席）')
})

test('S40: 多计数器并存——各自独立累计（互不串值）', async () => {
  const bodies: any[] = []
  const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
  })
  const c1 = f.getMeter().createCounter('car_load_total')
  const c2 = f.getMeter().createCounter('car_registry_decision')
  c1.add(1, { result: 'ok' })
  c2.add(2, { source: 'registry' })
  c1.add(1, { result: 'ok' })
  await f.flush()
  const metrics = bodies[0].scopeMetrics[0].metrics
  assert.equal(metrics.length, 2)
  const byName = Object.fromEntries(metrics.map((m: any) => [m.name, m.sum.dataPoints[0].asInt]))
  assert.deepEqual(byName, { car_load_total: 2, car_registry_decision: 2 })
})
