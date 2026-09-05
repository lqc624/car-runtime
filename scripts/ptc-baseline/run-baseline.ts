/**
 * T-7 · PTC 成功率评测基线（M4-S19 实装，S20 使用）
 *
 * 口径（M4系统设计增补 T-7 / PRD P1-4 验收：PTC 成功率 ≥ 非 PTC 基线）：
 *  - 12 任务 × 五类（纯计算 2 / 单工具 2 / 多工具编排 3 / 错误恢复 3 / 预算边界 2）；
 *    判定口径：E 类（预算边界）= 护栏正确触发即成功（两侧对称）；
 *  - 每任务每形态 ≥N 次（默认 5，--runs 调整）；对照组 = 等价非 PTC 逐步工具调用（同一工具注册表）；
 *  - 输出：JSONL 逐次明细 + 汇总（PTC 成功率 vs 非 PTC 基线 + P1-4 判定）；
 *  - 运行：node --experimental-transform-types scripts/ptc-baseline/run-baseline.ts [--runs 5]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { runCode, makePtcToolDefinition, type ToolBridge } from '../../src/ptc/runCode.ts'
import { convergeBudget } from '../../src/ptc/budget.ts'

// ── 评测工具注册表（与 PTC/非 PTC 两侧共享——对照公平性） ──
const TOOLS = new Map<string, ToolBridge & { description?: string; paramHint?: string }>([
  ['math_add', { run: async (a: unknown) => { const p = a as { x: number; y: number }; return p.x + p.y }, description: '加法', paramHint: 'args: { x: number; y: number }' }],
  ['math_mul', { run: async (a: unknown) => { const p = a as { x: number; y: number }; return p.x * p.y }, description: '乘法' }],
  ['str_len', { run: async (a: unknown) => (a as { s: string }).s.length, description: '字符串长度' }],
  ['flaky', { run: async (a: unknown) => { if ((a as { fail?: boolean }).fail) throw new Error('simulated failure'); return 'recovered' }, description: '可失败工具' }],
])

interface Task {
  id: string; cls: 'compute' | 'single-tool' | 'orchestration' | 'error-recovery' | 'budget-edge'
  name: string
  /** PTC 程序体（erasable async 函数体） */
  code: string
  description: string
  /** 期望判定：结果语义正确；E 类 = 护栏正确触发 */
  expect: (result: unknown, error?: string) => boolean
  /** 等 PTC 护栏触发后判成功的 E 类，非 PTC 对照跳过（无对应逐步语义） */
  ptcOnly?: boolean
  budget?: { maxWallMs?: number; maxOutputBytes?: number }
}

const TASKS: Task[] = [
  { id: 'C1', cls: 'compute', name: '纯计算-算术', code: 'const a = 6 * 7\nreturn { answer: a }', description: '纯算术验证', expect: r => (r as { answer: number }).answer === 42 },
  { id: 'C2', cls: 'compute', name: '纯计算-字符串', code: 'const s = "car-runtime"\nreturn { len: s.length, upper: s.toUpperCase() }', description: '字符串处理', expect: r => (r as { len: number }).len === 11 },
  { id: 'S1', cls: 'single-tool', name: '单工具-加法', code: 'const r = await tools.math_add({ x: 20, y: 22 })\nreturn { sum: r }', description: '单工具调用', expect: r => (r as { sum: number }).sum === 42 },
  { id: 'S2', cls: 'single-tool', name: '单工具-字符串', code: 'const n = await tools.str_len({ s: "hello" })\nreturn { n }', description: '单工具调用', expect: r => (r as { n: number }).n === 5 },
  { id: 'O1', cls: 'orchestration', name: '编排-串行依赖', code: 'const a = await tools.math_add({ x: 2, y: 3 })\nconst b = await tools.math_mul({ x: a, y: 4 })\nreturn { b }', description: '串行依赖链', expect: r => (r as { b: number }).b === 20 },
  { id: 'O2', cls: 'orchestration', name: '编排-并行', code: 'const [a, b] = await Promise.all([tools.math_add({ x: 1, y: 1 }), tools.math_mul({ x: 3, y: 3 })])\nreturn { a, b }', description: 'Promise.all 并行', expect: r => (r as { a: number; b: number }).a === 2 && r.b === 9 },
  { id: 'O3', cls: 'orchestration', name: '编排-混合', code: 'const parts = []\nfor (const p of [{ x: 1, y: 2 }, { x: 3, y: 4 }]) parts.push(await tools.math_add(p))\nreturn { parts, total: parts[0] + parts[1] }', description: '循环+聚合', expect: r => (r as { total: number }).total === 10 },
  { id: 'E1', cls: 'error-recovery', name: '恢复-try/catch', code: 'try { await tools.flaky({ fail: true }) } catch (e) { return { caught: true } }\nreturn { caught: false }', description: '工具异常捕获', expect: r => (r as { caught: boolean }).caught === true },
  { id: 'E2', cls: 'error-recovery', name: '恢复-部分失败继续', code: 'const out: string[] = []\ntry { await tools.flaky({ fail: true }) } catch { out.push("skip") }\nout.push(await tools.flaky({}))\nreturn { out }', description: '部分失败继续', expect: r => (r as { out: string[] }).out.length === 2 },
  { id: 'E3', cls: 'error-recovery', name: '恢复-重试语义', code: 'let ok = false\nfor (let i = 0; i < 3; i++) { try { ok = (await tools.flaky({ fail: i < 1 })) === "recovered"; if (ok) break } catch {} }\nreturn { ok }', description: '重试直至成功', expect: r => (r as { ok: boolean }).ok === true },
  { id: 'B1', cls: 'budget-edge', name: '预算-输出上限', code: 'return { blob: "x".repeat(9 * 1024 * 1024) }', description: '输出超 8MiB 测试上限', budget: { maxOutputBytes: 8 * 1024 * 1024, maxWallMs: 10_000 }, expect: (_r, e) => !!e?.startsWith('budget-exceeded (maxOutputBytes'), ptcOnly: true },
  { id: 'B2', cls: 'budget-edge', name: '预算-墙钟上限', code: 'while (true) { await new Promise(r => setTimeout(r, 10)) }\nreturn null', description: '死循环墙钟护栏', budget: { maxWallMs: 400 }, expect: (_r, e) => !!e?.startsWith('budget-exceeded (maxWallMs'), ptcOnly: true },
]

// ── 非 PTC 对照（逐步工具调用，与 PTC 侧同注册表） ──
function nonPtcEquivalent(task: Task, run: (name: string, args: unknown) => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  const call = (n: string, a: unknown) => run(n, a)
  switch (task.id) {
    case 'C1': return call('math_mul', { x: 6, y: 7 }).then(v => ({ ok: (v as number) === 42 }))
    case 'C2': return call('str_len', { s: 'car-runtime' }).then(v => ({ ok: (v as number) === 11 }))
    case 'S1': return call('math_add', { x: 20, y: 22 }).then(v => ({ ok: (v as number) === 42 }))
    case 'S2': return call('str_len', { s: 'hello' }).then(v => ({ ok: (v as number) === 5 }))
    case 'O1': return call('math_add', { x: 2, y: 3 }).then(a => call('math_mul', { x: a, y: 4 })).then(b => ({ ok: (b as number) === 20 }))
    case 'O2': return Promise.all([call('math_add', { x: 1, y: 1 }), call('math_mul', { x: 3, y: 3 })]).then(([a, b]) => ({ ok: a === 2 && b === 9 }))
    case 'O3': return call('math_add', { x: 1, y: 2 }).then(a => call('math_add', { x: 3, y: 4 }).then(b => ({ ok: (a as number) + (b as number) === 10 })))
    case 'E1': return call('flaky', { fail: true }).then(() => ({ ok: false }), e => ({ ok: String(e).includes('simulated failure') }))
    case 'E2': return call('flaky', { fail: true }).catch(() => call('flaky', {})).then(v => ({ ok: v === 'recovered' }))
    case 'E3': return call('flaky', { fail: true }).catch(() => call('flaky', {})).then(v => ({ ok: v === 'recovered' }))
    default: return Promise.resolve({ ok: true }) // B 类 ptcOnly 跳过
  }
}

async function main() {
  const runs = Math.max(1, Number(process.argv[process.argv.indexOf('--runs') + 1] ?? 5) || 5)
  const lines: Record<string, unknown>[] = []
  const ptcDef = makePtcToolDefinition({ tools: TOOLS })
  const summary: Record<string, { ptc: number; non: number; total: number }> = {}

  for (const task of TASKS) {
    let ok = 0
    for (let i = 0; i < runs; i++) {
      try {
        if (task.cls === 'budget-edge') {
          // E 类经 runCode 直接驱动（护栏触发即成功）
          const r = await runCode({ code: task.code, description: task.description, toolCallId: `${task.id}-${i}`, budget: convergeBudget(task.budget) }, { tools: TOOLS })
          const pass = task.expect(r.result, r.error)
          if (pass) ok++
          lines.push({ task: task.id, cls: task.cls, run: i, ok: pass, error: r.error, budgetExceeded: r.budgetExceeded })
        } else {
          const r = await runCode({ code: task.code, description: task.description, toolCallId: `${task.id}-${i}`, budget: { maxWallMs: 10_000 } }, { tools: TOOLS })
          const pass = r.ok && task.expect(r.result, r.error)
          if (pass) ok++
          lines.push({ task: task.id, cls: task.cls, run: i, ok: pass, error: r.error })
        }
      } catch (e) { lines.push({ task: task.id, cls: task.cls, run: i, ok: false, error: String(e) }) }
    }
    // 非 PTC 对照
    let nonOk = 0
    if (!task.ptcOnly) {
      for (let i = 0; i < runs; i++) {
        const r = await nonPtcEquivalent(task, (n, a) => (TOOLS.get(n) as ToolBridge).run(a))
        if (r.ok) nonOk++
      }
    } else nonOk = runs // ptcOnly 不参与对照，按满分避免拉低基线
    summary[task.cls] = summary[task.cls] ?? { ptc: 0, non: 0, total: 0 }
    summary[task.cls].ptc += ok; summary[task.cls].non += nonOk; summary[task.cls].total += runs
    console.log(`${task.id} ${task.name}: PTC ${ok}/${runs}${task.ptcOnly ? '（ptcOnly）' : ` | 非PTC ${nonOk}/${runs}`}`)
  }

  const totalPtc = Object.values(summary).reduce((s, v) => s + v.ptc, 0)
  const totalNon = Object.values(summary).reduce((s, v) => s + v.non, 0)
  const totalN = Object.values(summary).reduce((s, v) => s + v.total, 0)
  const rate = (x: number) => ((x / totalN) * 100).toFixed(1) + '%'
  console.log(`\n==== PTC 成功率 ${totalPtc}/${totalN} = ${rate(totalPtc)} ｜ 非 PTC 基线 ${totalNon}/${totalN} = ${rate(totalNon)} ====`)
  console.log(`P1-4 判定：${totalPtc >= totalNon ? '✅ PTC ≥ 非 PTC 基线' : '❌ PTC < 非 PTC 基线（需分析失败任务）'}`)
  mkdirSync('dist/ptc-baseline', { recursive: true })
  writeFileSync('dist/ptc-baseline/detail.jsonl', lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync('dist/ptc-baseline/summary.json', JSON.stringify({ runs, ptc: totalPtc, non: totalNon, total: totalN, byClass: summary }, null, 2))
  console.log('明细：dist/ptc-baseline/detail.jsonl ｜ 汇总：dist/ptc-baseline/summary.json')
}

main()
