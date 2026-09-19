/**
 * append-only 会话日志层（F2 / N1 —— POC-3 断言框架的产品化）
 *
 * 设计口径：
 *  - 哈希链（SHA-256）为 CAR 自研增强（dsh 无此物，源码级核实）——合规卖点落地
 *  - 「Model-visible means logged」：断言口径 = 请求时快照 === 日志前缀 [0, atSeq) 投影
 *  - append-only：本层仅暴露 append/verifyChain/deriveMessages/assertModelVisibleLogged
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { decodeLogBuffer, splitJsonlLines } from './format.ts'

export type EventKind = 'user' | 'assistant' | 'toolCall' | 'toolResult' | 'turnEnd' | 'goalUpdate' | 'hostRaw' | 'fork' // M3-S11 加法扩展：多宿主归一化降级通道（pattern 未命中留痕，零静默）；M5-DEC4 加法扩展：跨宿主 fork 标记事件；六值 TurnEndReason 不变
export type Actor = 'user' | 'model' | 'plugin' | 'runtime'
export interface SessionEvent {
  seq: number
  ts: number
  actor: Actor
  kind: EventKind
  turnId: string
  payload: unknown
  meta?: Record<string, unknown>
  prevHash: string
  hash: string
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const canonical = (e: Omit<SessionEvent, 'hash'>) =>
  sha(JSON.stringify({ seq: e.seq, ts: e.ts, actor: e.actor, kind: e.kind, turnId: e.turnId, payload: e.payload, meta: e.meta ?? null, prevHash: e.prevHash }))

export interface ModelSnapshot {
  /** 快照对应日志前缀边界（事件数），断言时逐字节比对前缀投影 */
  atSeq: number
  request: unknown[]
}

export class SessionLog {
  readonly sessionId: string
  events: readonly SessionEvent[] = []
  #tail = 'GENESIS'
  #snapshots: ModelSnapshot[] = []
  #sink: ((line: string) => void) | null = null

  constructor(sessionId = 'S-' + Date.now().toString(36)) {
    this.sessionId = sessionId
  }

  /**
   * 挂载落盘 sink（§3.2.M7.5 Step 1-2「先落日志后放行」）：append 时同步写盘，
   * sink 成功后才入内存；sink throw = 写失败 fail-fast（事件不入内存、不推进链尾，
   * 调用方当前 turn 以 error 收口——内存与盘面永不失配）。
   */
  attachSink(sink: (line: string) => void): void {
    this.#sink = sink
  }

  /** 唯一写入路径（append-only；无 update/delete API） */
  append(actor: Actor, kind: EventKind, turnId: string, payload: unknown, meta?: Record<string, unknown>): SessionEvent {
    const e: Omit<SessionEvent, 'hash'> = {
      seq: this.events.length, ts: Date.now(), actor, kind, turnId, payload, meta, prevHash: this.#tail,
    }
    const full: SessionEvent = { ...e, hash: canonical(e) }
    if (this.#sink) this.#sink(JSON.stringify(full))
    this.events = [...this.events, full]
    this.#tail = full.hash
    return full
  }

  /** 模型请求发起时调用（agent-loop 集成点）：登记「请求时快照」 */
  snapshotModelRequest(): ModelSnapshot {
    const snap: ModelSnapshot = { atSeq: this.events.length, request: structuredClone(this.deriveMessages(this.events.length)) }
    this.#snapshots.push(snap)
    return snap
  }

  /** 逐链校验；返回 null=完整，否则断链事件序号（审计导出前置，断链即中止） */
  verifyChain(): number | null {
    let prev = 'GENESIS'
    for (const e of this.events) {
      if (e.prevHash !== prev || e.hash !== canonical(e)) return e.seq
      prev = e.hash
    }
    return null
  }

  /** 投影：从日志前缀重建模型可见消息流（不依赖模型运行时状态） */
  deriveMessages(upTo?: number): Array<{ role: string; [k: string]: unknown }> {
    const out: Array<{ role: string; [k: string]: unknown }> = []
    for (const e of this.events) {
      if (upTo !== undefined && e.seq >= upTo) break
      if (e.kind === 'user') out.push({ role: 'user', content: e.payload })
      else if (e.kind === 'assistant') out.push({ role: 'assistant', content: e.payload })
      else if (e.kind === 'toolCall') out.push({ role: 'assistant', toolCall: e.payload })
      else if (e.kind === 'toolResult') out.push({ role: 'toolResult', content: e.payload })
    }
    return out
  }

  /** N1 不变量断言（CI 门禁雏形）：全部快照必须与当前日志前缀投影逐字节一致 */
  assertModelVisibleLogged(): { ok: boolean; failedAt?: number } {
    for (const s of this.#snapshots) {
      if (JSON.stringify(s.request) !== JSON.stringify(this.deriveMessages(s.atSeq))) {
        return { ok: false, failedAt: s.atSeq }
      }
    }
    return { ok: true }
  }

  /** 只读统计（供监控/测试） */
  stats() {
    return { events: this.events.length, snapshots: this.#snapshots.length, tailHash: this.#tail }
  }

  /** 从已校验事件数组重建（恢复 #tail，续跑 append 不断链——跨宿主 fork/resume 装载入口） */
  static fromEvents(sessionId: string, events: readonly SessionEvent[]): SessionLog {
    const log = new SessionLog(sessionId)
    ;(log.events as SessionEvent[]) = [...events]
    const last = events[events.length - 1]
    if (last) log.#tail = last.hash
    return log
  }

  /** 导出取证数据（MVP 基础导出：JSONL 全量 + 审计元数据；F15 完整包为 M2） */
  exportJSONL(): string {
    return this.events.map(e => JSON.stringify(e)).join('\n') + '\n'
  }
}

/** 文件路径 → sessionId 推导：`session-<id>.jsonl[.zstd]` 去前缀后缀；`events.jsonl` 取父目录名（审计定位口径） */
export function deriveSessionId(file: string): string {
  const base = file.replace(/.*[/\\]/, '')
  let id = base.replace(/\.jsonl\.zstd$/, '').replace(/\.jsonl$/, '')
  if (id === 'events') {
    const dir = file.replace(/[\\/][^/\\]*$/, '')
    const name = dir.replace(/.*[/\\]/, '')
    if (name && name !== dir) id = name // 有父目录才取父目录名，否则保留 'events'
  } else if (id.startsWith('session-')) id = id.slice('session-'.length)
  return id
}

/**
 * 从 JSONL 文件装载（审计回放/跨机迁移入口）。格式层语义见 format.ts：
 * 撕裂尾显式报告（丢弃崩溃半行，不静默）；完整行解析失败 CAR-E-FORMAT 拒绝装载；
 * 断链 = brokenAt 返回（由调用方决定中止口径）。zstd 文件按 magic 嗅探直读。
 */
export function loadSessionLog(file: string): {
  log: SessionLog
  brokenAt: number | null
  encoding: 'plain' | 'zstd'
  tornTail: boolean
  tornTailBytes: number
} {
  const { text, encoding } = decodeLogBuffer(readFileSync(file))
  const { lines, tornTail, tornTailBytes } = splitJsonlLines(text)
  const events = lines.map((l, i) => {
    try { return JSON.parse(l) as SessionEvent }
    catch (e) { throw new Error(`CAR-E-FORMAT: ${file} 第 ${i + 1} 行非法 JSON——拒绝装载带病日志（${(e as Error).message}）`) }
  })
  const log = SessionLog.fromEvents(deriveSessionId(file), events)
  return { log, brokenAt: log.verifyChain(), encoding, tornTail, tornTailBytes }
}

export { sha as sha256Hex }
