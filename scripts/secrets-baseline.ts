/**
 * E-5 secrets 基准集 CLI（M2 退出标准 #4 终验入口）
 *
 * 用法：node --experimental-transform-types scripts/secrets-baseline.ts
 * 产出：dist/ci/secrets-baseline.json（计数与聚合指标，无样本原文）
 * 退出码：判据全过 = 0；任一判据不满足 = 1（漏报 ≥1.5% / FPR >5% / precision <80%）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { runBaseline } from '../src/security/secrets-baseline.ts'

const result = runBaseline(1000, 9000)
const report = {
  generatedAt: new Date().toISOString(),
  seedPos: 20260918,
  seedNeg: 20260919,
  ...result,
}
mkdirSync('dist/ci', { recursive: true })
writeFileSync('dist/ci/secrets-baseline.json', JSON.stringify(report, null, 2))

console.log('E-5 secrets baseline (1:9, 1000 pos + 9000 neg):')
console.log(`  TP=${result.tp} FN=${result.fn} FP=${result.fp} TN=${result.tn}`)
console.log(`  missRate=${(result.missRate * 100).toFixed(2)}% (criterion <1.5%)`)
console.log(`  FPR=${(result.fpr * 100).toFixed(2)}% (criterion <=5%)`)
console.log(`  precision=${(result.precision * 100).toFixed(2)}% (criterion >=80%)`)
console.log(`  report: dist/ci/secrets-baseline.json`)
if (!result.pass) {
  console.log(`  missByClass=${JSON.stringify(result.missByClass)}`)
  console.log(`  fpByClass=${JSON.stringify(result.fpByClass)}`)
  console.error('E-5 CRITERIA VIOLATED')
  process.exit(1)
}
console.log('  PASS')
