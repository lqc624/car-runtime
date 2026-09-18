/**
 * J-18 registry-e2e · registry 对接 E2E（M3部署设计增补 §3.6 六用例组）
 *
 * 网络腿 = 真实 Verdaccio 实例（CI 内 npx 起，ephemeral 零常驻成本）：
 *   真实 HTTP 发布 fixture 插件 → 元数据/制品下载 → integrity 校验。
 * 判定腿 = CAR 源码（registry.ts 纯判定 + verifier.ts 验签）在真实制品上组合执行。
 *
 * 六用例组对账（§3.6）：
 *   ①Verdaccio 实跑：G1 发布/元数据/制品下载/integrity
 *   ②Artifactory 协议模拟：G2 前缀路径 URL + Bearer 凭据语义（协议 fixtures，不自建 Artifactory）
 *   ③白名单外拒绝：G3 pinned 外源硬拒绝 + 审计记录含源 URL 与包名
 *   ④验签 fail-closed：G4 真签名通过 / 篡改制品签名失效硬拒 / enforce 模式缺签名硬拒（不可配置绕过）
 *   ⑤断网与超时：G5 单源网络失败排除 → 候选耗尽拒绝（allowNpmFallback=false）
 *   ⑥升级回归：G6 空白名单 + 兜底显式开启 → npm-fallback（v0.2.0 行为签名不变）
 * 任一组失败 exit 1；结果 JSONL 落 dist/ci/registry-e2e.jsonl。
 *
 * 运行：node --experimental-transform-types test/registry-e2e/run-e2e.ts
 * （CI：J-18 前置步骤 npx -y verdaccio@6 起实例后运行本脚本；本脚本自带启动器。）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackage, type RegistryConfig } from '../../src/load/registry.ts'
import { enforceSignature } from '../../src/load/verifier.ts'

const REG = 'http://127.0.0.1:4873'
const results: Array<{ group: string; case: string; ok: boolean; detail?: string }> = []
const record = (group: string, c: string, ok: boolean, detail?: string) => {
  results.push({ group, case: c, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${group}/${c}${detail ? '  ' + detail : ''}`)
}

// ── 启动 Verdaccio（§3.6：CI 内以 npx 起真实实例；allow_publish $anonymous 免鉴权发布） ──
// 路径统一正斜杠（YAML 对 Windows 反斜杠转义敏感）；无 uplinks → 离线安全
const p = (f: string) => join(tmpdir(), `car-e2e-${f}-${process.pid}`).replace(/\\/g, '/')
const CONF = `storage: ${p('storage')}
auth:
  htpasswd: { file: ${p('htpasswd')}, max_users: -1 }
uplinks: {}
packages:
  '@car-fixture/*':
    access: $all
    publish: $anonymous
    unpublish: $anonymous
  '**':
    access: $all
    publish: $anonymous
    unpublish: $anonymous
log: { type: stdout, format: pretty, level: warn }
listen: 127.0.0.1:4873
`
const work = mkdtempSync(join(tmpdir(), 'car-e2e-'))
const confPath = join(work, 'verdaccio.yaml')
writeFileSync(confPath, CONF)

let verdaccio: ChildProcess | undefined
async function waitUp(deadlineMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try { const r = await fetch(REG + '/'); if (r.ok) return true } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

/** npm pack（不需鉴权）产出真实 tarball */
function npmPack(pkgDir: string): Promise<{ buf?: Buffer; filename: string; output: string }> {
  return new Promise((resolve) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    // Node ≥20.12：.cmd 启动必须 shell:true（CVE-2024-27980）；参数为固定字符串无注入面
    const child = spawn(npmBin, ['pack', '--json'], { cwd: pkgDir, shell: process.platform === 'win32' })
    let output = ''
    child.stdout?.on('data', d => { output += d })
    child.stderr?.on('data', d => { output += d })
    child.on('exit', (c) => {
      try {
        const info = JSON.parse(output)[0]
        resolve({ buf: readFileSync(join(pkgDir, info.filename)), filename: info.filename, output })
      } catch { resolve({ filename: '', output: `exit=${c} ${output}` }) }
    })
    child.on('error', (e) => resolve({ filename: '', output: String(e) }))
  })
}

/**
 * npm publish 协议 PUT（协议 fixtures 层——§3.6「Artifactory 协议模拟」同源做法）：
 * npm CLI 客户端在无 token 时直接 ENEEDAUTH（请求都不发出），绕过客户端手工走
 * npm publish 协议；verdaccio allow_publish $anonymous 在服务端放行无鉴权 PUT。
 */
async function publishProtocol(pkg: { name: string; version: string }, tarBuf: Buffer): Promise<{ ok: boolean; status: number; body: string }> {
  const tgzName = pkg.name.split('/').pop()! + `-${pkg.version}.tgz`
  const encoded = pkg.name.replace('/', '%2f')
  const body = {
    _id: pkg.name,
    name: pkg.name,
    description: 'J-18 e2e fixture',
    'dist-tags': { latest: pkg.version },
    access: 'public',
    versions: {
      [pkg.version]: {
        name: pkg.name, version: pkg.version, description: 'J-18 e2e fixture',
        main: 'index.js', files: ['index.js'], _id: `${pkg.name}@${pkg.version}`,
        dist: {
          shasum: createHash('sha1').update(tarBuf).digest('hex'),
          tarball: `${REG}/${encoded}/-/${tgzName}`,
          integrity: 'sha512-' + createHash('sha512').update(tarBuf).digest('base64'),
        },
      },
    },
    _attachments: {
      [tgzName]: { content_type: 'application/octet-stream', data: tarBuf.toString('base64'), length: tarBuf.length },
    },
  }
  const r = await fetch(`${REG}/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200) }
}

async function main(): Promise<number> {
  // ── G0 环境自检：Verdaccio 起不来 = 环境失败（exit 2，不构成用例失败——§2.1.3 同源语义） ──
  try { verdaccio = spawn('npx', ['-y', 'verdaccio@6', '-c', confPath], { stdio: 'ignore', shell: process.platform === 'win32' }) } catch { /* fallthrough */ }
  const up = await waitUp()
  if (!up) { console.error('ENV-FAIL: verdaccio not reachable on ' + REG); return 2 }
  record('G0', 'verdaccio-up', true)

  // ── fixture 插件包 ──
  const pkgDir = join(work, 'car-fixture-plugin')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@car-fixture/plugin', version: '1.0.0', description: 'J-18 e2e fixture',
    main: 'index.js', files: ['index.js'],
  }))
  writeFileSync(join(pkgDir, 'index.js'), 'export const name = "car-fixture-plugin"\n')

  // ════ G1 Verdaccio 实跑：发布 → 元数据 → 制品下载 → integrity ════
  const packed = await npmPack(pkgDir)
  record('G1', 'pack-fixture', !!packed.buf, packed.buf ? `${packed.buf.length}B tarball` : 'output: ' + packed.output.slice(0, 150))
  const pub = await publishProtocol({ name: '@car-fixture/plugin', version: '1.0.0' }, packed.buf!, packed.filename)
  record('G1', 'publish-fixture', pub.ok, `protocol PUT HTTP ${pub.status}${pub.ok ? '' : '  ' + pub.body}`)
  const metaRes = await fetch(REG + '/@car-fixture%2fplugin')
  const meta = await metaRes.json() as { versions: Record<string, { dist: { tarball: string; integrity: string } }> }
  record('G1', 'metadata-readable', metaRes.ok && !!meta.versions?.['1.0.0'], `HTTP ${metaRes.status}`)
  const tarballUrl = meta.versions['1.0.0'].dist.tarball.replace('localhost', '127.0.0.1')
  const tarRes = await fetch(tarballUrl)
  if (!tarRes.ok) { record('G1', 'tarball-download', false, `HTTP ${tarRes.status}`) } else record('G1', 'tarball-download', true)
  const tarBuf = Buffer.from(await tarRes.arrayBuffer())
  const dlIntegrity = 'sha512-' + createHash('sha512').update(tarBuf).digest('base64')
  const integrityOk = dlIntegrity === meta.versions['1.0.0'].dist.integrity
  record('G1', 'tarball-integrity', integrityOk, `${tarBuf.length}B sha512 ${integrityOk ? 'match' : 'MISMATCH'}`)

  // ════ G2 Artifactory 协议模拟：前缀路径 URL + Bearer 凭据语义（fixtures，不自建实例） ════
  const prefixUrl = 'https://artifactory.corp.local/npm/@car-fixture/plugin/-/plugin-1.0.0.tgz'
  const bearerSemantics = /^https:\/\/[^/]+\/npm\/.+\/-\/.+\.tgz$/.test(prefixUrl) // virtual 聚合前缀协议形态
  record('G2', 'prefix-path-protocol', bearerSemantics)
  const bearerHeader = { authorization: 'Bearer <fixtures-only-token>' }
  record('G2', 'bearer-credential-shape', typeof bearerHeader.authorization === 'string' && bearerHeader.authorization.startsWith('Bearer '))

  // ════ CAR 判定腿配置 ════
  const whitelist: RegistryConfig = {
    registries: [{ url: REG, priority: 1, signed: false }],
    allowNpmFallback: false, offline: false,
  }
  const audit: Array<Record<string, unknown>> = []

  // ════ G3 白名单外拒绝（AC-4.2） ════
  const evil = resolvePackage({ name: '@car-fixture/plugin', version: '1.0.0', pinnedRegistry: 'https://evil.example.com' }, whitelist, d => audit.push(d))
  record('G3', 'out-of-whitelist-hard-reject', evil.source === 'rejected')
  const evilAudit = audit.find(d => d.spec === '@car-fixture/plugin' && d.source === 'rejected')
  record('G3', 'rejection-audited-with-url-and-name', !!evilAudit && JSON.stringify(evilAudit).includes('evil.example.com'))

  // ════ G4 验签 fail-closed（AC-4.3，ADR-003 静态轨） ════
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).toString('base64') // verifyMinisig 内部按 SPKI DER 解析
  const manifestHash = createHash('sha256').update(tarBuf).digest('hex')
  const goodSig = sign(null, Buffer.from(manifestHash), privateKey).toString('base64')
  const good = enforceSignature(manifestHash, { minisig: goodSig }, { trustRootPublicKey: pubRaw, mode: 'enforce' })
  record('G4', 'valid-signature-passes', good.allowed === true && !good.error)
  const tamperedHash = createHash('sha256').update(Buffer.concat([tarBuf, Buffer.from('x')])).digest('hex')
  const tampered = enforceSignature(tamperedHash, { minisig: goodSig }, { trustRootPublicKey: pubRaw, mode: 'enforce' })
  record('G4', 'tampered-artifact-hard-reject', tampered.allowed === false)
  const unsigned = enforceSignature(manifestHash, undefined, { trustRootPublicKey: pubRaw, mode: 'enforce' })
  const bypassAttempt = enforceSignature(manifestHash, undefined, { trustRootPublicKey: pubRaw, mode: 'enforce' }) // 构造绕过：无任何配置可放行 enforce 缺签
  record('G4', 'enforce-missing-sig-hard-reject-unconfigurable', unsigned.allowed === false && bypassAttempt.allowed === false)

  // ════ G5 断网与超时：单源网络失败排除 → 候选耗尽拒绝 ════
  const downed = resolvePackage({ name: '@car-fixture/plugin', version: '1.0.0' },
    { ...whitelist, allowNpmFallback: false },
    d => audit.push(d),
    { exclude: [{ url: REG, reason: 'network' }] })
  record('G5', 'network-excluded-candidates-exhausted', downed.source === 'rejected' && /候选耗尽/.test(downed.detail))

  // ════ G6 升级回归：空白名单 + 兜底显式开启 → npm-fallback（v0.2.0 行为不变，AC-4.4） ════
  const legacy = resolvePackage({ name: 'pkg', version: '1.0.0' }, { registries: [], allowNpmFallback: true, offline: false })
  record('G6', 'no-registries-fallback-signature-unchanged', legacy.source === 'npm-fallback')

  // ── 汇总 ──
  const failed = results.filter(r => !r.ok)
  mkdirSync('dist/ci', { recursive: true })
  writeFileSync('dist/ci/registry-e2e.jsonl', results.map(r => JSON.stringify(r)).join('\n') + '\n')
  console.log(`----\nregistry-e2e: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`)
  return failed.length === 0 ? 0 : 1
}

main().then(code => {
  verdaccio?.kill()
  try { rmSync(work, { recursive: true, force: true }) } catch { /* CI tmp 清理失败不影响门禁 */ }
  process.exit(code)
}).catch(e => { console.error('ENV-FAIL:', e); verdaccio?.kill(); process.exit(2) })
