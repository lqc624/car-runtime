/**
 * 1.3-S1 · 发布制品构建（W4）：本地 release-pipeline.ts 与 CI j16 双端复用的单一事实源
 *
 * 口径（1.3 规划 W4-1/W4-4 / D-14 / D-15）：
 *  - 同一仓树 → 逐字节同制品（git archive HEAD；G-11 教训：哈希对裸字节求）；
 *  - **资产集五件套**（releaseAssetNames 单一事实源——G-10 need-list、CI upload、测试三方同源）：
 *      car-runtime-<v>.tgz / car-runtime-<v>.tgz.sig.bundle / SHA256SUMS / sbom.json / release-audit.jsonl
 *    car-release.pub 自 1.3 移除（D-14：keyless 下验证锚 = bundle 证书 + Rekor，不再是本地公钥）；
 *  - **签名不在此层**（D-15 双轨）：bundle 由签名轨产出——本地 keypair no-tlog（预演态，
 *    release-pipeline G-08）/ CI keyless OIDC+Rekor（正式态，j16）；本脚本只构建与审计；
 *  - 构建审计：CLI 入口（CI 调用形态）写 release-audit.jsonl（archive/sbom/sha256 记录）；
 *    程序化调用（pipeline）经 onRecord 接入调用方审计流。
 *  - 零依赖（node:crypto/fs/child_process）。
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface BuildRecord { stage: string; detail: string; ts: number }

export interface BuildResult {
  tgzPath: string
  sha256: string
  sumsPath: string
  sbomPath: string
  components: number
  bytes: number
  records: BuildRecord[]
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

function walk(dir: string, ext: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(walk(p, ext))
    else if (p.endsWith(ext)) out.push(p)
  }
  return out
}

/** 资产集清单（五件套；D-14：car-release.pub 移除，签名 bundle 由签名轨产出后入列） */
export function releaseAssetNames(version: string): string[] {
  return [
    `car-runtime-${version}.tgz`,
    `car-runtime-${version}.tgz.sig.bundle`,
    'SHA256SUMS',
    'sbom.json',
    'release-audit.jsonl',
  ]
}

export function buildReleaseArtifacts(opts: {
  version: string
  root?: string
  dist?: string
  onRecord?: (stage: string, detail: string) => void
}): BuildResult {
  const root = opts.root ?? new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const dist = opts.dist ?? join(root, 'dist')
  const version = opts.version
  const records: BuildRecord[] = []
  const rec = (stage: string, detail: string) => {
    const r = { stage, detail, ts: Date.now() }
    records.push(r)
    opts.onRecord?.(stage, detail)
  }

  mkdirSync(dist, { recursive: true })
  const tgzPath = join(dist, `car-runtime-${version}.tgz`)
  execSync(`git archive --format=tar.gz -o "${tgzPath}" HEAD`, { cwd: root })
  const bytes = readFileSync(tgzPath)
  rec('archive', `git archive HEAD → car-runtime-${version}.tgz（${bytes.length} bytes，树哈希锚定）`)

  // SHA256SUMS + 自检（G-11 口径：对裸字节求哈希；门禁不可写死为 true——落盘读回复核）
  const sumsPath = join(dist, 'SHA256SUMS')
  writeFileSync(sumsPath, `${sha256(bytes)}  car-runtime-${version}.tgz\n`)
  const [recorded, recordedName] = readFileSync(sumsPath, 'utf-8').trim().split(/\s+/)
  if (recorded !== sha256(bytes) || recordedName !== `car-runtime-${version}.tgz`) {
    throw new Error(`CAR-E-ARTIFACT: SHA256SUMS 自检失败——记录 ${recorded} ≠ 制品裸字节哈希（G-11 教训口径）`)
  }
  rec('sha256sums', `SHA256SUMS ${recorded!.slice(0, 16)}…（裸字节复核通过）`)

  // SBOM（G-05 同构：TS 直跑形态制品清单 + 零运行时依赖）
  const files = [...walk(join(root, 'src'), '.ts'), join(root, 'package.json'), join(root, 'README.md')]
  const sbom = {
    bomFormat: 'CAR-SBOM', specVersion: '0.1', version,
    components: files.map(f => ({ type: 'file', path: f.replace(root, '').replace(/\\/g, '/'), sha256: sha256(readFileSync(f, 'utf-8')) })),
    runtimeDependencies: [],
  }
  const sbomPath = join(dist, 'sbom.json')
  writeFileSync(sbomPath, JSON.stringify(sbom, null, 2))
  rec('sbom', `${files.length} 个组件（运行时依赖 0 项）`)

  return { tgzPath, sha256: sha256(bytes), sumsPath, sbomPath, components: files.length, bytes: bytes.length, records }
}

/** CLI 入口（CI j16 调用形态）：构建 + 写构建审计 release-audit.jsonl（五件套之五） */
function main(): void {
  const version = (JSON.parse(readFileSync(join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'package.json'), 'utf-8')) as { version: string }).version
  const result = buildReleaseArtifacts({ version })
  const auditPath = join(result.tgzPath, '..', 'release-audit.jsonl')
  writeFileSync(auditPath, result.records.map(r => JSON.stringify(r)).join('\n') + '\n')
  console.log(`release artifacts: v${version} → tgz(${result.bytes}B, sha256 ${result.sha256.slice(0, 16)}…) + SHA256SUMS + sbom(${result.components} components) + release-audit.jsonl`)
  console.log(`assets (D-14 五件套): ${releaseAssetNames(version).join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
