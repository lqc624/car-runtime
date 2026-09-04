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

export type EventKind = 'user' | 'assistant' | 'toolCall' | 'toolResult' | 'turnEnd'
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

  constructor(sessionId = 'S-' + Date.now().toString(36)) {
    this.sessionId = sessionId
  }

  /** 唯一写入路径（append-only；无 update/delete API） */
  append(actor: Actor, kind: EventKind, turnId: string, payload: unknown, meta?: Record<string, unknown>): SessionEvent {
    const e: Omit<SessionEvent, 'hash'> = {
      seq: this.events.length, ts: Date.now(), actor, kind, turnId, payload, meta, prevHash: this.#tail,
    }
    const full: SessionEvent = { ...e, hash: canonical(e) }
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

  /** 导出取证数据（MVP 基础导出：JSONL 全量 + 审计元数据；F15 完整包为 M2） */
  exportJSONL(): string {
    return this.events.map(e => JSON.stringify(e)).join('\n') + '\n'
  }
}

/** 从 JSONL 文件加载并校验哈希链（审计回放/跨机迁移入口；断链即拒绝装载） */
export function loadSessionLog(file: string): { log: SessionLog; brokenAt: number | null } {
  const log = new SessionLog(file)
  const lines = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim())
  for (const line of lines) {
    const e = JSON.parse(line) as SessionEvent
    // 直接重建（绕过 append 的哈希计算），随后用 verifyChain 校验完整性
    ;(log.events as SessionEvent[]).push(e)
  }
  return { log, brokenAt: log.verifyChain() }
}

export { sha as sha256Hex }
