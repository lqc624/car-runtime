/**
 * 1.7-S1 · OTLP span 语义标准化（D-26）：exception 标准事件 + status / addEvent 标准 events 编码
 *
 * 覆盖（1.7-迭代规划 TELE-1；1.4 遗留「遥测 OTLP 增强」出清主体）：
 *  - recordException → OTel 规范形态：span event（name='exception'，exception.type/exception.message
 *    事件属性 + timeUnixNano）+ span status → STATUS_CODE_ERROR——替换 1.1 起「仅 exception.message
 *    属性 + 恒 UNSET」非标准形态；stacktrace 缺省不出站（D-26 口径：防路径/源码面外泄）
 *  - addEvent → 标准 events 数组编码（name + 原形态属性 + 时刻）——替换 `event.<name>` JSON 属性串
 *  - 出站体加法字段：无事件 span 不出 events 键（空形态合法）；正常 span 恒 STATUS_CODE_UNSET（行为不变面）
 *  - noop 门面零出站不变（默认关三原则；s29/s32 回归由全量保证）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTelemetryFacade } from '../src/runtime-core/telemetry.ts'

const okRes = () => ({ ok: true, status: 200 }) as unknown as Response

function capture() {
  const bodies: any[] = []
  const f = createTelemetryFacade({ endpoint: 'https://otel' }, {
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return okRes() }) as typeof fetch,
  })
  return { f, bodies }
}

const spansOf = (bodies: any[]) => bodies.filter(b => b.scopeSpans).flatMap(b => b.scopeSpans[0].spans)

test('S39: recordException → 标准 exception 事件 + STATUS_CODE_ERROR（stacktrace 不出站）', async () => {
  const { f, bodies } = capture()
  const s = f.getTracer().startSpan('car.step', { attributes: { 'car.step': 1 } })
  s.recordException(new TypeError('boom'))
  s.end('error')
  await f.flush()
  const span = spansOf(bodies)[0]
  assert.equal(span.status.code, 'STATUS_CODE_ERROR', 'recordException → status ERROR（1.7 前恒 UNSET）')
  assert.ok(Array.isArray(span.events) && span.events.length === 1, 'exception 为 span event')
  const ev = span.events[0]
  assert.equal(ev.name, 'exception')
  assert.ok(ev.timeUnixNano, '事件时刻出站')
  const attrs = Object.fromEntries(ev.attributes.map((a: any) => [a.key, a.value.stringValue]))
  assert.equal(attrs['exception.type'], 'TypeError', 'err.name → exception.type')
  assert.equal(attrs['exception.message'], 'boom', 'err.message → exception.message')
  const allKeys = [...span.attributes, ...span.events.flatMap((e: any) => e.attributes)].map((a: any) => a.key)
  assert.equal(allKeys.some((k: string) => /stack/i.test(k)), false, 'stacktrace 缺省不出站（D-26）')
  assert.equal(allKeys.includes('exception.message') && span.attributes.some((a: any) => a.key === 'exception.message'), false,
    'exception.message 不再落于 span attributes（1.1 非标准形态退役）')
})

test('S39: recordException 非 Error 值兜底——type=Error / message=String(err)', async () => {
  const { f, bodies } = capture()
  const s = f.getTracer().startSpan('car.step')
  s.recordException('plain failure')
  s.end('error')
  await f.flush()
  const ev = spansOf(bodies)[0].events[0]
  const attrs = Object.fromEntries(ev.attributes.map((a: any) => [a.key, a.value.stringValue]))
  assert.deepEqual(attrs, { 'exception.type': 'Error', 'exception.message': 'plain failure' })
})

test('S39: addEvent → 标准 events 编码（原形态属性 + 时刻；attributes 不再承载事件）', async () => {
  const { f, bodies } = capture()
  const s = f.getTracer().startSpan('car.turn')
  s.addEvent('cache-hit', { key: 'x', n: 1, flag: true })
  s.end('completed')
  await f.flush()
  const span = spansOf(bodies)[0]
  assert.equal(span.status.code, 'STATUS_CODE_UNSET', '正常 span 恒 UNSET（行为不变面）')
  assert.equal(span.events.length, 1)
  const ev = span.events[0]
  assert.equal(ev.name, 'cache-hit')
  assert.ok(ev.timeUnixNano)
  const map = Object.fromEntries(ev.attributes.map((a: any) => [a.key, a.value]))
  assert.deepEqual(map, { key: { stringValue: 'x' }, n: { doubleValue: 1 }, flag: { boolValue: true } },
    '原形态属性出站（1.7 前为 event.<name>=JSON 串）')
  const attrKeys = span.attributes.map((a: any) => a.key)
  assert.equal(attrKeys.includes('event.cache-hit'), false, 'attributes 不再承载事件（非标准形态退役）')
})

test('S39: 无事件 span 不出 events 键（出站体加法字段——空形态合法）', async () => {
  const { f, bodies } = capture()
  f.getTracer().startSpan('plain').end()
  await f.flush()
  const span = spansOf(bodies)[0]
  assert.equal('events' in span, false, '无事件不出 events 键')
  assert.equal(span.status.code, 'STATUS_CODE_UNSET')
})

test('S39: 多事件按序出站（exception 与 addEvent 混排——事件数组保序）', async () => {
  const { f, bodies } = capture()
  const s = f.getTracer().startSpan('car.step')
  s.addEvent('retry')
  s.recordException(new Error('net'))
  s.addEvent('fallback')
  s.end('completed')
  await f.flush()
  const names = spansOf(bodies)[0].events.map((e: any) => e.name)
  assert.deepEqual(names, ['retry', 'exception', 'fallback'])
  // exception 事件混排下 status 仍 ERROR
  assert.equal(spansOf(bodies)[0].status.code, 'STATUS_CODE_ERROR')
})
