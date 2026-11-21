/**
 * T-2 · PTC 预算控制（M3-S14）
 *
 * 口径（M3系统设计增补 T-2 / D5 §12 一手口径）：
 *  - 初始对齐 dsh：computeMs=60s / maxWallMs=600s / maxOutputBytes=64MB；
 *  - **三层收敛只许下调**（fail-closed）：任何上调 = 显式报错——预算放宽属安全相关变更，
 *    须经标定流程（四步标定法：P99×2 余量校验 + 逃逸验证 + 季度复标）而非配置直改；
 *  - 预算定位 = **资源护栏而非安全边界**（containment 非安全边界，对外声明口径归安全设计）。
 */

export interface PtcBudget { computeMs: number; maxWallMs: number; maxOutputBytes: number
  /** 1.27.0（D-QD1-3）：REPL 打印流字节预算（OutputLedger——inspect-only 契约面；fresh run_code 不适用） */ maxPrintedBytes: number }

/** 初始基线（dsh 一手口径对齐值；标定后经 ADR 修订；1.27.0 +maxPrintedBytes=64KB——打印面非结果面） */
export const PTC_BUDGET_BASELINE: Readonly<PtcBudget> = Object.freeze({
  computeMs: 60_000,
  maxWallMs: 600_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPrintedBytes: 64 * 1024,
})

/**
 * 预算收敛校验：用户覆盖值只许 ≤ 基线（逐项）；上调 = CAR-E-BUDGET 显式报错。
 * 返回收敛后的完整预算（未覆盖项取基线）。
 */
export function convergeBudget(override?: Partial<PtcBudget>): PtcBudget {
  const out: PtcBudget = { ...PTC_BUDGET_BASELINE }
  if (!override) return out
  for (const key of ['computeMs', 'maxWallMs', 'maxOutputBytes', 'maxPrintedBytes'] as const) {
    const v = override[key]
    if (v === undefined) continue
    if (!Number.isFinite(v) || v <= 0) throw new Error(`CAR-E-BUDGET: ${key} must be a positive number, got ${v}`)
    if (v > PTC_BUDGET_BASELINE[key]) {
      throw new Error(`CAR-E-BUDGET: ${key}=${v} exceeds baseline ${PTC_BUDGET_BASELINE[key]}——预算只许下调（fail-closed），上调须经四步标定流程修订基线`)
    }
    out[key] = v
  }
  return out
}
