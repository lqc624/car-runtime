/**
 * 1.1 · 签名收尾最小集（S26）：plugin-sign CLI / doctor 签名行 + keychain 专测 / 配置文件通道
 *
 * 覆盖（1.1-迭代规划 W2-1/W2-2/W2-3/W2-5）：
 *  - plugin-sign keygen：密钥对可完成签验闭环（与 verifier/sigGate 签验同源）
 *  - plugin-sign sign：与指南 §2 node -e 手工口径字节一致（同私钥同文件 → 同 sidecar）
 *  - plugin-sign CLI 真实子进程：keygen/sign/verify 全链 + 退出码家规（0/1/2）+ 密钥只落运行期临时目录
 *  - doctor 签名检查行 + doctorKeychain/CLI keychain 行专测（M8 §4.6「已接线未专测」补齐）
 *  - car.config.json 配置文件通道：发现/校验/优先级（flag > env > 配置 > 缺省）/fail-visible
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSigningKeypair, signPluginFile } from '../src/load/sign.ts'
import { verifyPluginFile } from '../src/load/sigGate.ts'
import { loadCarConfig, mergeSignatureGate, CONFIG_FILENAME, type CarConfig } from '../src/load/config.ts'
import { doctorKeychain, doctorSignature } from '../src/dx/doctor.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

// ==================== fixture（s24 口径：密钥与签名夹具只落运行期临时目录——R-1） ====================

function makePlugin(dir: string, file: string, tool: string, body = ''): string {
  const p = join(dir, file)
  writeFileSync(p, `export const manifest = { name: 'p', version: '1.0.0' }\nexport default function apply(api) {\n  api.registerTool({ name: '${tool}', run: async () => 'ok' })\n}\n${body}`)
  return p
}

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s26-${name}-`))
  // 同步回调同步执行（失败以正常断言失败呈现，不落入微任务 unhandledRejection）；异步回调经 Promise 收尾后清理
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

/** 真实子进程跑 CLI（E-6 同款 spawn 口径；cwd 注入使密钥/配置文件只落临时目录） */
function car(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, ...args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('exit', code => resolve({ code: code ?? -1, stdout: out, stderr: err }))
  })
}

// ==================== plugin-sign 原语（W2-1） ====================

test('S26: keygen 原语——密钥对完成签验闭环（generateSigningKeypair + signPluginFile 与 verifier/sigGate 同源互验）', () => {
  withTempDir('keygen-primitive', dir => {
    const kp = generateSigningKeypair()
    const f = makePlugin(dir, 'p.ts', 't')
    const r = signPluginFile(f, kp.privateKeyDer)
    assert.match(r.manifestHash, /^[0-9a-f]{64}$/)
    assert.ok(existsSync(r.sidecar), 'sidecar <file>.minisig 在位')
    // 与 s24 signSidecar 同口径验签：enforce + 信任根 → 静默放行
    const g = verifyPluginFile(f, { mode: 'enforce', trustRootPublicKey: kp.publicKeyBase64 })
    assert.equal(g.allowed, true)
    assert.equal(g.warning, undefined)
    // 篡改后同信任根 → 硬拒绝
    writeFileSync(f, readFileSync(f, 'utf-8') + '// tampered\n')
    const g2 = verifyPluginFile(f, { mode: 'enforce', trustRootPublicKey: kp.publicKeyBase64 })
    assert.equal(g2.allowed, false)
    assert.match(g2.error!, /signature verification FAILED/)
  })
})

test('S26: sign 产物与指南 node -e 手工口径字节一致——同私钥同文件产出同 sidecar（签名确定性）', () => {
  withTempDir('sign-equivalence', dir => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
    const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const f = makePlugin(dir, 'p.ts', 't')
    // 指南 §2 第 2 步原样逻辑（node -e 等价实现）
    const manifestHash = createHash('sha256').update(readFileSync(f)).digest('hex')
    const manual = cryptoSign(null, Buffer.from(manifestHash), { key: privDer, format: 'der', type: 'pkcs8' }).toString('base64')
    const r = signPluginFile(f, privDer)
    assert.equal(readFileSync(r.sidecar, 'utf-8'), manual, 'signPluginFile 与手工口径产出逐字节一致')
    assert.equal(verifyPluginFile(f, { mode: 'warn', trustRootPublicKey: pubB64 }).allowed, true)
  })
})

// ==================== plugin-sign CLI（真实子进程） ====================

test('S26: CLI keygen——临时 cwd 产出 .priv/.pub + stdout 信任根；重复生成拒绝、--force 覆盖', async () => {
  await withTempDir('cli-keygen', async dir => {
    const r1 = await car(['plugin-sign', 'keygen'], { cwd: dir })
    assert.equal(r1.code, 0, r1.stderr)
    assert.ok(existsSync(join(dir, 'car-release.priv')), '缺省前缀私钥在位')
    assert.ok(existsSync(join(dir, 'car-release.pub')), '缺省前缀公钥在位')
    assert.match(r1.stdout, /CAR_TRUST_ROOT/)
    const pub = readFileSync(join(dir, 'car-release.pub'), 'utf-8').trim()
    assert.match(pub, /^[A-Za-z0-9+/=]+$/, '公钥为单段 base64（sigGate 读取口径）')
    assert.match(r1.stdout, new RegExp(pub.slice(0, 16)), 'stdout 打印信任根值')

    const r2 = await car(['plugin-sign', 'keygen'], { cwd: dir })
    assert.equal(r2.code, 2, '已存在拒绝覆盖')
    assert.match(r2.stderr, /拒绝覆盖/)
    const r3 = await car(['plugin-sign', 'keygen', '--force'], { cwd: dir })
    assert.equal(r3.code, 0, '--force 显式覆盖')

    const r4 = await car(['plugin-sign', 'keygen', '--out', 'alt'], { cwd: dir })
    assert.equal(r4.code, 0, '--out 自定义前缀')
    assert.ok(existsSync(join(dir, 'alt.priv')) && existsSync(join(dir, 'alt.pub')))

    const r5 = await car(['plugin-sign', 'keygen', '--nope'], { cwd: dir })
    assert.equal(r5.code, 2, '未知选项 exit 2')
  })
})

test('S26: CLI sign + verify 全链——keygen→sign→verify PASS；篡改/缺签 FAIL exit 1；无信任根 exit 2', async () => {
  await withTempDir('cli-sign-verify', async dir => {
    assert.equal((await car(['plugin-sign', 'keygen'], { cwd: dir })).code, 0)
    const f = makePlugin(dir, 'plugin.ts', 't')

    const rs = await car(['plugin-sign', 'sign', 'plugin.ts'], { cwd: dir })
    assert.equal(rs.code, 0, rs.stderr)
    assert.match(rs.stdout, /signed plugin\.ts fp:[0-9a-f]{12}/)
    assert.ok(existsSync(`${f}.minisig`), 'sidecar 相对 cwd 命中同文件')

    const rv = await car(['plugin-sign', 'verify', 'plugin.ts'], { cwd: dir })
    assert.equal(rv.code, 0, rv.stderr)
    assert.match(rv.stdout, /verify: PASS plugin\.ts fp:[0-9a-f]{12}/)
    assert.match(rv.stdout, /信任根来源 pubfile/, '信任根回落到 ./car-release.pub')

    // 篡改 → FAIL exit 1（数据校验失败）
    writeFileSync(f, readFileSync(f, 'utf-8') + '// tampered\n')
    const rv2 = await car(['plugin-sign', 'verify', 'plugin.ts'], { cwd: dir })
    assert.equal(rv2.code, 1)
    assert.match(rv2.stderr, /verify: FAIL plugin\.ts/)
    assert.match(rv2.stderr, /signature verification FAILED/)

    // 重签恢复 → PASS（改文件必须重签口径）
    assert.equal((await car(['plugin-sign', 'sign', 'plugin.ts'], { cwd: dir })).code, 0)
    assert.equal((await car(['plugin-sign', 'verify', 'plugin.ts'], { cwd: dir })).code, 0)

    // 缺签文件 → FAIL exit 1（verify 固定 enforce：缺签即 FAIL）
    makePlugin(dir, 'unsigned.ts', 't2')
    const rv3 = await car(['plugin-sign', 'verify', 'unsigned.ts'], { cwd: dir })
    assert.equal(rv3.code, 1)
    assert.match(rv3.stderr, /signature missing/)

    // 无信任根（无 flag/env/pub 文件——换无 car-release.pub 的子目录 cwd）→ exit 2
    const noTrustDir = join(dir, 'no-trust')
    mkdirSync(noTrustDir)
    const rv4 = await car(['plugin-sign', 'verify', f], { cwd: noTrustDir, env: { CAR_TRUST_ROOT: '' } })
    assert.equal(rv4.code, 2, 'cwd 无 car-release.pub 时显式报无信任根')
    assert.match(rv4.stderr, /无信任根/)

    // --trust-root flag 显式提供 → PASS（flag > env > pubfile 优先级序）
    const pub = readFileSync(join(dir, 'car-release.pub'), 'utf-8').trim()
    const rv5 = await car(['plugin-sign', 'verify', 'plugin.ts', '--trust-root', pub], { cwd: dir })
    assert.equal(rv5.code, 0, rv5.stderr)
    assert.match(rv5.stdout, /信任根来源 flag/)
  })
})

test('S26: CLI sign 输入面——缺私钥文件 exit 2、缺文件参数 exit 2、不可读插件 exit 1、--key 显式路径', async () => {
  await withTempDir('cli-sign-input', async dir => {
    const f = makePlugin(dir, 'p.ts', 't')
    const r1 = await car(['plugin-sign', 'sign', 'p.ts'], { cwd: dir })
    assert.equal(r1.code, 2, '无 car-release.priv → 用法/输入不可用')
    assert.match(r1.stderr, /私钥不可读/)

    const r2 = await car(['plugin-sign', 'sign'], { cwd: dir })
    assert.equal(r2.code, 2, '缺文件参数')

    const kp = generateSigningKeypair()
    const keyPath = join(dir, 'my.priv')
    writeFileSync(keyPath, kp.privateKeyDer)
    const r3 = await car(['plugin-sign', 'sign', 'p.ts', '--key', 'my.priv'], { cwd: dir })
    assert.equal(r3.code, 0, r3.stderr)
    const g = verifyPluginFile(f, { mode: 'enforce', trustRootPublicKey: kp.publicKeyBase64 })
    assert.equal(g.allowed, true, '--key 私钥签名可被对应公钥验证')

    const r4 = await car(['plugin-sign', 'sign', 'missing.ts', '--key', 'my.priv'], { cwd: dir })
    assert.equal(r4.code, 1, '插件文件不可读 = sign 失败（数据面）')
    assert.match(r4.stderr, /sign FAIL missing\.ts/)
  })
})

// ==================== 配置文件通道（W2-3，1.1-S3） ====================

test('S26: 配置发现——cwd 无 car.config.json = 正常态空配置；显式路径必须存在（缺 = CAR-E-CONFIG）', () => {
  withTempDir('config-discovery', dir => {
    const r1 = loadCarConfig({ cwd: dir })
    assert.equal(r1.error, undefined)
    assert.equal(r1.path, undefined, '未发现 = path 缺省（正常态非错误）')
    assert.deepEqual(r1.config, {})
    const r2 = loadCarConfig({ explicitPath: join(dir, 'missing.json'), cwd: dir })
    assert.match(r2.error!, /CAR-E-CONFIG: 配置文件不存在/)
  })
})

test('S26: 配置校验 fail-visible——坏 JSON / 未知顶层键 / 未登记 sandbox 键 / 类型错全部显式拒绝', () => {
  withTempDir('config-fail-visible', dir => {
    const bad = (name: string, content: string) => {
      const p = join(dir, name)
      writeFileSync(p, content)
      const r = loadCarConfig({ explicitPath: p, cwd: dir })
      assert.match(r.error!, /CAR-E-CONFIG/, `${name} 应显式拒绝`)
      return r
    }
    bad('broken.json', '{ sandbox: {')
    bad('toplevel.json', JSON.stringify({ plugins: [] }))
    bad('unknown-sandbox.json', JSON.stringify({ sandbox: { unsigned: { allow: true }, nope: 1 } }))
    bad('unknown-unsigned.json', JSON.stringify({ sandbox: { unsigned: { allow: true, extra: 1 } } }))
    bad('unknown-sig.json', JSON.stringify({ sandbox: { sig: { enforce: true, secret: 'x' } } }))
    bad('type-allow.json', JSON.stringify({ sandbox: { unsigned: { allow: 'yes' } } }))
    bad('type-enforce.json', JSON.stringify({ sandbox: { sig: { enforce: 1 } } }))
    bad('type-trustroot.json', JSON.stringify({ sandbox: { sig: { trustRoot: 42 } } }))
    bad('top-array.json', '[]')
    // 有效配置：冻结键 + 新键全通过
    const pub = generateSigningKeypair().publicKeyBase64
    const good = join(dir, 'good.json')
    writeFileSync(good, JSON.stringify({ sandbox: { unsigned: { allow: true }, sig: { enforce: true, trustRoot: pub } } }))
    const ok = loadCarConfig({ explicitPath: good, cwd: dir })
    assert.equal(ok.error, undefined)
    assert.deepEqual(ok.config, { sandbox: { unsignedAllow: true, sigEnforce: true, sigTrustRoot: pub } })
  })
})

test('S26: 优先级合并 flag > env > 配置 > 缺省——env 显式非 1 压过配置 enforce；env 未定义落配置层', () => {
  const pub = generateSigningKeypair().publicKeyBase64
  // 形状 = 校验器产出（扁平）；类型标注让形状漂移在 tsc 期显式报错（本次接线曾在此处被嵌套手误掩盖）
  const cfg: CarConfig = { sandbox: { sigEnforce: true, sigTrustRoot: pub, unsignedAllow: true } }
  // 缺省（无 env 无配置）= 1.0 行为不变：warn / 无信任根 / 不豁免
  const d = mergeSignatureGate({}, {})
  assert.deepEqual(d, { mode: 'warn', trustRootPublicKey: undefined, unsignedAllow: false })
  // 配置层生效（env 未定义）
  const c = mergeSignatureGate({}, cfg)
  assert.equal(c.mode, 'enforce')
  assert.equal(c.trustRootPublicKey, pub)
  assert.equal(c.unsignedAllow, true)
  // env 显式意见压过配置：CAR_SIG_ENFORCE=0 = 显式 warn
  const e0 = mergeSignatureGate({ CAR_SIG_ENFORCE: '0' }, cfg)
  assert.equal(e0.mode, 'warn')
  // env =1 → enforce；CAR_TRUST_ROOT 压过配置公钥；CAR_UNSIGNED_ALLOW=0 显式关豁免
  const e1 = mergeSignatureGate({ CAR_SIG_ENFORCE: '1', CAR_TRUST_ROOT: 'OTHER', CAR_UNSIGNED_ALLOW: '0' }, cfg)
  assert.equal(e1.mode, 'enforce')
  assert.equal(e1.trustRootPublicKey, 'OTHER')
  assert.equal(e1.unsignedAllow, false)
  // flag 最高：env=0 也压不住 --sig-enforce
  const f = mergeSignatureGate({ CAR_SIG_ENFORCE: '0' }, cfg, true)
  assert.equal(f.mode, 'enforce')
})

test('S26: CLI 配置通道真实消费——car run 经 car.config.json 走 enforce 缺签拒绝（exit 1）+ 坏配置中止（exit 2）', async () => {
  await withTempDir('config-cli-e2e', async dir => {
    makePlugin(dir, 'plugin.ts', 't')
    // car run 直载门消费配置层：enforce + 无签名 → 拒绝 exit 1（生产行为，非仅函数级）
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ sandbox: { sig: { enforce: true } } }))
    const r1 = await car(['run', 'plugin.ts'], { cwd: dir })
    assert.equal(r1.code, 1)
    assert.match(r1.stderr, /签名门禁拒绝.*signature missing/)
    // env 显式 0 压过配置 → warn 放行到装配段
    const r2 = await car(['run', 'plugin.ts', '--demo'], { cwd: dir, env: { CAR_SIG_ENFORCE: '0' } })  // 1.4 D-13：stub 流挂 --demo
    assert.equal(r2.code, 0, r2.stderr)
    assert.match(r2.stdout, /\[1\/5 装配\] OK/)
    // 坏配置 fail-visible 中止（exit 2，不进入装载）
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ sandbox: { unknown: 1 } }))
    const r3 = await car(['run', 'plugin.ts'], { cwd: dir })
    assert.equal(r3.code, 2)
    assert.match(r3.stderr, /CAR-E-CONFIG/)
    // car reload 同源消费：坏显式路径 exit 2
    const r4 = await car(['reload', 'plugin.ts', '--config', 'missing.json'], { cwd: dir })
    assert.equal(r4.code, 2)
    assert.match(r4.stderr, /CAR-E-CONFIG: 配置文件不存在/)
  })
})

// ==================== doctor 签名行 + keychain 专测（W2-2/W2-5，1.1-S2） ====================

test('S26: doctorSignature 三通道——缺省 warn/无信任根/无配置；enforce+信任根可解析；坏信任根显式 invalid', () => {
  withTempDir('doctor-sig', dir => {
    const d1 = doctorSignature({ env: {}, cwd: dir })
    assert.equal(d1.mode, 'warn')
    assert.equal(d1.trustRoot, 'absent')
    assert.equal(d1.configFile, 'absent')
    assert.match(d1.detail, /mode=warn/)
    assert.match(d1.detail, /信任根未配置/)
    const pub = generateSigningKeypair().publicKeyBase64
    const d2 = doctorSignature({ env: { CAR_SIG_ENFORCE: '1', CAR_TRUST_ROOT: pub }, cwd: dir })
    assert.equal(d2.mode, 'enforce')
    assert.equal(d2.trustRoot, 'valid')
    assert.match(d2.detail, /可解析/)
    const d3 = doctorSignature({ env: { CAR_TRUST_ROOT: 'not-a-valid-key' }, cwd: dir })
    assert.equal(d3.trustRoot, 'invalid')
    assert.match(d3.detail, /不可解析.*拒签风险/)
  })
})

test('S26: doctorSignature 配置文件通道——found / invalid 显式呈现；信任根可来自配置层（env 缺省）', () => {
  withTempDir('doctor-sig-config', dir => {
    const pub = generateSigningKeypair().publicKeyBase64
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ sandbox: { sig: { enforce: true, trustRoot: pub } } }))
    const d1 = doctorSignature({ env: {}, cwd: dir })
    assert.equal(d1.mode, 'enforce', '生效模式含配置层')
    assert.equal(d1.trustRoot, 'valid', '配置层信任根参与检查')
    assert.equal(d1.configFile, 'found')
    assert.match(d1.detail, /car\.config\.json（校验通过）/)
    writeFileSync(join(dir, CONFIG_FILENAME), '{"sandbox": { broken')
    const d2 = doctorSignature({ env: {}, cwd: dir })
    assert.equal(d2.configFile, 'invalid')
    assert.equal(d2.mode, 'warn', '坏配置回落 env/缺省口径，invalid 显式呈现')
    assert.match(d2.detail, /配置文件无效/)
  })
})

test('S26: doctorKeychain 专测（M8 §4.6「已接线未专测」补齐）——平台通道三态，缺席显式降级不静默', () => {
  // 能力探测口径（s25 同源）：darwin/linux 读通道构造面在场（调用时才 spawn）；win32 无零依赖读通道 = 显式缺席
  const darwin = doctorKeychain({ platform: 'darwin' })
  assert.equal(darwin.available, true)
  assert.equal(darwin.note, 'darwin security')
  const linux = doctorKeychain({ platform: 'linux' })
  assert.equal(linux.available, true)
  assert.equal(linux.note, 'linux secret-tool')
  const win = doctorKeychain({ platform: 'win32' })
  assert.equal(win.available, false)
  assert.match(win.note, /缺席|显式降级/)
})

test('S26: CLI car doctor——签名行 + keychain 行输出格式（离线 CAR_OFFLINE=1 不失败 exit 0）', async () => {
  const r = await car(['doctor'], { env: { CAR_OFFLINE: '1' } })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^node: /m)
  assert.match(r.stdout, /^signature: mode=(warn|enforce)/m, '1.1 签名行在位')
  assert.match(r.stdout, /^keychain: (就绪|缺席（显式降级）)/m, 'keychain 行格式（M8 口径）')
  assert.match(r.stdout, /^connectivity: SKIPPED/m, '离线显式 SKIPPED')
})
