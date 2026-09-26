/**
 * M5-S28 · 装载签名门（sigGate + loadPlugins verify 阶段 + ReloadManager 透传）
 *
 * 覆盖（ADR-003 fail-closed 分级 / DEC-1 ② warn 缺省 / S20 §1 零内容计数）：
 *  - warn 缺签：放行 + CAR-W-SIG 横幅（含 fp 指纹）+ confirmed=no 计数
 *  - unsignedAllow：confirmed=yes 改写（显式确认豁免动作），横幅保留
 *  - enforce 缺签：verify FAIL + 空 plugins + 后续 SKIPPED + car_load_total failed
 *  - 有签名验签失败：硬拒绝——unsignedAllow 亦不可放行（ADR-003 第一级）
 *  - 好签名：静默放行，零签名计数
 *  - car_load_total{result=ok} 逐插件计数
 *  - ReloadManager.reload signature 透传（enforce FAIL）
 *  - verifyPluginFile 单文件口径（car run 直载门同源）+ gateDepsFromEnv env 通道映射
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { loadPlugins, ReloadManager } from '../src/load/report.ts'
import { verifyPluginFile, gateDepsFromEnv } from '../src/load/sigGate.ts'
import { createCounters, assertZeroContent } from '../src/telemetry/metrics.ts'
import type { LoadReportVO } from '../src/load/report.ts'

// ==================== fixture（抄 s6 密钥生成 + s20 临时目录模式） ====================

const PLUGIN_BODY = (tool: string) =>
  `export default function apply(api) {\n  api.registerTool({ name: '${tool}', run: async () => 'ok' })\n}\n`

function makePlugin(dir: string, file: string, manifest: Record<string, unknown>, tool: string): string {
  const p = join(dir, file)
  writeFileSync(p, `export const manifest = ${JSON.stringify(manifest)}\n${PLUGIN_BODY(tool)}\n`)
  return p
}

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s24-${name}-`))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } })
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

/** 对插件文件裸字节求 sha256 hex，以 ed25519 签 hex 串 UTF-8 字节，写 sidecar `<file>.minisig` */
function signSidecar(file: string, signKey = privateKey): string {
  const manifestHash = createHash('sha256').update(readFileSync(file)).digest('hex')
  const minisig = sign(null, Buffer.from(manifestHash), signKey).toString('base64')
  writeFileSync(`${file}.minisig`, minisig)
  return manifestHash
}

const stageNames = (r: LoadReportVO) => r.stages.map(s => `${s.stage}:${s.status}`)
const stageOf = (r: LoadReportVO, s: string) => r.stages.find(x => x.stage === s)!
const SIX_OK = ['discover:PASS', 'verify:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS']

// ==================== warn 缺省（DEC-1 ②） ====================

test('S28: warn 缺签——放行 + CAR-W-SIG 横幅含 fp 指纹 + confirmed=no 计数 + 六阶段全 PASS', async () => {
  await withTempDir('warn-unsigned', async (dir) => {
    makePlugin(dir, 'p.ts', { name: 'p', version: '1.0.0' }, 't')
    const c = createCounters()
    const { report, plugins } = await loadPlugins({ source: dir, signature: { onCount: (n, l) => c.onCount(n, l) } })
    assert.deepEqual(stageNames(report), SIX_OK)
    assert.equal(plugins.length, 1)
    const banner = report.warnings.find(w => w.startsWith('CAR-W-SIG'))
    assert.ok(banner, 'unsigned 横幅在位')
    assert.match(banner!, /\[fp:[0-9a-f]{12}\]/, '横幅含 manifestHash 指纹前缀')
    assert.deepEqual(c.snapshot(), { 'car_load_total|result=ok': 1, 'car_unsigned_confirmed|confirmed=no': 1 })
    assert.equal(assertZeroContent(c.snapshot()), true)
  })
})

test('S28: unsignedAllow 显式豁免——confirmed=yes 改写 + 横幅保留（S20 §4 路径②）', async () => {
  await withTempDir('unsigned-allow', async (dir) => {
    makePlugin(dir, 'p.ts', { name: 'p', version: '1.0.0' }, 't')
    const c = createCounters()
    const { report } = await loadPlugins({ source: dir, signature: { unsignedAllow: true, onCount: (n, l) => c.onCount(n, l) } })
    assert.equal(stageOf(report, 'verify').status, 'PASS')
    assert.ok(report.warnings.some(w => w.startsWith('CAR-W-SIG')), '横幅保留不消失')
    assert.deepEqual(c.snapshot(), { 'car_load_total|result=ok': 1, 'car_unsigned_confirmed|confirmed=yes': 1 })
  })
})

// ==================== enforce / 验签失败 fail-closed ====================

test('S28: enforce 缺签——verify FAIL + 空 plugins + 后续 SKIPPED + load_total failed', async () => {
  await withTempDir('enforce-unsigned', async (dir) => {
    makePlugin(dir, 'p.ts', { name: 'p', version: '1.0.0' }, 't')
    const c = createCounters()
    const { report, plugins } = await loadPlugins({ source: dir, signature: { mode: 'enforce', onCount: (n, l) => c.onCount(n, l) } })
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'verify:FAIL', 'parse:SKIPPED', 'validate:SKIPPED', 'topo:SKIPPED', 'register:SKIPPED',
    ])
    const v = stageOf(report, 'verify')
    assert.match(v.error!.reason, /CAR-E-SIG: signature missing/)
    assert.match(v.error!.file, /p\.ts$/)
    assert.equal(plugins.length, 0, 'fail-closed：拒绝即空')
    assert.deepEqual(c.snapshot(), { 'car_load_total|result=failed': 1 })
  })
})

test('S28: 有签名但验签失败——硬拒绝不可配置放行（unsignedAllow 亦不豁免，ADR-003 第一级）', async () => {
  await withTempDir('bad-sig', async (dir) => {
    const f = makePlugin(dir, 'p.ts', { name: 'p', version: '1.0.0' }, 't')
    signSidecar(f)
    // 签名后篡改插件文件 → 指纹失配 → 验签失败
    writeFileSync(f, `export const manifest = { name: 'p', version: '1.0.0' }\n// tampered\n${PLUGIN_BODY('t')}`)
    const { report } = await loadPlugins({ source: dir, signature: { trustRootPublicKey: PUB_B64, unsignedAllow: true } })
    assert.equal(stageOf(report, 'verify').status, 'FAIL')
    assert.match(stageOf(report, 'verify').error!.reason, /signature verification FAILED.*不可配置放行/)
  })
})

test('S28: 好签名（信任根在位）——静默放行，零签名计数、零横幅', async () => {
  await withTempDir('good-sig', async (dir) => {
    const f = makePlugin(dir, 'p.ts', { name: 'p', version: '1.0.0' }, 't')
    signSidecar(f)
    const c = createCounters()
    const { report, plugins } = await loadPlugins({ source: dir, signature: { trustRootPublicKey: PUB_B64, onCount: (n, l) => c.onCount(n, l) } })
    assert.deepEqual(stageNames(report), SIX_OK)
    assert.equal(plugins.length, 1)
    assert.equal(report.warnings.some(w => w.startsWith('CAR-W-SIG')), false)
    // 好签名路径零签名计数；car_load_total 正常计数（register 成功）
    assert.deepEqual(c.snapshot(), { 'car_load_total|result=ok': 1 })
  })
})

test('S28: car_load_total{result=ok} 逐插件计数（S27 采集面分母）', async () => {
  await withTempDir('load-total', async (dir) => {
    makePlugin(dir, 'a.ts', { name: 'a', version: '1.0.0' }, 'ta')
    makePlugin(dir, 'b.ts', { name: 'b', version: '1.0.0' }, 'tb')
    const c = createCounters()
    await loadPlugins({ source: dir, signature: { onCount: (n, l) => c.onCount(n, l) } })
    assert.deepEqual(c.snapshot(), { 'car_load_total|result=ok': 2, 'car_unsigned_confirmed|confirmed=no': 2 })
  })
})

// ==================== ReloadManager 透传 + 单文件门 + env 通道 ====================

test('S28: ReloadManager.reload signature 透传——enforce FAIL 且不残留实例', async () => {
  await withTempDir('reload-sig', async (dir) => {
    const f = makePlugin(dir, 'hot.ts', { name: 'hot', version: '1.0.0' }, 't')
    const mgr = new ReloadManager()
    const r1 = await mgr.reload(f)
    assert.deepEqual(stageNames(r1.report), SIX_OK)
    const r2 = await mgr.reload(f, { signature: { mode: 'enforce' } })
    assert.equal(stageOf(r2.report, 'verify').status, 'FAIL')
    assert.equal(r2.plugins.length, 0)
  })
})

test('S28: verifyPluginFile 单文件口径——car run 直载门同源；他人签名 warn 下同样硬拒绝', async () => {
  await withTempDir('single-file', async (dir) => {
    const f = makePlugin(dir, 'p.ts', { name: 'p', version: '1.0.0' }, 't')
    const g1 = verifyPluginFile(f, { mode: 'warn' })
    assert.equal(g1.allowed, true)
    assert.ok(g1.warning)
    assert.match(g1.manifestHash!, /^[0-9a-f]{64}$/)
    const g2 = verifyPluginFile(f, { mode: 'enforce' })
    assert.equal(g2.allowed, false)
    // 好签名 + 信任根在位 → enforce 静默放行
    signSidecar(f)
    const g3 = verifyPluginFile(f, { mode: 'enforce', trustRootPublicKey: PUB_B64 })
    assert.equal(g3.allowed, true)
    assert.equal(g3.warning, undefined)
    // 信任根失配（他人签名）→ 验签失败硬拒绝（warn 模式也不放行——第一级 fail-closed）
    const { privateKey: other } = generateKeyPairSync('ed25519')
    signSidecar(f, other)
    const g4 = verifyPluginFile(f, { mode: 'warn', trustRootPublicKey: PUB_B64 })
    assert.equal(g4.allowed, false, '验签失败级不受模式影响')
  })
})

test('S28: gateDepsFromEnv env 通道映射（CAR_SIG_ENFORCE / CAR_TRUST_ROOT / CAR_UNSIGNED_ALLOW）', () => {
  const d1 = gateDepsFromEnv({})
  assert.equal(d1.mode, 'warn')
  assert.equal(d1.trustRootPublicKey, undefined)
  assert.equal(d1.unsignedAllow, false)
  const d2 = gateDepsFromEnv({ CAR_SIG_ENFORCE: '1', CAR_TRUST_ROOT: PUB_B64, CAR_UNSIGNED_ALLOW: '1' })
  assert.equal(d2.mode, 'enforce')
  assert.equal(d2.trustRootPublicKey, PUB_B64)
  assert.equal(d2.unsignedAllow, true)
})
