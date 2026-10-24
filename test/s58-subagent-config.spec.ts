/**
 * 1.16-K3 · 子 Agent config schema（S58）：llm.subagent 三键登记（D-K2-2）
 *
 * 覆盖：
 *  - 登记键通过：model / maxConcurrent / maxCumulative 单键与组合 → CarConfig 映射形态
 *  - 未登记键拒（fail-visible）：llm.subagent.foo → CAR-E-CONFIG 未知键带路径 +
 *    KEY_SPACES 含 llm.subagent.*（D-1 勘误回归锚点：modelPool 顶层键，不再误写 llm.modelPool.*）
 *  - 值域拒：model 空串（与 llm.model 同文案）/ maxConcurrent·maxCumulative 非正整数
 *    （0 / 小数 / 字符串类型错——s31 锚点口径：消息带路径）
 *  - 空对象拒：llm.subagent: {} = 无意义配置显式拒（禁静默 no-op；提示移除键行为与 1.15.2 一致）
 *  - 无键基线一致：无 subagent 键 → config.llm.subagent 缺省（兼容验收线——与 1.15.2 逐字节一致）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCarConfig } from '../src/load/config.ts'

function withTempDir(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), `car-s58-${name}-`))
  try {
    fn(dir)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
  }
}

/** 写临时 JSON 配置并装载（explicitPath 同步通道——zod 层与 ts 载体共享，s35/s38 已覆盖载体机制） */
function load(dir: string, name: string, cfg: unknown) {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(cfg))
  return loadCarConfig({ explicitPath: p })
}

test('S58: 登记键通过——三键单键与组合映射形态', () => {
  withTempDir('accept', dir => {
    // 组合全键
    let r = load(dir, 'a.json', { llm: { baseUrl: 'https://x/v1', model: 'parent-m', subagent: { model: 'child-m', maxConcurrent: 2, maxCumulative: 5 } } })
    assert.equal(r.error, undefined)
    assert.deepEqual(r.config.llm!.subagent, { model: 'child-m', maxConcurrent: 2, maxCumulative: 5 })
    // 其余 llm 键不受扰（并存形态）
    assert.deepEqual(r.config.llm!.baseUrl, 'https://x/v1')
    // 单键形态：仅 model / 仅护栏
    r = load(dir, 'b.json', { llm: { subagent: { model: 'child-m' } } })
    assert.equal(r.error, undefined)
    assert.deepEqual(r.config.llm!.subagent, { model: 'child-m' })
    r = load(dir, 'c.json', { llm: { subagent: { maxConcurrent: 1 } } })
    assert.equal(r.error, undefined)
    assert.deepEqual(r.config.llm!.subagent, { maxConcurrent: 1 })
  })
})

test('S58: 未登记键拒——路径 + KEY_SPACES（含 D-1 勘误回归锚点）', () => {
  withTempDir('unknown-key', dir => {
    const r = load(dir, 'a.json', { llm: { subagent: { model: 'm', foo: 1 } } })
    assert.match(r.error!, /CAR-E-CONFIG: 未知键 llm\.subagent\.foo/)
    // 键位提示含新键位 llm.subagent.*；modelPool 顶层键勘误后不再出现 llm.modelPool.* 误写
    assert.match(r.error!, /llm\.subagent\.\*/)
    assert.match(r.error!, /modelPool\.\*/)
    assert.doesNotMatch(r.error!, /llm\.modelPool/)
  })
})

test('S58: 值域拒——空串 model / 非正整数护栏（消息带路径，s31 锚点口径）', () => {
  withTempDir('value-domain', dir => {
    let r = load(dir, 'a.json', { llm: { subagent: { model: '  ' } } })
    assert.match(r.error!, /CAR-E-CONFIG: llm\.subagent\.model 必须为非空字符串/)
    r = load(dir, 'b.json', { llm: { subagent: { maxConcurrent: 0 } } })
    assert.match(r.error!, /CAR-E-CONFIG: llm\.subagent\.maxConcurrent 必须为正整数/)
    r = load(dir, 'c.json', { llm: { subagent: { maxCumulative: 1.5 } } })
    assert.match(r.error!, /CAR-E-CONFIG: llm\.subagent\.maxCumulative 必须为正整数/)
    // 类型错（字符串）同为「必须为正整数」文案（invalid_type_error 统一口径）
    r = load(dir, 'd.json', { llm: { subagent: { maxConcurrent: '3' } } })
    assert.match(r.error!, /CAR-E-CONFIG: llm\.subagent\.maxConcurrent 必须为正整数/)
  })
})

test('S58: 空对象拒——禁静默 no-op，提示移除键', () => {
  withTempDir('empty-obj', dir => {
    const r = load(dir, 'a.json', { llm: { subagent: {} } })
    assert.match(r.error!, /CAR-E-CONFIG: llm\.subagent 至少登记一个键/)
    assert.match(r.error!, /移除 llm\.subagent 键/)
    assert.match(r.error!, /行为与 1\.15\.2 一致/)
  })
})

test('S58: 无键基线一致——subagent 缺省不出现（兼容验收线）', () => {
  withTempDir('baseline', dir => {
    let r = load(dir, 'a.json', { llm: { baseUrl: 'https://x/v1', model: 'm', maxTokens: 1024, compaction: { enabled: true } } })
    assert.equal(r.error, undefined)
    assert.equal(r.config.llm!.subagent, undefined)
    assert.deepEqual(r.config.llm, { baseUrl: 'https://x/v1', model: 'm', maxTokens: 1024, compaction: { enabled: true } })
    // 无 llm 键整体缺省
    r = load(dir, 'b.json', { sandbox: { unsigned: { allow: true } } })
    assert.equal(r.error, undefined)
    assert.equal(r.config.llm, undefined)
  })
})
