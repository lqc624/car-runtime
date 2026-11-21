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
 *
 * 1.8（D-31 PTC worker 桥挂链）：opts.spanBridge 加法（otel 显式开且 turn span 存活时非空）——
 * worker 侧程序计时（Date.now，worker_threads 同进程同时钟域）经 done 消息加法 span 字段回传，
 * 主线程经 bridge.complete() 单点收口 car.ptc span（trace.ts ptcRelay——trace 挂链 turn /
 * facade 时刻覆盖）；**单 exporter 纪律：worker 零独立出站通道、零 trace 载荷注入**（worker 无
 * outbound 面——挂链由主线程句柄归因 + 计时 relay 完成）。主侧 killer / worker error 兜底路径
 * 无 done 回传（terminate/崩溃抢先），以主线程时钟收口（口径登记：兜底非 worker 计时）。
 *
 * 1.27.0（Q-D1 第二步 / D-QD1-6）：PtcFailureKind 失败细类（**工具面注册表分立**——与 1.23
 * LlmErrorKind（LLM 面 9 类）两域分立，防一码压多形态 F-W0-2 教训）：PtcResult +kind 可选键
 * （失败六产出点逐点标注——authorization-denied / concurrency-guard / budget-exceeded /
 * worker-error〔done error 非预算 = 程序异常经 worker 收口 + worker 线程 error 两源同注 detail 区分〕/
 * worker-exit〔exit 先于 done〕/ output-limit〔REPL 打印面截断标注——ok=true 时 kind 作标注面〕）；
 * 无 kind = 既有形态字节兼容（PtcResult 可选键）。
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convergeBudget, type PtcBudget } from './budget.ts'
import { checkErasableOnly } from './erasable.ts'
import { redactSecrets } from '../security/secrets.ts'

export interface PtcRequest { code: string; description: string; toolCallId: string; budget?: Partial<PtcBudget> }
export interface PtcResult { ok: boolean; result?: unknown; error?: string; wallMs: number; outputBytes: number; budgetExceeded?: boolean
  /** F12 出站覆盖命中数（secrets 脱敏在回填上下文前强制执行） */ secretsRedacted?: number
  /** 1.27.0（D-QD1-6）：失败细类（六产出点；ok=true + output-limit = 截断标注面；无细类缺键字节兼容） */ kind?: PtcFailureKind }

/** 工具面失败细类注册表（分立两域 D-QD1-6——与 LlmErrorKind 各自注册；可裁剪 = 单一常量旋钮） */
export const PTC_FAILURE_KINDS = ['authorization-denied', 'concurrency-guard', 'budget-exceeded', 'worker-error', 'worker-exit', 'output-limit'] as const

export type PtcFailureKind = (typeof PTC_FAILURE_KINDS)[number]

export interface ToolBridge { run(args: unknown): Promise<unknown> }

/** 1.8-D31：PTC 桥挂链面（结构兼容 trace.ts PtcRelayHandle——ptc 模块不依赖 runtime-core/trace） */
export interface PtcSpanBridge {
  complete(startMs: number, endMs: number, outcome: string, error?: unknown): void
}

// P-A 存量发现修复（2026-11-14，R-DRILL-1 同类：dist 消费调用点未核）：worker 入口按宿主模块形态
// 双取——src 布局（runCode.ts → worker-entry.ts，type-strip 直跑）与 dist 布局（runCode.js →
// worker-entry.js，registry/平台 seam/Docker 消费方）。原硬编 .ts 在 dist 消费面必挂
// （Cannot find module <dist>/ptc/worker-entry.ts——平台 P-A 接线测试实证）。
const MODULE_FILE = fileURLToPath(import.meta.url)
const WORKER_PATH = join(dirname(MODULE_FILE), `worker-entry${MODULE_FILE.endsWith('.js') ? '.js' : '.ts'}`)
const MAX_CONCURRENT = 4
let active = 0

/** PTC 程序执行：每次新 worker；子调用经消息桥回主线程执行工具（宿主权限门生效面） */
export interface RunCodeOpts { tools: Map<string, ToolBridge>; audit?: (d: Record<string, unknown>) => void
  /** 授权门（S15）：返回 false = 拒绝（无 worker 启动，审计留痕）；authorizationId 幂等由 authz 服务承载 */ authorize?: (req: PtcRequest) => Promise<boolean>
  /** 1.8-D31：桥挂链供给（每次 runCode 一次——每程序新 worker；null = 无遥测零 relay） */ spanBridge?: () => { complete(startMs: number, endMs: number, outcome: string, error?: unknown): void } | null }

export async function runCode(req: PtcRequest, opts: RunCodeOpts): Promise<PtcResult> {
  // 双必填（description 为授权凭据——S15 授权门消费）
  if (!req.code?.trim()) throw new Error('CAR-E-PTC: code is required（run_code 双必填）')
  if (!req.description?.trim()) throw new Error('CAR-E-PTC: description is required——授权门人审凭据（无默认值，M3系统设计增补 T-2）')
  // 授权门前置（无 worker 启动）：拒绝 = 工具错误结果 + 审计留痕（authorizationId='ptc-'+id 幂等键）
  if (opts.authorize) {
    const granted = await opts.authorize(req)
      if (!granted) {
        opts.audit?.({ kind: 'ptc-denied', toolCallId: req.toolCallId, authorizationId: 'ptc-' + req.toolCallId, description: req.description })
        return { ok: false, error: 'authorization-denied (ptc)——授权拒绝落审计，程序未执行', wallMs: 0, outputBytes: 0, kind: 'authorization-denied' }
      }
  }
  // erasable-only 挂点（入口）
  const era = checkErasableOnly(req.code)
  if (!era.ok) throw new Error(`CAR-E-PTC: ${era.violation}`)
  const budget = convergeBudget(req.budget)
  if (active >= MAX_CONCURRENT) {
    return { ok: false, error: 'CAR-E-PTC: concurrency guard (max=4)——超限拒绝留痕', wallMs: 0, outputBytes: 0, kind: 'concurrency-guard' }
  }
  const started = Date.now()
  active++
  // 1.8-D31：桥挂链供给（每次 runCode 一次）；null = 无遥测零 relay
  const relay = opts.spanBridge?.() ?? null
  opts.audit?.({ kind: 'ptc-start', description: req.description, toolCallId: req.toolCallId, budget })
  try {
    return await new Promise<PtcResult>((resolve) => {
      // 1.27.0（D-QD1-6）：收口标志——exit 先于 done 的 worker-exit 兜底只发一次
      let settled = false
      const settle = (r: PtcResult): void => {
        if (settled) return
        settled = true
        resolve(r)
      }
      const worker = new Worker(WORKER_PATH, {
        workerData: { code: req.code, budget },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      })
      // 主线程侧兜底（worker 内计时器失效时强杀——双层预算）
      const killer = setTimeout(() => {
        void worker.terminate()
        // 1.8-D31：兜底收口（主线程时钟——terminate 抢先无 done relay，口径登记）
        relay?.complete(started, Date.now(), 'error', new Error(`budget-exceeded (maxWallMs=${budget.maxWallMs}, main-side guard)`))
        settle({ ok: false, error: `budget-exceeded (maxWallMs=${budget.maxWallMs}, main-side guard)`, wallMs: Date.now() - started, outputBytes: 0, budgetExceeded: true, kind: 'budget-exceeded' })
      }, budget.maxWallMs + 1000)
      worker.on('message', (m: { type: string; callId?: string; name?: string; args?: unknown; result?: unknown; error?: string; span?: { startMs: number; endMs: number } }) => {
        if (m.type === 'tool') {
          const def = opts.tools.get(m.name!)
          // 工具异常必须回传为 tool-result error（供程序体 try/catch 恢复）——
          // 无 catch 会成为 unhandled rejection 崩溃主进程（S19 评测 E1 捕获）
          void (def
            ? def.run(m.args).then(
                r => worker.postMessage({ type: 'tool-result', callId: m.callId, result: r }),
                (e: unknown) => worker.postMessage({ type: 'tool-result', callId: m.callId, error: String(e) }),
              )
            : Promise.resolve(worker.postMessage({ type: 'tool-result', callId: m.callId, error: `unknown tool "${m.name}"` })))
          return
        }
        if (m.type === 'done') {
          clearTimeout(killer)
          // 1.8-D31：worker 计时 relay 收口（error 路径同样收口——D-26 exception 形态成立）
          if (m.span && relay) relay.complete(m.span.startMs, m.span.endMs, m.error ? 'error' : 'ok', m.error)
          // F12 出站覆盖：worker 输出回填上下文前强制 redact（M3安全设计增补 T-4）
          let result = m.result
          let secretsRedacted = 0
          if (result !== undefined) {
            const serialized = JSON.stringify(result)
            const r = redactSecrets(serialized)
            secretsRedacted = r.redacted
            if (r.redacted > 0) {
              result = JSON.parse(r.text)
              opts.audit?.({ kind: 'ptc-secrets-redacted', toolCallId: req.toolCallId, hits: r.redacted })
            }
          }
          settle({
            ok: !m.error,
            result,
            error: m.error,
            wallMs: Date.now() - started,
            outputBytes: Buffer.byteLength(JSON.stringify(result ?? null)),
            budgetExceeded: !!m.error?.startsWith('budget-exceeded'),
            secretsRedacted,
            // 1.27.0（D-QD1-6）：done error = 程序异常经 worker 收口（worker-error 细类；done error 非预算 =
            // 程序 throw 与 worker 线程 error 两源同注——detail 区分，注册表六类不含独立 exception 产点）
            ...(m.error ? { kind: m.error.startsWith('budget-exceeded') ? ('budget-exceeded' as const) : ('worker-error' as const) } : {}),
          })
        }
      })
      worker.on('error', (e) => { clearTimeout(killer); relay?.complete(started, Date.now(), 'error', e); settle({ ok: false, error: String(e), wallMs: Date.now() - started, outputBytes: 0, kind: 'worker-error' }) })
      worker.on('exit', (code) => {
        clearTimeout(killer)
        active--
        // 1.27.0（D-QD1-6）：exit 先于 done 且 killer/worker-error 未抢先 = worker-exit 细类
        // （程序内 process.exit 形态——done/killer 均未收口时兜底；settled 已收则幂等 no-op）
        if (!settled) {
          settle({ ok: false, error: `worker-exited (code=${code})——worker 先于 done 退出（程序内 process.exit 形态）`, wallMs: Date.now() - started, outputBytes: 0, kind: 'worker-exit' })
        }
      })
      // exit 可能先于 done（budget killer）——兜底 resolve 幂等由 settled 标志保证（1.27.0 前为 Promise 语义幂等）
    })
  } finally {
    // active 递归在 exit 事件处理；此处为异常路径兜底
    setTimeout(() => { active = Math.max(0, active - 0) }, 0)
  }
}

/** PTC 作为一等 ToolDefinition：强制 write 侧效应（授权门无旁路），接入 runTurn 工具面 */
export function makePtcToolDefinition(opts: { tools: Map<string, ToolBridge>; audit?: (d: Record<string, unknown>) => void
  /** 1.8-D31：桥挂链供给透传（每次 runCode 一次；缺省 = 无遥测零 relay） */ spanBridge?: () => { complete(startMs: number, endMs: number, outcome: string, error?: unknown): void } | null }) {
  return {
    name: 'run_code',
    description: '执行一段 erasable TypeScript 程序（PTC）——程序体内经 tools.<name>(args) 调用已注册工具',
    // 1.4-S7：run_code 入参 schema（进模型声明面——此前无 parameters，模型看不到 code/description 形状）
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'erasable TS 程序体（async 函数体；经 tools.<name>(args) 调用已注册工具）' },
        description: { type: 'string', description: '本段程序的一句话描述（审计留痕）' },
      },
      required: ['code', 'description'],
      additionalProperties: false,
    },
    // T-22 语义：PTC 与 bash 同信任级别 → 强制 write 最高约束（不可声明为 readonly）
    declaredSideEffect: 'write' as const,
    run: async (args: { code: string; description: string; toolCallId?: string }) => {
      const r = await runCode({ code: args.code, description: args.description, toolCallId: args.toolCallId ?? 'ptc-' + Date.now().toString(36) }, opts)
      if (!r.ok) throw new Error(r.error)
      return r.result
    },
  }
}
