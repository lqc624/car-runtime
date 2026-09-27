/**
 * 1.3 · 发布资产自动化（S30）：release-artifacts.ts 制品构建 + release.yml 结构校验
 *
 * 覆盖（1.3-迭代规划 W4-1/W4-3/W4-4；防幽灵门禁——CI 新步骤必须有本地可验证断言）：
 *  - buildReleaseArtifacts：五件套构建（dist 注入临时目录）、SHA256SUMS 裸字节自检（G-11 口径）、
 *    SBOM 同构（G-05 口径）、构建审计行完整、sha256 与外部 sha256sum 口径一致
 *  - releaseAssetNames 单一事实源：五件套、**不含 car-release.pub**（D-14 资产集迁移钉死）
 *  - release.yml 结构断言：contents: write / id-token: write / cosign keyless（--yes + bundle）/
 *    gh release upload --clobber / npm publish --provenance / **upload 先于 publish**（W4 步骤序红线）/
 *    cosign-installer 钉版（R-4）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReleaseArtifacts, releaseAssetNames } from '../scripts/release-artifacts.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s30-${name}-`))
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

test('S30: buildReleaseArtifacts——五件套之四件落盘（bundle 由签名轨产出）+ SHA256SUMS 裸字节自检', () => {
  withTempDir('build', dir => {
    const records: Array<{ stage: string; detail: string }> = []
    const r = buildReleaseArtifacts({
      version: '0.0.0-s30test',
      dist: dir,
      onRecord: (stage, detail) => records.push({ stage, detail }),
    })
    // 制品在位
    assert.ok(existsSync(r.tgzPath), 'tgz 在位')
    assert.ok(existsSync(r.sumsPath), 'SHA256SUMS 在位')
    assert.ok(existsSync(r.sbomPath), 'sbom.json 在位')
    // G-11 口径：外部 sha256sum 可验证（裸字节哈希）
    const bytes = readFileSync(r.tgzPath)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), r.sha256)
    assert.equal(readFileSync(r.sumsPath, 'utf-8'), `${r.sha256}  car-runtime-0.0.0-s30test.tgz\n`)
    assert.match(readFileSync(r.sumsPath, 'utf-8').trim(), /^[0-9a-f]{64}  car-runtime-0\.0\.0-s30test\.tgz$/)
    // G-05 同构：SBOM 组件面 + 零运行时依赖
    const sbom = JSON.parse(readFileSync(r.sbomPath, 'utf-8')) as { bomFormat: string; components: unknown[]; runtimeDependencies: unknown[] }
    assert.equal(sbom.bomFormat, 'CAR-SBOM')
    assert.ok(sbom.components.length >= 10, 'src/*.ts + package.json + README')
    assert.deepEqual(sbom.runtimeDependencies, [], '零运行时依赖红线')
    // 构建审计完整（archive / sha256sums / sbom 三段记录）
    assert.deepEqual(records.map(x => x.stage), ['archive', 'sha256sums', 'sbom'])
    assert.equal(r.bytes, bytes.length)
  })
})

test('S30: releaseAssetNames 单一事实源——五件套（D-14：car-release.pub 移除，bundle 在列）', () => {
  const names = releaseAssetNames('9.9.9')
  assert.deepEqual(names, [
    'car-runtime-9.9.9.tgz',
    'car-runtime-9.9.9.tgz.sig.bundle',
    'SHA256SUMS',
    'sbom.json',
    'release-audit.jsonl',
  ])
  assert.equal(names.includes('car-release.pub'), false, 'D-14 资产集迁移：公钥不再是验证锚')
})

test('S30: G-10/CI/测试三方同源——pipeline 引用 releaseAssetNames（静态断言防漂移，R-3）', () => {
  const pipeline = readFileSync(join(ROOT, 'scripts', 'release-pipeline.ts'), 'utf-8')
  assert.match(pipeline, /import \{ buildReleaseArtifacts, releaseAssetNames \} from '\.\/release-artifacts\.ts'/)
  assert.match(pipeline, /releaseAssetNames\(VERSION\)/, 'G-10 need-list 改引单一事实源')
  // car-release.pub 在本地预演轨 keypair 验签（keysDir）合法存在——D-15 双轨；资产清单面已由 releaseAssetNames 收口
  // G-11 保留独立复核（门禁不写死为 true）
  assert.match(pipeline, /S6-制品封装/)
  assert.match(pipeline, /S2 产出独立复核/)
})

// ==================== release.yml 结构校验（W4-2 防幽灵门禁） ====================

const yml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf-8')

test('S30: release.yml 权限面——contents: write（上传需要）+ id-token: write（keyless 凭据）', () => {
  const permBlock = yml.slice(yml.indexOf('permissions:'), yml.indexOf('jobs:'))
  assert.match(permBlock, /contents:\s*write/)
  assert.match(permBlock, /id-token:\s*write/)
})

test('S30: release.yml 步骤面——构建/签名/上传/publish 四段齐备且序正确（upload 先于 publish）', () => {
  // 四段关键词
  assert.match(yml, /node --experimental-transform-types scripts\/release-artifacts\.ts/, '构建步骤调单一事实源脚本')
  assert.match(yml, /sigstore\/cosign-installer@v3\.7\.0/, 'cosign 钉版（R-4）')
  assert.match(yml, /cosign sign-blob --yes --bundle/, 'keyless 签名（--yes 免交互 + bundle 产出）')
  assert.match(yml, /gh release upload "\$VERSION" "\$f" --clobber/, '五件套上传（--clobber 幂等；目标=版本号——D-14 裸 tag 形态）')
  assert.match(yml, /npm publish --provenance --tag "\$TAG"/, 'publish 步骤不变（provenance 口径）')
  // 步骤序红线：upload 步在 publish 步之前（上传失败 job 红，publish 不带病出街）
  const uploadAt = yml.indexOf('gh release upload')
  const publishAt = yml.indexOf('npm publish --provenance')
  assert.ok(uploadAt > -1 && publishAt > -1 && uploadAt < publishAt, 'upload 先于 publish（W4 步骤序红线）')
  // 签名记录追加进构建审计（五件套之五的内容完整性）
  assert.match(yml, /release-audit\.jsonl/, '审计文件在签名步被追加')
})

test('S30: release.yml 解析安全——name 行不得含未引号冒号（1.3-BUG-2：`name: x (y: z)` 令 YAML 解析崩溃，release 事件静默失效）', () => {
  // startup failure 形态：run.name = 文件路径、jobs 为空、release 事件不触发——结构断言在此钉死本失败类
  const offenders = yml.split('\n').filter(l => /^\s*- name: [^'"].*:\s/.test(l))
  assert.deepEqual(offenders, [], `以下 step name 含未引号冒号+空格：${JSON.stringify(offenders)}`)
  // 上传目标 = 包版本号（D-14 裸 tag：release tag == version；dispatch 触发亦可用）
  assert.match(yml, /gh release upload "\$VERSION" "\$f" --clobber/)
})

test('S30: release.yml keyless 验证口径——sign-blob 无 --key（keyless 非 keypair）', () => {
  // 正式轨不得使用本地 keypair（私钥不出本地红线）；keypair 仅存在于本地预演轨 release-pipeline.ts
  const signStep = yml.slice(yml.indexOf('cosign sign-blob'))
  assert.doesNotMatch(signStep, /--key/, 'CI 签名步无 keypair 材料')
  assert.doesNotMatch(yml, /car-release\.key|COSIGN_PASSWORD/, 'CI 无本地私钥/口令引用')
  const pipeline = readFileSync(join(ROOT, 'scripts', 'release-pipeline.ts'), 'utf-8')
  assert.match(pipeline, /car-release\.key/, '本地预演轨保留 keypair（D-15 双轨语义）')
})
