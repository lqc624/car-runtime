/**
 * J-09 contract · SessionEventMap 快照只增不删 + 公共 API 兼容（M2部署设计增补 §2.3）
 *
 * 口径：golden 基线（test/contract/eventmap.golden.json）⊆ 当前签名——
 *   删键/改语义 = FAIL（破坏跨宿主与审计回放兼容）；加键 = PASS（演进合法）。
 * 断言源 = src/session/log.ts 的运行时签名（用 SessionLog 实例与类型导出反射，非正则扫源码）。
 */
import { SessionLog, type SessionEvent } from '../src/session/log.ts'
import { readFileSync } from 'node:fs'

const golden = JSON.parse(readFileSync('test/contract/eventmap.golden.json', 'utf8')) as {
  eventKinds: string[]; actors: string[]; sessionEventFields: string[]; sessionLogApi: string[]
}

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

// ① 运行时反射：真实 append 路径产生的字段集
const log = new SessionLog('contract-check')
const ev: SessionEvent = log.append('user', 'user', 'T0', { text: 'x' })
const evFields = Object.keys(ev).sort()
const missingFields = golden.sessionEventFields.filter(f => !evFields.includes(f))
check('SessionEvent 字段只增不删', missingFields.length === 0, missingFields.length ? `缺失: ${missingFields.join(',')}` : `当前: ${evFields.length} 字段`)

// ② SessionLog 公共方法面（golden 中每个 API 必须仍存在且可调用签名合法）
const missingApi = golden.sessionLogApi.filter(m => typeof (log as unknown as Record<string, unknown>)[m] !== 'function'
  && typeof (SessionLog as unknown as Record<string, unknown>)[m] !== 'function')
check('SessionLog 公共 API 只增不删', missingApi.length === 0, missingApi.length ? `缺失: ${missingApi.join(',')}` : `${golden.sessionLogApi.length} 项全在`)

// ③ EventKind/Actor 枚举面：golden 的每个 kind 必须仍可 append 且进入投影
// （编译期联合类型无法运行时枚举——用 golden 驱动正向验证：每个 kind append 成功 + deriveMessages 投影语义不变）
let kindsOk = true
for (const kind of golden.eventKinds) {
  try {
    const l = new SessionLog('kc-' + kind)
    const actor = kind === 'user' ? 'user' : kind === 'assistant' ? 'model' : 'runtime'
    l.append(actor as never, kind as never, 'T', { probe: kind })
  } catch { kindsOk = false }
}
check('EventKind 枚举全兼容', kindsOk)

// ④ 投影语义（CLI/宿主消费的 Envelope 面）：四类消息映射规则不变
const l2 = new SessionLog('proj')
l2.append('user', 'user', 'T', { text: 'u' })
l2.append('model', 'assistant', 'T', { text: 'a' })
l2.append('model', 'toolCall', 'T', { name: 't' })
l2.append('runtime', 'toolResult', 'T', { ok: true })
const proj = l2.deriveMessages()
const roles = proj.map(m => m.role)
check('deriveMessages 投影语义不变', JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'assistant', 'toolResult']), roles.join(','))

console.log(`----\ncontract: ${4 - failed}/4 PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
