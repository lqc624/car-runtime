/**
 * s53 · K-S4-1 PluginManager 装载报告面（1.14-S5 / D-43）
 *
 * 断言面（规划 §3 1.14-S5 判据）：
 *  - 真值报告逐阶段断言：loadPlugins 六阶段（discover/verify/parse/validate/topo/register）PASS 链
 *    + LoadReportVO 字段面（installId/startedTime/durationMs/stages/warnings）+ verify/topo 真值
 *    （v0.1 桌面 mountPlugin 组合呈现的 SKIPPED 标注语义退役——桌面 B2 消费结构化 VO）；
 *  - 签名失败 fail-visible：enforce 缺签 → verify FAIL + 后续 SKIPPED + **模块未执行**（全局标记实证）；
 *  - 不签名插件按 strict 度分流：warn = 横幅放行（confirmed=no 计数）；enforce = 硬拒绝（不可配置放行）；
 *  - topo 真值：peer 边拓扑序（order）+ 环 CAR-E-DEPCYCLE + parse FAIL 短路序保持；
 *  - 签名校验挂载点：verifyPluginFile 单文件口径（好签名静默/坏签名硬拒/篡改硬拒）+ ReloadManager 透传；
 *  - 全经 seam 公共 API 驱动（禁深路径 import——窄面完备性反证；node:crypto 签名 fixture 工具除外）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  loadPlugins,
  ReloadManager,
  verifyPluginFile,
  type LoadReportVO,
} from '../src/seam.ts'
import { createCounters, assertZeroContent } from '../src/telemetry/metrics.ts'

// ==================== fixture（s24 密钥/插件模式） ====================

const PLUGIN_BODY = (tool: string) =>
  `export default function apply(api) {\n  api.registerTool({ name: '${tool}', run: async () => 'ok' })\n}\n`

function makePlugin(dir: string, file: string, manifest: Record<string, unknown>, tool: string): string {
  const p = join(dir, file)
  writeFileSync(p, `export const manifest = ${JSON.stringify(manifest)}\n${PLUGIN_BODY(tool)}\n`)
  return p
}

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s53-${name}-`))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理容错 */ } })
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

/** 对插件文件裸字节求 sha256 hex，以 ed25519 签 hex 串 UTF-8 字节，写 sidecar `<file>.minisig`（s24 同口径） */
function signSidecar(file: string, signKey = privateKey): string {
  const manifestHash = createHash('sha256').update(readFileSync(file)).digest('hex')
  const minisig = sign(null, Buffer.from(manifestHash), signKey).toString('base64')
  writeFileSync(`${file}.minisig`, minisig)
  return manifestHash
}

const stageNames = (r: LoadReportVO) => r.stages.map(s => `${s.stage}:${s.status}`)
const stageOf = (r: LoadReportVO, s: string) => r.stages.find(x => x.stage === s)!
const SIX_OK = ['discover:PASS', 'verify:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS']

// ==================== 真值报告逐阶段断言 ====================

test('s53-1 loadPlugins 真值报告：六阶段 PASS 链 + LoadReportVO 字段面 + verify/topo 真值 + 装配可用', async () => {
  await withTempDir('truth', async (dir) => {
    makePlugin(dir, 'alpha.ts', { name: 'alpha', version: '1.0.0' }, 'alpha_tool')
    const c = createCounters()
    const { report, plugins, order } = await loadPlugins({ source: dir, signature: { onCount: (n, l) => c.onCount(n, l) } })
    assert.deepEqual(stageNames(report), SIX_OK, '六阶段全 PASS——verify/topo 真值（非 SKIPPED 组合呈现）')
    assert.equal(plugins.length, 1)
    assert.equal(order.length, 1)
    assert.equal(order[0]!.name, 'alpha')
    // LoadReportVO 字段面（§3.2.M6.3 逐字对齐）
    assert.match(report.installId, /^car-install-/)
    assert.match(report.startedTime, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(report.durationMs >= 0)
    assert.equal(typeof report.stages[0]!.stage, 'string')
    // 装配产物可用：插件工具真注册（bindCore 前为 Stub 期——绑定宿主后冲刷）
    const hostTools: Array<{ name: string; run: (a: unknown) => Promise<unknown> }> = []
    plugins[0]!.bindCore({
      registerTool: t => hostTools.push(t as never),
      getRegisteredTools: () => hostTools as never,
    })
    const tool = hostTools.find(t => t.name === 'alpha_tool')
    assert.ok(tool, '插件工具在册（真值报告伴随真实装配）')
    assert.equal(await tool!.run({}), 'ok')
    assert.deepEqual(c.snapshot(), { 'car_load_total|result=ok': 1, 'car_unsigned_confirmed|confirmed=no': 1 },
      'unsigned 插件 warn 缺签计数（无签名 fixture——零签名轨命中）')
  })
})

test('s53-2 签名失败 fail-visible：enforce 缺签 → verify FAIL + 后续 SKIPPED + 模块未执行', async () => {
  await withTempDir('enforce', async (dir) => {
    // 模块顶层写全局标记——import() 一旦发生即置位；enforce 拒绝 = parse 的 import 不得发生
    const p = join(dir, 'guarded.ts')
    writeFileSync(p, `globalThis.__S53_EXEC__ = true\nexport const manifest = { name: 'guarded', version: '1.0.0' }\nexport default function apply(api) {}\n`)
    const c = createCounters()
    const { report, plugins } = await loadPlugins({ source: dir, signature: { mode: 'enforce', onCount: (n, l) => c.onCount(n, l) } })
    const verify = stageOf(report, 'verify')!
    assert.equal(verify.status, 'FAIL')
    assert.match(verify.error!.reason, /CAR-E-SIG/)
    assert.deepEqual(stageNames(report), ['discover:PASS', 'verify:FAIL', 'parse:SKIPPED', 'validate:SKIPPED', 'topo:SKIPPED', 'register:SKIPPED'],
      'FAIL 短路——后续阶段 SKIPPED（真值定位）')
    assert.equal(plugins.length, 0, '拒绝装载 = 空插件（fail-visible，禁静默降级）')
    assert.equal(globalThis.__S53_EXEC__, undefined, 'verify 先于 import()——恶意/未验签代码未执行（供应链门语义）')
    assert.equal(c.snapshot()['car_load_total|result=failed'], 1)
  })
})

test('s53-3 不签名插件按 strict 度分流：warn = 横幅放行（confirmed=no）；enforce = 硬拒绝', async () => {
  await withTempDir('split', async (dir) => {
    makePlugin(dir, 'plain.ts', { name: 'plain', version: '1.0.0' }, 'plain_tool')
    // warn：放行 + 横幅 + confirmed=no
    const cw = createCounters()
    const rw = await loadPlugins({ source: dir, signature: { onCount: (n, l) => cw.onCount(n, l) } })
    assert.deepEqual(stageNames(rw.report), SIX_OK)
    const banner = rw.report.warnings.find(w => w.startsWith('CAR-W-SIG'))
    assert.ok(banner, 'warn 缺签横幅显式可见')
    assert.deepEqual(cw.snapshot(), { 'car_load_total|result=ok': 1, 'car_unsigned_confirmed|confirmed=no': 1 })
    // enforce：同一插件硬拒绝（enforce 缺签路径 verifier 早退——无 confirmed 计数，s24 口径）
    const ce = createCounters()
    const re = await loadPlugins({ source: dir, signature: { mode: 'enforce', onCount: (n, l) => ce.onCount(n, l) } })
    assert.equal(stageOf(re.report, 'verify')!.status, 'FAIL')
    assert.equal(re.plugins.length, 0)
    assert.deepEqual(ce.snapshot(), { 'car_load_total|result=failed': 1 })
  })
})

test('s53-4 topo 真值：peer 边拓扑序 + 环 = topo FAIL + register SKIPPED', async () => {
  await withTempDir('topo', async (dir) => {
    makePlugin(dir, 'base.ts', { name: 'base', version: '1.0.0' }, 'base_tool')
    makePlugin(dir, 'app.ts', { name: 'app', version: '1.0.0', peers: [{ peer: 'base', range: '^1.0.0' }] }, 'app_tool')
    const { report, order } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), SIX_OK)
    assert.deepEqual(order.map(m => m.name), ['base', 'app'], 'peer 边 → 拓扑序真值')

    // 依赖环：a↔b 互指 → topo FAIL（validate PASS——双双已安装非违规）
    const dir2 = join(dir, 'cycle')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir2)
    makePlugin(dir2, 'a.ts', { name: 'cyc-a', version: '1.0.0', peers: [{ peer: 'cyc-b', range: '^1.0.0' }] }, 'a_tool')
    makePlugin(dir2, 'b.ts', { name: 'cyc-b', version: '1.0.0', peers: [{ peer: 'cyc-a', range: '^1.0.0' }] }, 'b_tool')
    const rc = await loadPlugins({ source: dir2 })
    const topo = stageOf(rc.report, 'topo')!
    assert.equal(topo.status, 'FAIL')
    assert.match(topo.error!.reason, /CAR-E-DEPCYCLE/)
    assert.equal(stageOf(rc.report, 'register')!.status, 'SKIPPED')
    assert.deepEqual(stageNames(rc.report), ['discover:PASS', 'verify:PASS', 'parse:PASS', 'validate:PASS', 'topo:FAIL', 'register:SKIPPED'])
  })
})

test('s53-5 parse FAIL 短路序保持：坏模块 → parse FAIL + validate/topo/register SKIPPED', async () => {
  await withTempDir('parse-fail', async (dir) => {
    writeFileSync(join(dir, 'broken.ts'), 'export const manifest = { name: broken }\n') // 非法语法
    const { report, plugins } = await loadPlugins({ source: dir })
    assert.equal(stageOf(report, 'parse')!.status, 'FAIL')
    assert.deepEqual(stageNames(report), ['discover:PASS', 'verify:PASS', 'parse:FAIL', 'validate:SKIPPED', 'topo:SKIPPED', 'register:SKIPPED'])
    assert.equal(plugins.length, 0)
    assert.ok(stageOf(report, 'parse')!.error!.file, 'FAIL 错误定位含文件')
  })
})

// ==================== 签名校验挂载点（verifyPluginFile + ReloadManager） ====================

test('s53-6 verifyPluginFile 挂载点：好签名静默放行 / 篡改硬拒（unsignedAllow 不可豁免）/ 缺签分流', async () => {
  await withTempDir('mount', async (dir) => {
    const p = makePlugin(dir, 'signed.ts', { name: 'signed', version: '1.0.0' }, 'signed_tool')
    signSidecar(p)
    // 好签名：静默放行（零告警）
    const good = verifyPluginFile(p, { mode: 'enforce', trustRootPublicKey: PUB_B64 })
    assert.equal(good.allowed, true)
    assert.equal(good.warning, undefined)
    assert.match(good.manifestHash!, /^[0-9a-f]{64}$/)
    // 篡改文件（改动不重签）→ 验签失败 = 硬拒绝，unsignedAllow 亦不可放行（ADR-003 第一级）
    writeFileSync(p, `export const manifest = { name: 'signed', version: '1.0.1' }\n${PLUGIN_BODY('signed_tool')}\n`)
    const bad = verifyPluginFile(p, { mode: 'warn', trustRootPublicKey: PUB_B64, unsignedAllow: true })
    assert.equal(bad.allowed, false)
    assert.match(bad.error!, /verification FAILED/)
    // 缺签分流：warn 放行 + 横幅；enforce 硬拒绝
    makePlugin(dir, 'unsigned.ts', { name: 'unsigned', version: '1.0.0' }, 'unsigned_tool')
    const warn = verifyPluginFile(join(dir, 'unsigned.ts'), { mode: 'warn', trustRootPublicKey: PUB_B64 })
    assert.equal(warn.allowed, true)
    assert.match(warn.warning!, /CAR-W-SIG/)
    const en = verifyPluginFile(join(dir, 'unsigned.ts'), { mode: 'enforce', trustRootPublicKey: PUB_B64 })
    assert.equal(en.allowed, false)
    assert.match(en.error!, /signature missing/)
  })
})

test('s53-7 ReloadManager 出面语义：epoch 击穿重载 + signature 透传（enforce FAIL）+ 旧实例 invalidate', async () => {
  await withTempDir('reload', async (dir) => {
    makePlugin(dir, 'r.ts', { name: 'r', version: '1.0.0' }, 'r_tool')
    const mgr = new ReloadManager()
    const first = await mgr.reload(dir, {})
    assert.deepEqual(stageNames(first.report), SIX_OK)
    assert.equal(mgr.instances.length, 1)
    assert.equal(mgr.epoch, 1)
    // 热改后 enforce 缺签 → FAIL 报告（旧实例已失效不回退——加载期显式失败红线）
    makePlugin(dir, 'r.ts', { name: 'r', version: '2.0.0' }, 'r_tool')
    const second = await mgr.reload(dir, { signature: { mode: 'enforce', trustRootPublicKey: PUB_B64 } })
    assert.equal(stageOf(second.report, 'verify')!.status, 'FAIL')
    assert.equal(second.plugins.length, 0)
    assert.equal(mgr.instances.length, 0, 'FAIL 后实例表为空（旧实例已 invalidate）')
    assert.ok(first.plugins[0]!.isInvalidated(), '旧实例 invalidate 生效（CAR-INVALIDATED 语义）')
  })
})
