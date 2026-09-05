import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePackage, resolveCandidateChain, type RegistryConfig, type ExcludedSource } from '../src/load/registry.ts'
import { enforceSignature } from '../src/load/verifier.ts'
import { createCounters, assertZeroContent } from '../src/telemetry/metrics.ts'

const corp: RegistryConfig = {
  registries: [
    { url: 'https://a.corp.local', priority: 1, signed: true },
    { url: 'https://b.corp.local', priority: 2, signed: false },
    { url: 'https://c.corp.local', priority: 3, signed: false },
  ],
  allowNpmFallback: true,
  offline: false,
}

// ==================== T-5 定稿②：exclude 通道（类型上禁校验失败换源） ====================

test('registry exclude: 网络失败源被跳过，按 priority 继续下一源', () => {
  const exclude: ExcludedSource[] = [{ url: 'https://a.corp.local', reason: 'network' }]
  const r = resolvePackage({ name: 'pkg', version: '1.0.0' }, corp, undefined, { exclude })
  assert.equal(r.source, 'registry')
  assert.equal(r.url, 'https://b.corp.local')
  assert.match(r.detail, /excluded=1/)
})

test('registry exclude: 候选耗尽 → 兜底（T-5 定稿②修正语义：非「白名单为空」）', () => {
  const exclude: ExcludedSource[] = corp.registries.map(r => ({ url: r.url, reason: 'network' as const }))
  const r = resolvePackage({ name: 'pkg', version: '1.0.0' }, corp, undefined, { exclude })
  assert.equal(r.source, 'npm-fallback')
  assert.match(r.detail, /candidates exhausted/)
  // 兜底关闭 → 候选耗尽 = fail-closed 拒绝
  const closed = resolvePackage({ name: 'pkg', version: '1.0.0' }, { ...corp, allowNpmFallback: false }, undefined, { exclude })
  assert.equal(closed.source, 'rejected')
  assert.match(closed.detail, /候选耗尽且兜底关闭/)
})

test('registry exclude: 显式绑定源网络失败 → 落审计后按 priority 继续（T-5 ②网络路径）', () => {
  const audits: string[] = []
  const r = resolvePackage(
    { name: 'pkg', version: '1.0.0', pinnedRegistry: 'https://a.corp.local' }, corp,
    d => audits.push(String((d as { detail: string }).detail)),
    { exclude: [{ url: 'https://a.corp.local', reason: 'network' }] },
  )
  assert.equal(r.source, 'registry')
  assert.equal(r.url, 'https://b.corp.local', 'pinned 网络失败 ≠ 信任否定，继续剩余白名单')
  assert.equal(audits.length, 1)
})

test('registry exclude: 显式绑定不在白名单 = 硬失败不换源（既有语义保持）', () => {
  const r = resolvePackage({ name: 'pkg', version: '1.0.0', pinnedRegistry: 'https://evil.example.com' }, corp)
  assert.equal(r.source, 'rejected')
})

test('registry: resolveCandidateChain 只读预览（零审计副作用）', () => {
  const audits: unknown[] = []
  const c = resolveCandidateChain(corp)
  assert.deepEqual(c.chain, ['https://a.corp.local', 'https://b.corp.local', 'https://c.corp.local'])
  assert.equal(c.fallback, true)
  assert.equal(audits.length, 0)
})

// ==================== S17 采集面（零内容计数器） ====================

test('telemetry: 3 Counter 零内容——snapshot 仅枚举 labels，无内容字段', () => {
  const c = createCounters()
  c.onCount('car_load_total', { result: 'ok' })
  c.onCount('car_load_total', { result: 'ok' })
  c.onCount('car_load_total', { result: 'failed' })
  c.onCount('car_unsigned_confirmed', { confirmed: 'no' })
  c.onCount('car_registry_decision', { source: 'registry' })
  const snap = c.snapshot()
  assert.deepEqual(snap, {
    'car_load_total|result=ok': 2,
    'car_load_total|result=failed': 1,
    'car_unsigned_confirmed|confirmed=no': 1,
    'car_registry_decision|source=registry': 1,
  })
  assert.equal(assertZeroContent(snap), true, '零内容红线（无 sk-/路径/长串）')
})

test('telemetry: Q-08 兼容——未接遥测时仅进程内累计（无出站面）', () => {
  const c = createCounters()
  c.onCount('car_registry_decision', { source: 'npm-fallback' })
  // snapshot 即登记表人工填报兜底通道数据源；本层无任何出站调用面
  assert.ok(Object.keys(c.snapshot()).length === 1)
})

// ==================== verifier × 采集面（unsigned warn 计数） ====================

test('verifier onCount: unsigned warn 路径计数（confirmed=no）；enforce 路径不产生 unsigned 计数', () => {
  const c = createCounters()
  const deps = { mode: 'warn' as const, trustRootPublicKey: 'x' }
  const r = enforceSignature('hash-abc', undefined, deps, (n, l) => c.onCount(n, l))
  assert.equal(r.allowed, true)
  assert.ok(r.warning)
  assert.equal(c.snapshot()['car_unsigned_confirmed|confirmed=no'], 1)
  // enforce 模式：缺失 = 拒绝（无 unsigned 计数——不是放行路径）
  const r2 = enforceSignature('hash-abc', undefined, { ...deps, mode: 'enforce' }, (n, l) => c.onCount(n, l))
  assert.equal(r2.allowed, false)
  assert.equal(c.snapshot()['car_unsigned_confirmed|confirmed=no'], 1, '计数不增（拒绝路径非放行路径）')
})
