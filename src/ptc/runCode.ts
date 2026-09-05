/**
 * F16 · PTC（Programmatic Tool Calling）执行器（M3-S14）
 *
 * 口径（M3系统设计增补 T-2 / 决议③ PTC 落位 / dsh 一手口径）：
 *  - run_code 签名：code + description **双必填**（description = 授权门「凭什么」人审凭据，无默认值）；
 *  - 隔离：每次新 worker（独立无跨运行状态）；containment 非安全边界 → **强制 declaredSideEffect='write'**
 *    走 stop.ts 既有权限门（S15 authorizationId='ptc-'+id 幂等集成）；
 *  - erasable-only 双挂点之一（本入口）；挂点二在 loader 提交链（mountPlugin）；
 *  - **预算到期不掐 turn**：超限 = 工具错误结果交回模型（TurnEndReason 六值零扩展，ADR-001 兼容）；
 *  - 并发护栏（自研五维）：并发 4 / 子调用超时 30s / 总 worker 存活由本执行器串行门管控。
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convergeBudget, type PtcBudget } from './budget.ts'
import { checkErasableOnly } from './erasable.ts'

export interface PtcRequest { code: string; description: string; toolCallId: string; budget?: Partial<PtcBudget> }
export interface PtcResult { ok: boolean; result?: unknown; error?: string; wallMs: number; outputBytes: number; budgetExceeded?: boolean }

export interface ToolBridge { run(args: unknown): Promise<unknown> }

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'worker-entry.ts')
const MAX_CONCURRENT = 4
let active = 0

/** PTC 程序执行：每次新 worker；子调用经消息桥回主线程执行工具（宿主权限门生效面） */
export async function runCode(req: PtcRequest, opts: { tools: Map<string, ToolBridge>; audit?: (d: Record<string, unknown>) => void }): Promise<PtcResult> {
  // 双必填（description 为授权凭据——S15 授权门消费）
  if (!req.code?.trim()) throw new Error('CAR-E-PTC: code is required（run_code 双必填）')
  if (!req.description?.trim()) throw new Error('CAR-E-PTC: description is required——授权门人审凭据（无默认值，M3系统设计增补 T-2）')
  // erasable-only 挂点（入口）
  const era = checkErasableOnly(req.code)
  if (!era.ok) throw new Error(`CAR-E-PTC: ${era.violation}`)
  const budget = convergeBudget(req.budget)
  if (active >= MAX_CONCURRENT) {
    return { ok: false, error: 'CAR-E-PTC: concurrency guard (max=4)——超限拒绝留痕', wallMs: 0, outputBytes: 0 }
  }
  const started = Date.now()
  active++
  opts.audit?.({ kind: 'ptc-start', description: req.description, toolCallId: req.toolCallId, budget })
  try {
    return await new Promise<PtcResult>((resolve) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: { code: req.code, budget },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      })
      // 主线程侧兜底（worker 内计时器失效时强杀——双层预算）
      const killer = setTimeout(() => {
        void worker.terminate()
        resolve({ ok: false, error: `budget-exceeded (maxWallMs=${budget.maxWallMs}, main-side guard)`, wallMs: Date.now() - started, outputBytes: 0, budgetExceeded: true })
      }, budget.maxWallMs + 1000)
      worker.on('message', (m: { type: string; callId?: string; name?: string; args?: unknown; result?: unknown; error?: string }) => {
        if (m.type === 'tool') {
          const def = opts.tools.get(m.name!)
          void (def
            ? def.run(m.args).then(r => worker.postMessage({ type: 'tool-result', callId: m.callId, result: r }))
            : Promise.resolve(worker.postMessage({ type: 'tool-result', callId: m.callId, error: `unknown tool "${m.name}"` })))
          return
        }
        if (m.type === 'done') {
          clearTimeout(killer)
          resolve({
            ok: !m.error,
            result: m.result,
            error: m.error,
            wallMs: Date.now() - started,
            outputBytes: Buffer.byteLength(JSON.stringify(m.result ?? null)),
            budgetExceeded: !!m.error?.startsWith('budget-exceeded'),
          })
        }
      })
      worker.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: String(e), wallMs: Date.now() - started, outputBytes: 0 }) })
      worker.on('exit', (code) => { clearTimeout(killer); active-- })
      // exit 可能先于 done（budget killer）——兜底 resolve 幂等由 Promise 语义保证
    })
  } finally {
    // active 递归在 exit 事件处理；此处为异常路径兜底
    setTimeout(() => { active = Math.max(0, active - 0) }, 0)
  }
}

/** PTC 作为一等 ToolDefinition：强制 write 侧效应（授权门无旁路），接入 runTurn 工具面 */
export function makePtcToolDefinition(opts: { tools: Map<string, ToolBridge>; audit?: (d: Record<string, unknown>) => void }) {
  return {
    name: 'run_code',
    description: '执行一段 erasable TypeScript 程序（PTC）——程序体内经 tools.<name>(args) 调用已注册工具',
    // T-22 语义：PTC 与 bash 同信任级别 → 强制 write 最高约束（不可声明为 readonly）
    declaredSideEffect: 'write' as const,
    run: async (args: { code: string; description: string; toolCallId?: string }) => {
      const r = await runCode({ code: args.code, description: args.description, toolCallId: args.toolCallId ?? 'ptc-' + Date.now().toString(36) }, opts)
      if (!r.ok) throw new Error(r.error)
      return r.result
    },
  }
}
