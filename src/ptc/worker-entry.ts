/**
 * PTC worker 入口（M3-S14）：隔离执行 PTC 程序体
 *
 * 协议：
 *  - workerData: { code, budget }；
 *  - 程序体 = async 函数体（顶层 await/return 支持，dsh 一手口径）；
 *  - tools proxy：await tools.<name>(args) → postMessage {type:'tool'} → 主线程执行 → {type:'tool-result'} 回传；
 *  - 预算：maxWallMs 计时超限 → done(error='budget-exceeded (maxWallMs)')；maxOutputBytes 序列化后检查；
 *  - done 消息单发即退——程序体 = 一次原子 toolCall（收口点唯一在 executor 返回）。
 */
import { parentPort, workerData } from 'node:worker_threads'

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
const finish = (msg: { type: 'done'; result?: unknown; error?: string }) => {
  port.postMessage(msg)
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
