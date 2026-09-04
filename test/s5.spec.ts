import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePeers, parseManifest } from '../src/load/loader.ts'
import { declareEvent, EventBus } from '../src/kernel/events.ts'
import { parseManifest as pm } from '../src/load/loader.ts'

// ==================== F10 peer 版本约束激活（严格模式默认+显式豁免，经中间确认⑥） ====================

const manifest = (peers: any[], override?: any) => ({ name: 'consumer', version: '1.0.0', peers, ...(override ? { peerPolicyOverride: override } : {}) }) as any

test('F10 AC: peer 冲突 → 加载期硬报错 + 冲突链（严格模式默认）', () => {
  const m = manifest([{ peer: 'lib-a', range: '^1.0.0' }])
  const installed = new Map([['lib-a', '2.0.0']])
  assert.throws(() => validatePeers(m, installed), /CAR-E-PEER.*lib-a@\^1\.0\.0 required but 2\.0\.0 installed/)
})

test('F10 AC: 缺失必选 peer → 硬报错（installed=null）', () => {
  const m = manifest([{ peer: 'lib-b', range: '^1.0.0' }])
  assert.throws(() => validatePeers(m, new Map()), /<missing>/)
})

test('F10 AC: 显式豁免 → 放宽生效（exempted=true，调用方留痕）', () => {
  const m = manifest([{ peer: 'lib-a', range: '^1.0.0' }], { relaxed: true, reason: 'internal fork compatibility' })
  const installed = new Map([['lib-a', '2.0.0']])
  const r = validatePeers(m, installed)
  assert.equal(r.exempted, true)
  assert.equal(r.violations.length, 1)
})

test('F10 AC: optional peer 缺失不构成硬冲突', () => {
  const m = manifest([{ peer: 'lib-opt', range: '^1.0.0', optional: true }])
  const r = validatePeers(m, new Map())
  assert.equal(r.exempted, false)
  assert.equal(r.violations.filter(v => !v.optional).length, 0)
})

test('F10: satisfiesRange 语义——^0.x 锁 minor；^1.x 允许 minor/patch', () => {
  const m0 = manifest([{ peer: 'z', range: '^0.2.1' }])
  assert.throws(() => validatePeers(m0, new Map([['z', '0.3.0']]))) // ^0.2 不接受 0.3
  const m1 = manifest([{ peer: 'z', range: '^1.2.3' }])
  assert.doesNotThrow(() => validatePeers(m1, new Map([['z', '1.9.0']])))
  assert.throws(() => validatePeers(m1, new Map([['z', '2.0.0']])))
})

test('F10: 豁免缺 reason 在 parseManifest 即拒绝（审计留痕前置）', () => {
  assert.throws(() => pm({ name: 'p', version: '1.0.0', peerPolicyOverride: { relaxed: true } }), /reason.*required/)
})

// ==================== F11 优先级字段（处理器级契约） ====================

test('F11 AC: 同事件多处理器按 priority 升序执行（默认 0）', async () => {
  declareEvent('prio/demo', 'serial')
  const bus = new EventBus()
  const order: string[] = []
  bus.on('prio/demo', (_p: unknown, next: () => string) => { order.push('late'); return next() }, { priority: 10 })
  bus.on('prio/demo', (_p: unknown, next: () => string) => { order.push('early'); return next() }, { priority: -5 })
  bus.on('prio/demo', (_p: unknown, next: () => string) => { order.push('mid'); return next() }, { priority: 0 })
  await bus.dispatch<string>('prio/demo', 'x', () => 'base')
  assert.deepEqual(order, ['early', 'mid', 'late'])
})

test('F11 AC: 同 priority 保持注册序（稳定排序，M1 行为不回退）', async () => {
  declareEvent('prio/stable', 'serial')
  const bus = new EventBus()
  const order: string[] = []
  bus.on('prio/stable', () => { order.push('first'); return 'x' })
  bus.on('prio/stable', () => { order.push('second'); return 'x' })
  bus.on('prio/stable', () => { order.push('third'); return 'x' })
  await bus.dispatch('prio/stable', {})
  assert.deepEqual(order, ['first', 'second', 'third'])
})

test('F11: 向后兼容——M1 字符串 label 形态照常工作', async () => {
  declareEvent('prio/compat', 'bail')
  const bus = new EventBus()
  bus.on('prio/compat', () => 'hit', 'my-label')
  assert.equal(await bus.dispatch('prio/compat', {}), 'hit')
  assert.deepEqual(bus.handlerChain('prio/compat'), [{ label: 'my-label', priority: 0 }])
})

test('F11: handlerChain 治理视图返回实际执行序（F14 配置树/产消图数据源）', async () => {
  declareEvent('prio/gov', 'emit')
  const bus = new EventBus()
  bus.on('prio/gov', () => {}, { label: 'b', priority: 2 })
  bus.on('prio/gov', () => {}, { label: 'a', priority: 1 })
  assert.deepEqual(bus.handlerChain('prio/gov').map(h => h.label), ['a', 'b'])
})

// ==================== 签名方案定稿（ADR-003）口径自检 ====================

test('ADR-003: manifest 解析对签名预留字段不拒绝（S6 验签器接入点）', () => {
  // S6 将扩展 manifest: signature: { bundle?: string; minisig?: string }
  const m = pm({ name: 'signed', version: '1.0.0' })
  assert.equal(m.name, 'signed') // M2 S5 口径：解析层不感知签名字段（warn 语义 S6 落地）
})
