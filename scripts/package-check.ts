/**
 * J-13/14/15 package-* · npm pack 干跑 + 内容断言（M2部署设计增补 §2.3 / §3）
 *
 * 三平台同名同判据（files 白名单语义平台无关）；断言：
 *   ① pack 退出码 0（干跑可打包）；
 *   ② 文件数 ≥ 50（rc.1 基线 54 files——塌方即 FAIL，防 files 白名单被误改）；
 *   ③ 包名 = package.json name（防命名漂移——rc.1 tag 落后包名事故的常驻防线）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' })
const info = JSON.parse(out)[0]

const checks: Array<[string, boolean, string]> = [
  ['pack exit 0', true, `${info.name}@${info.version}`],
  ['file count >= 50', (info.files?.length ?? 0) >= 50, `${info.files?.length ?? 0} files / ${info.size} bytes`],
  ['name no-drift', info.name === pkg.name, `${info.name} == ${pkg.name}`],
]

let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  ${detail}`)
  if (!ok) failed++
}
console.log(`----\npackage-check(${process.platform}): ${checks.length - failed}/${checks.length} PASS`)
process.exit(failed === 0 ? 0 : 1)
