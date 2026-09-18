/**
 * S7b · E-5 万级 secrets 基准集常驻回归（M2 退出标准 #4；D-3 判据）
 *
 * 判据（M2 安全设计增补 D-3）：漏报率 <1.5%、FPR ≤5%、precision ≥80%，1:9 正负比。
 * 基准集确定性生成（mulberry32 固定种子），任何 PATTERN_LIBRARY / 三层检测改动
 * 触碰判据即本 spec 红——D-3「CI 标定」承诺的载体。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBaseline } from '../src/security/secrets-baseline.ts'

test('S7b-E5: 10k 基准集（1000 正 + 9000 负）满足 D-3 判据', () => {
  const r = runBaseline(1000, 9000)
  assert.equal(r.posTotal, 1000, '正样本数')
  assert.equal(r.negTotal, 9000, '负样本数')
  assert.ok(r.missRate < r.criteria.missRateLt, `漏报率 ${(r.missRate * 100).toFixed(2)}% 应 <1.5%`)
  assert.ok(r.fpr <= r.criteria.fprLe, `FPR ${(r.fpr * 100).toFixed(2)}% 应 ≤5%`)
  assert.ok(r.precision >= r.criteria.precisionGe, `precision ${(r.precision * 100).toFixed(2)}% 应 ≥80%`)
  assert.equal(r.pass, true)
})
