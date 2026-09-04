import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../src/kernel/context.ts'
import { declareEvent, EventBus } from '../src/kernel/events.ts'
import { dumpAssembly, dumpEventGraph } from '../src/governance/dump.ts'
import { exportForensicsBundle, verifyBundle, complianceStatement, FIELD_STANDARD_MAP, AUDIT_FIELDS } from '../src/session/export.ts'
import { SessionLog } from '../src/session/log.ts'

// ==================== F14 治理视图 ====================

test('F14: 配置树 dump——插件/依赖/服务/副作用计数完整', () => {
  const ctx = new Context()
  ctx.plugin({ name: 'db', apply: (c) => { c.provide('conn', { url: 'x' }); c.effect(() => () => {}, 'timer') } })
  ctx.plugin({ name: 'api', inject: ['conn'], apply: () => {} })
  const tree = dumpAssembly(ctx)
  const db = tree.plugins.find(p => p.name === 'db')!
  assert.equal(db.state, 'ACTIVE')
  assert.deepEqual(db.provides, ['conn'])
  assert.equal(db.effects, 1)
  assert.deepEqual(db.effectLabels, ['timer'])
  const api = tree.plugins.find(p => p.name === 'api')!
  assert.deepEqual(api.inject, ['conn'])
  assert.ok(tree.services.some(s => s.name === 'conn' && s.provider === 'db'))
  assert.equal(tree.pending.length, 0)
})

test('F14: 产消图——目录 × handlerChain，priority 执行序', () => {
  declareEvent('gov/e', 'serial')
  const bus = new EventBus()
  bus.on('gov/e', () => {}, { label: 'low', priority: 10 })
  bus.on('gov/e', () => {}, { label: 'high', priority: -1 })
  const { events, edges } = dumpEventGraph(bus, new Map([['gov/e', { mode: 'serial' }]]))
  assert.equal(events[0].mode, 'serial')
  assert.deepEqual(events[0].consumers.map(c => c.label), ['high', 'low']) // 实际执行序
  assert.equal(edges.filter(e => e.direction === 'producer').length, 1)
  assert.equal(edges.filter(e => e.direction === 'consumer').length, 2)
})

// ==================== F15 合规导出增强 ====================

function sampleLog(): SessionLog {
  const log = new SessionLog()
  log.append('user', 'user', 'T1', { text: 'hi' })
  log.append('model', 'toolCall', 'T1', { id: 'c1', tool: 't' })
  log.append('model', 'toolResult', 'T1', { id: 'c1', result: 'ok' })
  log.append('runtime', 'turnEnd', 'T1', null, { reason: 'completed' })
  return log
}

test('F15: 取证包——逐文件 SHA-256 + 链锚点 + 审计元数据', () => {
  const log = sampleLog()
  const bundle = exportForensicsBundle(log, {
    sessionId: 'S1', exportedBy: 'alice', exportedAt: '2026-09-04T14:00:00Z',
    runtimeVersion: '0.1.0', sessionRange: { fromSeq: 0, toSeq: 3 },
  })
  assert.equal(bundle.manifest.format, 'car-forensics/1')
  assert.equal(bundle.manifest.verifyChainAtExport, 'PASS')
  assert.equal(bundle.manifest.eventCount, 4)
  assert.ok(bundle.manifest.chainTail)
  assert.equal(bundle.files.length, 2)
  assert.ok(bundle.files.some(f => f.name === 'manifest.json'))
  assert.equal(verifyBundle(bundle).ok, true)
})

test('F15: 篡改文件 → verifyBundle 拒绝；断链 → 导出中止', () => {
  const log = sampleLog()
  const bundle = exportForensicsBundle(log, { sessionId: 'S', exportedBy: 'a', exportedAt: 'x', runtimeVersion: 'v', sessionRange: { fromSeq: 0, toSeq: 3 } })
  bundle.files[0].content = bundle.files[0].content.replace('"hi"', '"HACKED"')
  const v = verifyBundle(bundle)
  assert.equal(v.ok, false)
  assert.equal(v.brokenFile, bundle.files[0].name)
  // 断链导出中止
  const log2 = sampleLog()
  ;(log2.events as any)[1].payload = { tampered: true }
  assert.throws(() => exportForensicsBundle(log2, { sessionId: 'S', exportedBy: 'a', exportedAt: 'x', runtimeVersion: 'v', sessionRange: { fromSeq: 0, toSeq: 3 } }), /CAR-E-EXPORT/)
})

test('T-7: 三标分层——字段映射与核心字段不可裁剪', () => {
  assert.equal(AUDIT_FIELDS.length, 13)
  for (const std of ['soc2', 'gdpr', 'mlps'] as const) {
    const s = complianceStatement(std)
    assert.ok(s.fields.length >= 6, `${std} 字段集非空`)
    assert.equal(s.coreMissing.length, 0, `${std} 不可裁剪核心字段必须全含（9 核心字段三标并集设计保证）`)
    assert.ok(s.statement.length > 40)
  }
  // 等保 b) 条四要素：日期时间/用户/事件类型/是否成功 均在 mlps 字段集
  const mlps = complianceStatement('mlps').fields
  for (const f of ['ts', 'actor', 'eventType', 'result/status']) assert.ok(mlps.includes(f), `等保 b) 要素 ${f}`)
})
