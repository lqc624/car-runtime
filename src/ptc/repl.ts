/**
 * 1.27.0 · Q-D1 第二步 E-1（D-QD1-2/3/4/7/8）：PtcRepl——子代理专属 scoped REPL（持久态程序化工具调用）
 *
 * 口径（《内核1.27-Q-D1第二步-PTC子链与REPL-迭代规划.md》/ DSH 一手机制 CAR 化改写）：
 *  - **挂靠形态（D-QD1-2）**：ptc 型子代理专属——生命周期 = spawn 创建 → join/kill/abort release；
 *    同 REPL 并发调用拒绝（busy 串行门）；父会话 run_code（fresh worker）零变化——双形态并存；
 *  - **绑定复制（D-QD1-4 acorn 例外）**：每次调用独立 async 函数作用域；acorn 只扫描顶层声明
 *    （零改写模型代码）——存活绑定按索引注入为函数参数（let 语义，const 二次声明零 SyntaxError），
 *    执行后 epilogue `__$extract` 按名提取终值（引用变异自然持久，重赋值经 getter 回写）；
 *    失败调用按快照回退注入绑定（replaced 表同源——部分执行的重赋值不污染），本次新声明整体丢弃；
 *  - **inspect-only 输出契约（D-QD1-3，仅 REPL）**：模型只收打印流（OutputLedger 字节预算，
 *    超限保留前缀 + 显式 truncated——绝不静默截断），末表达式丢弃显式标注（discarded:true）；
 *    审计同源核验：链上 toolResult = 结果面 = 模型实见内容成立；
 *  - **生命周期（D-QD1-8）**：owner = 子代理句柄（宿主持 handle 引用即 owner）；release = terminate +
 *    状态销毁 + 后续调用拒（repl-released）；worker 崩溃/预算强杀 = 状态丢失**如实报告**
 *    （kind + note——禁静默重启伪装续写；下一次 run 自动重建空态 REPL）；
 *  - **隔离纪律沿袭 fresh**：隔离 = worker 进程（resourceLimits 同 256/32MB）——containment 非安全
 *    边界声明不变；worker 内不引入 vm context（与 fresh 的 new Function 同域形态，沙箱 = 进程）；
 *  - **授权（D-QD1-5）**：run 前置 authorize 钩子（宿主门——弹卡父会话 bash 同形态），拒绝 =
 *    authorization-denied kind + 审计留痕，无 worker 消息；
 *  - **EventKind 零新增**；acorn = D-22 例外裁决（MIT / 零传递依赖 / parse-only）。
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convergeBudget, type PtcBudget } from './budget.ts'
import { checkErasableOnly } from './erasable.ts'
import { redactSecrets } from '../security/secrets.ts'
import type { ToolBridge, PtcFailureKind } from './runCode.ts'

export interface PtcReplOpts {
  tools: Map<string, ToolBridge>
  audit?: (d: Record<string, unknown>) => void
  /** 授权门（D-QD1-5 宿主门）：拒绝 = authorization-denied kind + 审计留痕（无 worker 消息） */
  authorize?: (req: { code: string; description: string; toolCallId: string }) => Promise<boolean>
  /** 1.8-D31 同款桥挂链（REPL 每调用一次 relay） */
  spanBridge?: () => { complete(startMs: number, endMs: number, outcome: string, error?: unknown): void } | null
  /** 打印流字节预算缺省 = PtcBudget.maxPrintedBytes 基线（64KB）；覆盖只许 ≤ 基线（convergeBudget 同口径） */
  maxPrintedBytes?: number
}

export interface PtcReplResult {
  ok: boolean
  /** inspect-only 契约：打印流（OutputLedger 预算内前缀——超限 truncated 显式标注） */
  printed?: string
  printedTruncated?: boolean
  /** 末表达式丢弃显式标注（inspect-only——用打印显式输出） */
  discarded: true
  note: string
  error?: string
  kind?: PtcFailureKind
  wallMs: number
  outputBytes: number
  /** 当前存活绑定名（可观测面——调试/审计；崩溃后 = []） */
  bindings: string[]
}

export interface PtcReplHandle {
  run(req: { code: string; description: string; toolCallId?: string; budget?: Partial<PtcBudget> }): Promise<PtcReplResult>
  /** 终止 worker + 状态销毁 + 后续调用拒（join/kill/abort 三路收口 + 会话关闭兜底——宿主职责） */
  release(): void
  /** 同 REPL 并发调用外部检查（busy 即抛——run 内建串行门外的显式断言面） */
  assertIdle(): void
  readonly released: boolean
}

const REPL_WORKER_PATH = (() => {
  const MODULE_FILE = fileURLToPath(import.meta.url)
  return join(dirname(MODULE_FILE), `worker-entry${MODULE_FILE.endsWith('.js') ? '.js' : '.ts'}`)
})()

/** REPL 打印预算缺省 = 基线 maxPrintedBytes（64KB——预算收敛 fail-closed 同口径） */
const PRINTED_BASELINE = convergeBudget().maxPrintedBytes

export function createPtcRepl(opts: PtcReplOpts): PtcReplHandle {
  const printedMax = opts.maxPrintedBytes !== undefined ? (convergeBudget({ maxPrintedBytes: opts.maxPrintedBytes }).maxPrintedBytes) : PRINTED_BASELINE
  let released = false
  let busy = false
  let worker: Worker | null = null
  // 状态丢失标记（worker error/exit/预算强杀——下一次 run 自动重建空态；如实报告在失败结果的 note/kind）
  let stateLost = false

  function spawnWorker(): Worker {
    const w = new Worker(REPL_WORKER_PATH, {
      workerData: { mode: 'repl', printedMax },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    })
    w.on('error', () => { /* 崩溃 = run 内 error 收口；此处仅防 unhandled */ })
    return w
  }
  worker = spawnWorker()

  function kill(): void {
    worker?.terminate()
    worker = null
    stateLost = true
  }

  const handle: PtcReplHandle = {
    get released(): boolean {
      return released
    },
    release(): void {
      released = true
      kill()
    },
    assertIdle(): void {
      if (released) throw new Error('CAR-E-PTC-REPL: repl-released——REPL 已释放（生命周期收口后不可再调用）')
      if (busy) throw new Error('CAR-E-PTC-REPL: repl-busy——同 REPL 串行门（并发调用拒绝，assertIdle）')
    },
    async run(req) {
      const started = Date.now()
      const done = (r: PtcReplResult): PtcReplResult => {
        busy = false
        return r
      }
      // 前置校验（busy/released 串行门——零 worker 消息）
      if (released) {
        return { ok: false, error: 'CAR-E-PTC-REPL: repl-released——REPL 已释放（生命周期收口后不可再调用）', discarded: true, note: 'REPL 已释放', wallMs: 0, outputBytes: 0, bindings: [] }
      }
      if (busy) {
        return { ok: false, error: 'CAR-E-PTC-REPL: repl-busy——同 REPL 串行门（并发调用拒绝；assertIdle 同口径）', discarded: true, note: '上一调用仍在途', wallMs: 0, outputBytes: 0, bindings: [], kind: 'concurrency-guard' }
      }
      if (!req.code?.trim()) return done({ ok: false, error: 'CAR-E-PTC: code is required（run_code 双必填）', discarded: true, note: 'code 缺失', wallMs: 0, outputBytes: 0, bindings: [] })
      if (!req.description?.trim()) return done({ ok: false, error: 'CAR-E-PTC: description is required——授权门人审凭据（无默认值）', discarded: true, note: 'description 缺失', wallMs: 0, outputBytes: 0, bindings: [] })
      if (!worker) worker = spawnWorker() // 前次崩溃/强杀后自动重建（空态——状态丢失已在前次结果如实报告）
      const toolCallId = req.toolCallId ?? 'repl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
      if (opts.authorize) {
        const granted = await opts.authorize({ code: req.code, description: req.description, toolCallId })
        if (!granted) {
          opts.audit?.({ kind: 'ptc-denied', toolCallId, authorizationId: 'ptc-' + toolCallId, description: req.description })
          return done({ ok: false, error: 'authorization-denied (ptc-repl)——授权拒绝落审计，程序未执行', discarded: true, note: '授权拒绝', wallMs: Date.now() - started, outputBytes: 0, kind: 'authorization-denied', bindings: [] })
        }
      }
      const era = checkErasableOnly(req.code)
      if (!era.ok) return done({ ok: false, error: `CAR-E-PTC: ${era.violation}`, discarded: true, note: 'erasable 违例', wallMs: Date.now() - started, outputBytes: 0, bindings: [] })
      let budget: PtcBudget
      try {
        budget = convergeBudget(req.budget)
      } catch (e) {
        return done({ ok: false, error: String(e), discarded: true, note: '预算非法', wallMs: Date.now() - started, outputBytes: 0, bindings: [] })
      }
      busy = true
      const relay = opts.spanBridge?.() ?? null
      opts.audit?.({ kind: 'ptc-start', description: req.description, toolCallId, budget, repl: true })
      return await new Promise<PtcReplResult>((resolve) => {
        const w = worker!
        // 预算强杀（双层主侧兜底）——REPL 状态随 terminate 销毁：如实报告（D-QD1-8 禁静默伪装续写）
        const killer = setTimeout(() => {
          kill()
          relay?.complete(started, Date.now(), 'error', new Error('budget-exceeded'))
          opts.audit?.({ kind: 'ptc-repl-state-lost', toolCallId, reason: 'budget-exceeded' })
          resolve({
            ok: false,
            error: `budget-exceeded (maxWallMs=${budget.maxWallMs}, main-side guard)——REPL 状态已清（预算强杀，持久绑定丢失——如实报告）`,
            discarded: true,
            note: 'REPL 状态已清（预算强杀）——下一次调用自动重建空态',
            wallMs: Date.now() - started,
            outputBytes: 0,
            kind: 'budget-exceeded',
            bindings: [],
          })
        }, budget.maxWallMs + 1000)
        const onMessage = (m: { type: string; callId?: string; name?: string; args?: unknown; result?: unknown; error?: string; span?: { startMs: number; endMs: number }; printed?: string; printedTruncated?: boolean; bindings?: string[] }) => {
          if (m.type === 'tool') {
            const def = opts.tools.get(m.name!)
            void (def
              ? def.run(m.args).then(
                  r => w.postMessage({ type: 'tool-result', callId: m.callId, result: r }),
                  (e: unknown) => w.postMessage({ type: 'tool-result', callId: m.callId, error: String(e) }),
                )
              : Promise.resolve(w.postMessage({ type: 'tool-result', callId: m.callId, error: `unknown tool "${m.name}"` })))
            return
          }
          if (m.type === 'repl-done' && m.callId === toolCallId) {
            clearTimeout(killer)
            w.off('message', onMessage)
            w.off('error', onCrash)
            w.off('exit', onExit)
            if (m.span && relay) relay.complete(m.span.startMs, m.span.endMs, m.error ? 'error' : 'ok', m.error)
            // F12 出站覆盖：打印流回填上下文前强制 redact（同 fresh 纪律）
            let printed = m.printed
            let secretsRedacted = 0
            if (printed) {
              const r = redactSecrets(printed)
              secretsRedacted = r.redacted
              printed = r.text
              if (r.redacted > 0) opts.audit?.({ kind: 'ptc-secrets-redacted', toolCallId, hits: r.redacted })
            }
            if (m.error) {
              // 两条失败路径语义分立（D-QD1-8 如实报告）：worker 内计时预算到期 = 调用失败但 worker
              // 存活（状态保留——绑定回退快照）；主侧 killer 强杀 = 状态丢失（另一分支如实标注）
              const isBudget = m.error.startsWith('budget-exceeded')
              resolve(done({
                ok: false,
                error: m.error,
                discarded: true,
                note: isBudget
                  ? '预算到期（worker 内计时——REPL 状态保留：注入绑定已回退快照，worker 存活续用）'
                  : '程序异常——注入绑定已回退快照（本次新声明丢弃）；存活绑定见 bindings',
                wallMs: Date.now() - started,
                outputBytes: Buffer.byteLength(printed ?? ''),
                kind: m.error.startsWith('budget-exceeded') ? 'budget-exceeded' : 'worker-error',
                ...(printed ? { printed } : {}),
                ...(m.printedTruncated ? { printedTruncated: true } : {}),
                bindings: m.bindings ?? [],
              }))
              return
            }
            if (m.printedTruncated) {
              opts.audit?.({ kind: 'ptc-output-limit', toolCallId, limit: printedMax })
            }
            resolve(done({
              ok: true,
              ...(printed !== undefined ? { printed } : {}),
              ...(m.printedTruncated ? { printedTruncated: true, kind: 'output-limit' as PtcFailureKind } : {}),
              discarded: true,
              note: m.printedTruncated
                ? '打印流超预算已截断（output-limit——保留可容纳前缀，绝不静默）· 末表达式丢弃（inspect-only——用打印显式输出）'
                : '末表达式丢弃（inspect-only——用打印显式输出）',
              wallMs: Date.now() - started,
              outputBytes: Buffer.byteLength(printed ?? ''),
              bindings: m.bindings ?? [],
            }))
          }
        }
        w.on('message', onMessage)
        const onCrash = (e: Error): void => {
          clearTimeout(killer)
          w.off('message', onMessage)
          kill()
          opts.audit?.({ kind: 'ptc-repl-state-lost', toolCallId, reason: String(e) })
          resolve(done({
            ok: false,
            error: `worker crashed: ${String(e)}——REPL 状态已清（崩溃如实报告，禁静默伪装续写）`,
            discarded: true,
            note: 'REPL 状态已清（worker 崩溃）——下一次调用自动重建空态',
            wallMs: Date.now() - started,
            outputBytes: 0,
            kind: 'worker-error',
            bindings: [],
          }))
        }
        w.once('error', onCrash)
        // worker 先于 done 退出（程序内 process.exit 形态）= 状态丢失（D-QD1-8 如实报告 + 状态已清）
        const onExit = (code: number): void => {
          clearTimeout(killer)
          w.off('message', onMessage)
          w.off('error', onCrash)
          kill()
          resolve(done({
            ok: false,
            error: `worker-exited (code=${code})——REPL worker 先于 done 退出（程序内 process.exit 形态）`,
            discarded: true,
            note: 'REPL 状态已清（worker 退出——下一次调用自动重建空态）',
            wallMs: Date.now() - started,
            outputBytes: 0,
            kind: 'worker-exit',
            bindings: [],
          }))
        }
        w.once('exit', onExit)
        w.postMessage({ type: 'repl-run', callId: toolCallId, code: req.code, budget, description: req.description, printedMax: budget.maxPrintedBytes })
      })
    },
  }
  return handle
}

/** makePtcReplToolDefinition 形态（宿主 HostToolDef 兼容——run_code 同名绑定纪律 D-QD1-7 由宿主装配承担） */
export interface PtcReplToolDef {
  name: 'run_code'
  declaredSideEffect: 'write'
  run(args: { code: string; description: string; toolCallId?: string; budget?: Partial<PtcBudget> }): Promise<PtcReplResult>
}

/** 便捷面：REPL 句柄 → run_code 同名工具定义（宿主子链工具面装配——授权经 handle.run 内 authorize 钩子） */
export function bindReplToTool(handle: PtcReplHandle): PtcReplToolDef {
  return {
    name: 'run_code',
    declaredSideEffect: 'write',
    run: (args) => handle.run(args),
  }
}
