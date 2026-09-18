/**
 * M6 验收补充测试（QA 严过关 · s20 缺口补齐）
 *
 * 覆盖 s20 未触及的边界：
 *  - discover：空目录 FAIL / 路径不存在 FAIL / *.spec.ts、*.d.ts 排除规则
 *  - parse：模块导入失败（语法坏文件）→ CAR-E-PARSE
 *  - validate：optional peer 缺失不 FAIL
 *  - topo：peer 依赖环 → CAR-E-DEPCYCLE（register SKIPPED）
 *  - register：DUP 重复插件名 → CAR-E-DUP；erasable 违规 → CAR-E-PTC
 *  - 热重载：epoch 连续 3 次递增；reload 失败后旧实例不复活（不静默回退的另一半）；
 *    并发 reload 基本不变量（epoch 计数 / history / 实例均未失效）
 *  - doctor：CAR_OFFLINE=1 显式离线路径（非仅 skip 注入）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlugins, ReloadManager } from '../src/load/report.ts'
import { doctorConnectivity } from '../src/dx/doctor.ts'
import type { LoadReportVO } from '../src/load/report.ts'

const PLUGIN_BODY = (tool: string) =>
  `export default function apply(api) {\n  api.registerTool({ name: '${tool}', run: async () => 'ok' })\n}\n`

function makePlugin(dir: string, file: string, manifest: Record<string, unknown>, tool: string): string {
  const p = join(dir, file)
  writeFileSync(p, `export const manifest = ${JSON.stringify(manifest)}\n${PLUGIN_BODY(tool)}\n`)
  return p
}

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s21-${name}-`))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } })
}

const stageOf = (r: LoadReportVO, s: string) => r.stages.find(x => x.stage === s)!
const stageNames = (r: LoadReportVO) => r.stages.map(s => `${s.stage}:${s.status}`)

// ==================== discover 边界 ====================

test('M6-s21: 空目录 discover FAIL + 后续阶段 SKIPPED', async () => {
  await withTempDir('empty', async (dir) => {
    const { report } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), [
      'discover:FAIL', 'parse:SKIPPED', 'validate:SKIPPED', 'topo:SKIPPED', 'register:SKIPPED',
    ])
    assert.match(stageOf(report, 'discover').error!.reason, /no \*\.ts plugin files found/)
  })
})

test('M6-s21: 源路径不存在 discover FAIL（文件定位=source）', async () => {
  await withTempDir('missing', async (dir) => {
    const missing = join(dir, 'no-such-dir')
    const { report } = await loadPlugins({ source: missing })
    assert.equal(stageOf(report, 'discover').status, 'FAIL')
    assert.match(stageOf(report, 'discover').error!.reason, /source not found/)
  })
})

test('M6-s21: discover 排除规则——*.spec.ts / *.d.ts / 非 .ts 不进装配', async () => {
  await withTempDir('exclude', async (dir) => {
    makePlugin(dir, 'real.ts', { name: 'real', version: '1.0.0' }, 't')
    writeFileSync(join(dir, 'real.spec.ts'), `export const manifest = { name: 'real-spec', version: '1.0.0' }\n${PLUGIN_BODY('x')}\n`)
    writeFileSync(join(dir, 'types.d.ts'), `export type X = 1\n`)
    writeFileSync(join(dir, 'notes.txt'), 'not a plugin')
    const { report, plugins, order } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), ['discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS'])
    assert.deepEqual(order.map(m => m.name), ['real'])
    assert.equal(plugins.length, 1)
  })
})

// ==================== parse / validate / topo / register 边界 ====================

test('M6-s21: 模块导入失败（语法坏文件）→ parse FAIL CAR-E-PARSE + 文件定位', async () => {
  await withTempDir('syntax', async (dir) => {
    const bad = join(dir, 'broken.ts')
    writeFileSync(bad, `export const manifest = { name: 'broken', version: '1.0.0' }\nexport default function( {\n`)
    const { report } = await loadPlugins({ source: bad })
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'parse:FAIL', 'validate:SKIPPED', 'topo:SKIPPED', 'register:SKIPPED',
    ])
    const parse = stageOf(report, 'parse')
    assert.match(parse.error!.file, /broken\.ts$/)
    assert.match(parse.error!.reason, /CAR-E-PARSE/)
  })
})

test('M6-s21: optional peer 缺失 → validate PASS 不 FAIL', async () => {
  await withTempDir('optional-peer', async (dir) => {
    makePlugin(dir, 'opt.ts', { name: 'opt', version: '1.0.0', peers: [{ peer: 'ghost', range: '^1.0.0', optional: true }] }, 't')
    const { report, plugins } = await loadPlugins({ source: dir })
    assert.equal(stageOf(report, 'validate').status, 'PASS')
    assert.equal(plugins.length, 1)
    assert.equal(stageOf(report, 'validate').conflicts, undefined)
  })
})

test('M6-s21: topo 依赖环 → topo FAIL CAR-E-DEPCYCLE + register SKIPPED', async () => {
  await withTempDir('cycle', async (dir) => {
    makePlugin(dir, 'a.ts', { name: 'a', version: '1.0.0', peers: [{ peer: 'b', range: '^1.0.0' }] }, 'ta')
    makePlugin(dir, 'b.ts', { name: 'b', version: '1.0.0', peers: [{ peer: 'a', range: '^1.0.0' }] }, 'tb')
    const { report, plugins } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:FAIL', 'register:SKIPPED',
    ])
    assert.match(stageOf(report, 'topo').error!.reason, /CAR-E-DEPCYCLE/)
    assert.equal(plugins.length, 0)
  })
})

test('M6-s21: 重复插件名 DUP → register FAIL CAR-E-DUP + 前缀阶段已装配不回滚静默', async () => {
  await withTempDir('dup', async (dir) => {
    makePlugin(dir, 'one.ts', { name: 'dup', version: '1.0.0' }, 't1')
    makePlugin(dir, 'two.ts', { name: 'dup', version: '2.0.0' }, 't2')
    const { report, plugins } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:FAIL',
    ])
    const reg = stageOf(report, 'register')
    assert.match(reg.error!.reason, /CAR-E-DUP/)
    assert.match(reg.error!.reason, /"dup"/)
    // FAIL 短路：已装配前缀保留（不静默吞掉），后续 DUP 项不进
    assert.ok(plugins.length <= 1)
  })
})

test('M6-s21: erasable 违规（enum）→ register FAIL CAR-E-PTC + 文件定位', async () => {
  await withTempDir('erasable', async (dir) => {
    const bad = join(dir, 'non-erasable.ts')
    writeFileSync(bad, `export const manifest = { name: 'ne', version: '1.0.0' }\nexport enum Mode { A = 'a' }\nexport default function apply(api) {}\n`)
    const { report } = await loadPlugins({ source: bad })
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:FAIL',
    ])
    const reg = stageOf(report, 'register')
    assert.match(reg.error!.reason, /CAR-E-PTC/)
    assert.match(reg.error!.file, /non-erasable\.ts$/)
  })
})

test('M6-s21: manifest 命名导出缺省 → 按文件名合成（name/version 兜底口径）', async () => {
  await withTempDir('no-manifest', async (dir) => {
    writeFileSync(join(dir, 'anon.ts'), PLUGIN_BODY('t'))
    const { report, order } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), ['discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS'])
    assert.equal(order[0]!.name, 'anon')
    assert.equal(order[0]!.version, '0.0.1')
  })
})

// ==================== 热重载补充（SQ-05） ====================

test('M6-s21: 连续 3 次 reload——epoch 连续递增 1/2/3、history 累积、当前实例始终可用', async () => {
  await withTempDir('epoch3', async (dir) => {
    const file = join(dir, 'hot.ts')
    const mgr = new ReloadManager()
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      writeFileSync(file, `export const manifest = { name: 'hot', version: '${v}' }\n${PLUGIN_BODY(`tool-${v}`)}`)
      const { report, plugins } = await mgr.reload(file)
      assert.deepEqual(stageNames(report), ['discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS'])
      assert.equal(plugins[0]!.manifest.version, v)
    }
    assert.equal(mgr.epoch, 3)
    assert.equal(mgr.history.length, 3)
    assert.equal(mgr.instances.length, 1)
    assert.equal(mgr.instances[0]!.isInvalidated(), false)
  })
})

test('M6-s21: reload 失败后——旧实例保持 invalidated 不复活（不静默回退）、epoch 仍递增、无残留实例', async () => {
  await withTempDir('no-fallback', async (dir) => {
    const file = join(dir, 'hot.ts')
    writeFileSync(file, `export const manifest = { name: 'hot', version: '1.0.0' }\n${PLUGIN_BODY('t')}`)
    const mgr = new ReloadManager()
    const ok = await mgr.reload(file)
    const oldApi = ok.plugins[0]!.api
    assert.equal(mgr.epoch, 1)
    // 重写为非法 manifest → reload FAIL
    writeFileSync(file, `export const manifest = { name: 'hot', version: 'bad' }\n${PLUGIN_BODY('t')}`)
    const fail = await mgr.reload(file)
    assert.equal(stageOf(fail.report, 'parse').status, 'FAIL')
    assert.equal(mgr.epoch, 2, '失败 reload 也消耗 epoch（缓存键单调，不留脏缓存）')
    assert.equal(mgr.instances.length, 0, '失败后不静默回退到旧实例集')
    // 旧句柄不复活：保持 CAR-INVALIDATED（红线 4：显式失败禁止静默）
    assert.throws(() => oldApi.getRegisteredTools(), /CAR-INVALIDATED/)
    // 修复后可恢复
    writeFileSync(file, `export const manifest = { name: 'hot', version: '1.1.0' }\n${PLUGIN_BODY('t2')}`)
    const fixed = await mgr.reload(file)
    assert.equal(fixed.plugins[0]!.manifest.version, '1.1.0')
    assert.equal(mgr.epoch, 3)
  })
})

test('M6-s21: 并发 reload 基本不变量——epoch=2、history=2、终态实例未失效可用', async () => {
  await withTempDir('concurrent', async (dir) => {
    const file = join(dir, 'hot.ts')
    writeFileSync(file, `export const manifest = { name: 'hot', version: '1.0.0' }\n${PLUGIN_BODY('t')}`)
    const mgr = new ReloadManager()
    const [r1, r2] = await Promise.all([mgr.reload(file), mgr.reload(file)])
    assert.equal(mgr.epoch, 2)
    assert.equal(mgr.history.length, 2)
    for (const r of [r1, r2]) {
      assert.deepEqual(stageNames(r.report), ['discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS'])
    }
    assert.equal(mgr.instances.length, 1)
    assert.equal(mgr.instances[0]!.isInvalidated(), false, '终态实例必须可用（不被并发残留失效）')
    const host: Array<{ name: string }> = []
    mgr.instances[0]!.bindCore({ registerTool: t => { host.push(t) }, getRegisteredTools: () => host })
    assert.deepEqual(mgr.instances[0]!.api.getRegisteredTools().map(t => t.name), ['t'])
  })
})

// ==================== doctor CAR_OFFLINE=1 路径 ====================

test('M6-s21: CAR_OFFLINE=1 → connectivity 显式 SKIPPED（环境变量路径，非仅 skip 注入）', async () => {
  const prev = process.env.CAR_OFFLINE
  process.env.CAR_OFFLINE = '1'
  try {
    const r = await doctorConnectivity({ registryUrl: 'https://should-never-be-fetched.example' })
    assert.equal(r.status, 'SKIPPED')
    assert.match(r.detail, /CAR_OFFLINE=1/)
    assert.equal(r.latencyMs, 0)
  } finally {
    if (prev === undefined) delete process.env.CAR_OFFLINE
    else process.env.CAR_OFFLINE = prev
  }
})
