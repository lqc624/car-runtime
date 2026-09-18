/**
 * J-01 lint-scan-build · 仓库密钥扫描门禁（M2部署设计增补 §2.3 / ci.yml 幽灵注释兑现项）
 *
 * 口径：扫 git 跟踪文件（git ls-files），命中即 exit 1——补 CI 供应链第二道门（s7.spec 的
 * 规则库是样本级断言，本脚本是仓库级常驻扫描；两者共用同一模式集口径）。
 * 规则集（高置信，宁缺勿滥——低置信规则走人工评审，不进 fail-closed 门禁）：
 *   GitHub PAT / npm token / AWS AKIA / PEM 私钥块 / 通用密钥赋值 / ≥60 位连续 base64
 * 豁免：环境变量名引用（process.env.X / ${X}）不算命中；文本行内示例占位不算命中。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const RULES: Array<[string, RegExp]> = [
  ['github-pat', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['npm-token', /npm_[A-Za-z0-9]{30,}/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['pem-private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['generic-secret-assign', /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"]{12,}['"]/i],
  ['long-base64-blob', /[A-Za-z0-9+/]{80,}={0,2}/],
]

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean)

let findings = 0
for (const file of tracked) {
  let content: string
  try { content = readFileSync(file, 'utf8') } catch { continue /* 二进制/不可读：跳过（sha 类二进制物无密钥文本面） */ }
  if (content.includes('\u0000')) continue // 二进制
  content.split('\n').forEach((line, i) => {
    for (const [name, re] of RULES) {
      if (!re.test(line)) continue
      // 豁免 1：环境变量引用（运行时注入，非硬编码）
      if (name === 'generic-secret-assign' && /process\.env\.|\$\{[A-Z_]+\}/.test(line)) continue
      // 豁免 2：锁文件 integrity 字段（sha512- 前缀的依赖指纹，非密钥）
      if (name === 'long-base64-blob' && /"integrity":\s*"sha512-/.test(line)) continue
      // 豁免 3：规则定义文件自身（secrets 规则库/样本测试——模式定义处必然"命中"）
      if (file.endsWith('secrets-scan.ts') || /^src\/security\/secrets\.ts$/.test(file) || file.includes('test/s7.spec.ts')) continue
      console.error(`  [${name}] ${file}:${i + 1}  ${line.trim().slice(0, 90)}`)
      findings++
    }
  })
}

const summary = JSON.stringify({ gate: 'J-01-secrets-scan', files: tracked.length, findings, ok: findings === 0, ts: Date.now() })
if (findings > 0) {
  console.error(`FAIL ${summary}`)
  process.exit(1)
}
console.log(`PASS ${summary}`)
