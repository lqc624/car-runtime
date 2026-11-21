/**
 * PTC worker 入口（M3-S14）：隔离执行 PTC 程序体
 * 1.27.0 · Q-D1 第二步 E-1（D-QD1-2/3/4/7/8）：REPL 模式——子代理专属持久态 scoped REPL
 *
 * 协议（fresh 模式——原样不动）：
 *  - workerData: { code, budget }；
 *  - 程序体 = async 函数体（顶层 await/return 支持，dsh 一手口径）；
 *  - tools proxy：await tools.<name>(args) → postMessage {type:'tool'} → 主线程执行 → {type:'tool-result'} 回传；
 *  - 预算：maxWallMs 计时超限 → done(error='budget-exceeded (maxWallMs)')；maxOutputBytes 序列化后检查；
 *  - done 消息单发即退——程序体 = 一次原子 toolCall（收口点唯一在 executor 返回）；
 *  - 1.8-D31：done 加法 span 字段（程序窗口 startMs/endMs——worker 侧 Date.now 计时，
 *    worker_threads 同进程同时钟域；主线程 relay 收口 car.ptc span——单 exporter 纪律，
 *    本隔离体零独立出站通道；程序未启动〔wallTimer 抢先〕不产 span 字段）。
 *
 * 协议（1.27.0 REPL 模式——workerData: { mode: 'repl', printedMax }）：
 *  - 持久 worker（子代理生命周期 = spawn→join/kill/abort release，D-QD1-2）；{type:'release'} → exit；
 *  - {type:'repl-run', callId, code, budget} → 执行 → {type:'repl-done', callId, printed, printedTruncated,
 *    bindings, error?, span?}——**inspect-only 契约（D-QD1-3）**：打印流经 OutputLedger（maxPrintedBytes
 *    预算，超限保留前缀 + truncated 显式标注绝不静默）；末表达式丢弃（顶层 return = SyntaxError
 *    fail-visible——inspect-only 契约自然形态，登记）；
 *  - **绑定复制（D-QD1-4 acorn 例外）**：acorn 只扫描顶层声明（零改写模型代码）；存活绑定注入为
 *    函数参数（let 语义——const 二次声明零 SyntaxError）+ epilogue __$extract 按名提取终值
 *    （引用变异自然持久，重赋值经 getter 回写）；失败调用按快照回退注入绑定（replaced 表同源），
 *    本次新声明整体丢弃——**状态语义如实标注**（D-QD1-8 preserved/dropped 明示）；
 *  - 隔离 = worker 进程（resourceLimits 同 fresh）——vm 非安全边界声明沿袭（本实现不引入 vm context，
 *    与 fresh 的 new Function 同域形态）；__proto__ 类名注入面 = 索引制按位传递非按名（DSH 实证安全点）；
 *  - 保留名面：__$* 前缀 / console / tools 用户顶层声明 = CAR-E-PTC-REPL fail-visible。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { parse } from 'acorn'
import { OutputLedger } from './ledger.ts'

const port = parentPort!
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

port.on('message', (m: { type: string; callId?: string; result?: unknown; error?: string }) => {
  if (m.type === 'tool-result' && m.callId) {
    const p = pending.get(m.callId)
    if (!p) return
    pending.delete(m.callId)
    if (m.error) p.reject(new Error(m.error))
    else p.resolve(m.result)
  }
})

const tools: Record<string, (args: unknown) => Promise<unknown>> = new Proxy({}, {
  get: (_, name: string) => (args: unknown) => new Promise((resolve, reject) => {
    const callId = Math.random().toString(36).slice(2)
    pending.set(callId, { resolve, reject })
    port.postMessage({ type: 'tool', callId, name, args })
  }),
})

const budget = (workerData as { budget: { maxWallMs: number; maxOutputBytes: number } }).budget

// ── 1.27.0 · REPL 模式（workerData.mode === 'repl'）─────────────────────────

interface ReplRunMessage {
  type: 'repl-run'
  callId: string
  code: string
  budget: { maxWallMs: number; maxOutputBytes: number }
  description: string
}

/** acorn 顶层声明名收集（只扫描零改写——D-QD1-4；解构 pattern 递归取 Identifier，非常规形态 fail-visible 交给保留名校验外的注入面） */
function topLevelDecls(js: string): string[] {
  // acorn = D-22 例外裁决随批（MIT/零传递依赖/parse-only——顶层静态 import）；allowAwaitOutsideFunction =
  // 顶层 await 为子链程序常态（acorn Program 顶层默认禁 await）
  const ast = parse(js, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true }) as unknown as { body: Array<Record<string, unknown>> }
  const names: string[] = []
  const collectPattern = (node: Record<string, unknown> | null | undefined): void => {
    if (!node || typeof node !== 'object') return
    const t = String(node['type'])
    if (t === 'Identifier') names.push(String(node['name']))
    else if (t === 'ObjectPattern') for (const p of (node['properties'] ?? []) as Array<Record<string, unknown>>) collectPattern((p['value'] ?? p['argument']) as Record<string, unknown> | null | undefined)
    else if (t === 'ArrayPattern') for (const el of (node['elements'] ?? []) as Array<Record<string, unknown> | null>) collectPattern(el)
    else if (t === 'RestElement') collectPattern(node['argument'] as Record<string, unknown> | null | undefined)
    else if (t === 'AssignmentPattern') collectPattern(node['left'] as Record<string, unknown> | null | undefined)
    // 其他形态（MemberExpression 计算键等）不收集——绑定面窄化安全（少注入不误注入）
  }
  for (const stmt of ast.body) {
    const t = String(stmt['type'])
    if (t === 'VariableDeclaration') for (const d of stmt['declarations'] as Array<Record<string, unknown>>) collectPattern(d['id'] as Record<string, unknown> | null | undefined)
    else if (t === 'FunctionDeclaration' || t === 'ClassDeclaration') {
      const id = stmt['id'] as Record<string, unknown> | null
      if (id) names.push(String(id['name']))
    }
  }
  return names
}

function startRepl(): void {
  const printedMaxDefault = (workerData as { printedMax: number }).printedMax
  const holders = new Map<string, () => unknown>() // name → getter（终值提取面——重赋值经 getter 回写）
  const fmtArg = (a: unknown): string => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))
  const pendingRepl = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  port.on('message', (m: { type: string; callId?: string; result?: unknown; error?: string }) => {
    if (m.type === 'release') process.exit(0)
    if (m.type === 'tool-result' && m.callId) {
      const p = pendingRepl.get(m.callId)
      if (!p) return
      pendingRepl.delete(m.callId)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.result)
    }
  })

  const replTools: Record<string, (args: unknown) => Promise<unknown>> = new Proxy({}, {
    get: (_, name: string) => (args: unknown) => new Promise((resolve, reject) => {
      const callId = Math.random().toString(36).slice(2)
      pendingRepl.set(callId, { resolve, reject })
      port.postMessage({ type: 'tool', callId, name, args })
    }),
  })

  port.on('message', (raw: unknown) => {
    const m = raw as ReplRunMessage & { type: string; printedMax?: number }
    if (m.type !== 'repl-run') return
    const started = Date.now()
    const ledger = new OutputLedger(m.printedMax ?? printedMaxDefault) // 每调用一 ledger（打印面 = 本调用窗口；per-call 预算覆盖创建时缺省——D-QD1-3）
    const consoleProxy = {
      log: (...a: unknown[]) => ledger.append(a.map(fmtArg).join(' ') + '\n'),
      info: (...a: unknown[]) => ledger.append(a.map(fmtArg).join(' ') + '\n'),
      warn: (...a: unknown[]) => ledger.append(a.map(fmtArg).join(' ') + '\n'),
      error: (...a: unknown[]) => ledger.append(a.map(fmtArg).join(' ') + '\n'),
    }
    const finish = (msg: { error?: string }): void => {
      const snap = ledger.snapshot()
      port.postMessage({
        type: 'repl-done',
        callId: m.callId,
        printed: snap.text,
        printedTruncated: snap.truncated,
        bindings: [...holders.keys()],
        ...(snap.truncated ? { outputLimit: true } : {}),
        ...(msg.error ? { error: msg.error } : {}),
        span: { startMs: started, endMs: Date.now() },
      })
    }
    const wallTimer = setTimeout(() => finish({ error: `budget-exceeded (maxWallMs)——预算到期为资源护栏（REPL 状态保留面由主侧 killer 裁决——terminate = 状态丢失如实报告）` }), m.budget.maxWallMs)
    void (async () => {
      let snapshot: Array<[string, unknown]> = []
      try {
        // 1. erasable TS 剥离（同 fresh：wrap→strip；**直接裸剥**——顶层 return = ERR_INVALID_TYPESCRIPT_SYNTAX
        //    fail-visible，inspect-only 契约自然形态〔末表达式本就丢弃——return 无意义〕，登记）
        const { stripTypeScriptTypes } = await import('node:module')
        const js = stripTypeScriptTypes(m.code, { mode: 'strip' })
        // 2. acorn 顶层声明扫描（D-QD1-4）
        const decls = topLevelDecls(js)
        for (const n of decls) {
          if (/^__\$/.test(n) || n === 'console' || n === 'tools' || n === '__$extract') {
            finish({ error: `CAR-E-PTC-REPL: 保留名 "${n}" 不可声明（__$* 前缀 / console / tools——环境注入面冲突 fail-visible）` })
            clearTimeout(wallTimer)
            return
          }
        }
        // 3. 注入面 = 存活绑定 − 本次重声明（重声明走用户自己的 const——提取面覆盖）
        const injected = [...holders.keys()].filter((n) => !decls.includes(n))
        // 4. epilogue 提取面 = 本次声明 ∪ 注入（重赋值经 getter 回写——引用变异自然持久）
        const extractNames = [...new Set([...decls, ...injected])]
        const extractEntries = extractNames.map((n) => `${JSON.stringify(n)}: () => ${n}`).join(',')
        // 内层零参数形态：环境面（__$extract/console/tools）与注入绑定全部闭包捕获外层参数——
        // 内层重声明同名参数会被无参调用置 undefined（首版实测坑，probe-repl3 实锤）
        const src = `"use strict";\nreturn async function() {\n${js}\n;__$extract({${extractEntries}});\n}`
        const fnFactory = new Function('__$extract', 'console', 'tools', ...injected, src) as (...args: unknown[]) => () => Promise<void>
        snapshot = injected.map((n) => [n, structuredClone(holders.get(n)!())] as [string, unknown])
        const extractors: Record<string, () => unknown> = {}
        const extract = (o: Record<string, () => unknown>): void => void Object.assign(extractors, o)
        const fn = fnFactory(extract, consoleProxy, replTools, ...injected.map((n) => holders.get(n)!()))
        await fn()
        clearTimeout(wallTimer)
        for (const [n, get] of Object.entries(extractors)) holders.set(n, get)
        finish({})
      } catch (e) {
        clearTimeout(wallTimer)
        // 失败回退（replaced 表同源）：注入绑定回快照（部分执行的重赋值不污染）；本次新声明整体丢弃
        for (const [n, v] of snapshot) holders.set(n, () => v)
        finish({ error: String(e) })
      }
    })()
  })
}

// ── 模式分派（1.27.0：fresh 原样 / REPL 新支）──────────────────────────────

const workerMode = (workerData as { mode?: string }).mode
if (workerMode === 'repl') {
  startRepl()
} else {
  // 1.8-D31：程序窗口计时（null = 程序未启动——wallTimer 抢先不产 span 字段）
  let spanStart: number | null = null
  const finish = (msg: { type: 'done'; result?: unknown; error?: string }) => {
    port.postMessage({ ...msg, ...(spanStart !== null ? { span: { startMs: spanStart, endMs: Date.now() } } : {}) })
    setTimeout(() => process.exit(0), 50) // 让消息冲刷
  }

  const wallTimer = setTimeout(() => finish({ type: 'done', error: `budget-exceeded (maxWallMs=${budget.maxWallMs})——预算到期为资源护栏，不掐 turn（工具错误结果交回模型）` }), budget.maxWallMs)

  void (async () => {
    try {
      const code = (workerData as { code: string }).code
      // erasable-only 的执行端：eval 前剥离类型（Node 22.13+ 内置 stripTypeScriptTypes）——
      // 程序体是 erasable TS（含类型注解），new Function 是纯 JS 求值器，不剥离则注解即 SyntaxError
      const { stripTypeScriptTypes } = await import('node:module')
      // stripTypeScriptTypes 以「模块」语义解析——片段含顶层 return 会报 ERR_INVALID_TYPESCRIPT_SYNTAX；
      // 故先包成 export default 箭头函数再剥离，剥离后还原为 return 表达式（程序体含字面 export default 不受支持，见 erasable 禁项）
      const wrapped = 'export default async () => {\n' + code + '\n}'
      const js = stripTypeScriptTypes(wrapped, { mode: 'strip' })
      const body = js.replace(/^export default /, 'return ')
      // 程序体 = async 函数体（顶层 await/return）；tools 为受控 proxy（仅显式调用，无宿主 import 面）
      const fn = new Function('tools', '"use strict";\n' + body + '\n') as (t: typeof tools) => () => Promise<unknown>
      spanStart = Date.now()
      const result = await fn(tools)()
      clearTimeout(wallTimer)
      const out = JSON.stringify(result ?? null)
      if (Buffer.byteLength(out) > budget.maxOutputBytes) {
        finish({ type: 'done', error: `budget-exceeded (maxOutputBytes=${budget.maxOutputBytes})` })
        return
      }
      finish({ type: 'done', result: JSON.parse(out) })
    } catch (e) {
      clearTimeout(wallTimer)
      finish({ type: 'done', error: String(e) })
    }
  })()
}
