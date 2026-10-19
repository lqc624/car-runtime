/**
 * 1.15-S1 · 白盒记忆面（K-MEM-1 / D-46）——存储 + CRUD 落链 + 注入装载
 *
 * 口径（红线先立后码）：
 *  - **审计链同源（差异化核心，D-V02-2）**：记忆 write/edit/delete/rollback 全部落会话
 *    JSONL 审计事件（EventKind='memory'，actor='user'，turnId='memory'——会话级能力面，
 *    同 'compaction' 先例），哈希链保护——记忆篡改在链上可见；**链即版本库**：rollback
 *    的恢复数据源 = 链上历史事件的 payload（before/after 全文），不依赖文件系统历史；
 *  - **append-only 红线**：CRUD 只走 SessionLog.append（SessionLog 无 update/delete API）；
 *    delete 与 rollback 均为补偿事件追加，已落链事件零改写；node:test 断言操作前后
 *    verifyChain() 均 null 且旧事件逐字节不变；
 *  - **存储形态（D-46 ①）**：`<workspace>/.car/memory/` 逐条 JSON 文件（记忆 id 为文件名，
 *    内含正文 + 元数据），与 `.car/sessions/` 每会话一文件同构——白盒可见性最强、CRUD
 *    单条原子性天然；写入 = 临时文件 + rename 原子替换（半文件不落地）；工作区分片 =
 *    不同 dir 的 store 实例天然隔离；id 即文件名——形态校验拒绝路径穿越（fail-visible）；
 *  - **落链作用域（D-46 ②）**：CRUD 事件落调用方传入的会话链（宿主指定当前活跃会话
 *    承载）；log 参数必填——无会话上下文调用显式拒绝（CAR-E-MEM-NOCHAIN，fail-visible，
 *    不留旁路写入通道）；
 *  - **落链与文件动作顺序（§3.2.M7.5 同源）**：先落链（sink 成功后才入内存）后写文件——
 *    审计链为权威；文件动作失败 CAR-E-MEM-IO 显式抛出（调用方知情，fail-visible）；
 *  - **注入装载（D-46 ③④）**：loadMemoryForInjection 出确定性拼装文本（updatedAt 降序，
 *    全量装入——禁静默选择性注入），字符近似预算门控（行为门控非计量出数，D-41 不适用）；
 *    超预算 CAR-E-MEM-BUDGET fail-visible 不静默截断；注入落链由宿主装配层执行（turn
 *    开始前 append system ctx 行 = D-C3 预留位，Model-visible means logged 由构造保证）；
 *  - **零凭据路径**：本模块不读 env、不触 CredentialService（spec 行为断言锁定）；
 *  - **零新依赖**：node:fs / node:crypto 内置件；v0.2 收窄 = 手动白盒（D-V02-4）——
 *    自动抽取/Dream/向量检索/全文匹配过滤均不做（登记可溯）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SessionLog } from '../session/log.ts'

export type MemoryOp = 'write' | 'edit' | 'delete' | 'rollback'

export interface MemoryEntry {
  id: string
  text: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  /** 创建来源会话（write 时调用方提供；可溯性辅助，非鉴权字段） */
  sourceSession?: string
}

/** 链上 memory 事件 payload 统一形态（kind='memory'，payload.type 区分操作） */
export interface MemoryEventPayload {
  type: MemoryOp
  id: string
  /** 操作后状态正文：write 的初始正文 / edit 的新正文 / rollback 的恢复正文；delete 与回退到删除态时缺席 */
  text?: string
  /** 操作前状态正文：edit 的被替换正文 / delete 的被删正文 / rollback 的被回退正文（链即版本库的恢复数据源） */
  before?: string
  tags?: string[]
  /** rollback 溯源：被回退到的状态所对应的事件 seq */
  fromSeq?: number
}

/** id 即文件名——禁路径穿越：字母数字开头，仅 [A-Za-z0-9._-]，且不接纳以 '.' 开头的隐藏态（write 派生 id 恒字母开头） */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function assertValidId(id: string): void {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) {
    throw new Error(`CAR-E-MEM-ID: 非法记忆 id "${String(id).slice(0, 64)}"（允许：字母/数字开头，[A-Za-z0-9._-]，≤128——id 即文件名，路径穿越 fail-visible 拒绝）`)
  }
}

export class MemoryStore {
  readonly dir: string
  /** 时钟缝（1.15.2 测试可观测性）：缺省 Date.now；spec 注入受控时钟消除同毫秒排序竞态 */
  readonly #now: () => number

  constructor(dir: string, opts?: { now?: () => number }) {
    this.dir = dir
    this.#now = opts?.now ?? Date.now
    mkdirSync(dir, { recursive: true })
  }

  #file(id: string): string {
    assertValidId(id)
    return join(this.dir, `${id}.json`)
  }

  /** 列出全部记忆（updatedAt 降序——最近维护优先）；坏文件显式拒绝（带病不静默，loadSessionLog 同纪律） */
  list(): MemoryEntry[] {
    const out: MemoryEntry[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      const file = join(this.dir, name)
      let entry: MemoryEntry
      try {
        entry = JSON.parse(readFileSync(file, 'utf8')) as MemoryEntry
      } catch (e) {
        throw new Error(`CAR-E-MEM-FORMAT: 记忆文件 ${name} 非法 JSON——拒绝带病装载（${(e as Error).message}）`)
      }
      if (typeof entry?.id !== 'string' || typeof entry?.text !== 'string') {
        throw new Error(`CAR-E-MEM-FORMAT: 记忆文件 ${name} 缺 id/text 字段——拒绝带病装载`)
      }
      out.push(entry)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): MemoryEntry | undefined {
    const file = this.#file(id)
    if (!existsSync(file)) return undefined
    const entry = JSON.parse(readFileSync(file, 'utf8')) as MemoryEntry
    if (typeof entry?.id !== 'string' || typeof entry?.text !== 'string') {
      throw new Error(`CAR-E-MEM-FORMAT: 记忆文件 ${id}.json 缺 id/text 字段——拒绝带病装载`)
    }
    return entry
  }

  /** 原子写（临时文件 + rename——半文件不落地） */
  #writeFile(entry: MemoryEntry): void {
    const file = this.#file(entry.id)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  }

  /**
   * 创建记忆：落 memory/write 事件（payload 携带完整正文）→ 原子写文件。
   * id 缺省派生 `mem-<ts36>-<rand>`；对已存在 id 冲突显式拒绝（改用 edit）。
   */
  write(log: SessionLog, input: { id?: string; text: string; tags?: string[]; sourceSession?: string }): MemoryEntry {
    if (!log || typeof log.append !== 'function') {
      throw new Error('CAR-E-MEM-NOCHAIN: 记忆 CRUD 必须传入会话链（D-46 ②：落链作用域 = 宿主指定活跃会话；无会话上下文显式拒绝，不留旁路写入通道）')
    }
    if (typeof input?.text !== 'string' || !input.text.trim().length) {
      throw new Error('CAR-E-MEM-EMPTY: 记忆正文为空（fail-visible——空正文条目无白盒价值，禁静默落盘）')
    }
    const id = input.id ?? `mem-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    assertValidId(id)
    if (this.get(id)) {
      throw new Error(`CAR-E-MEM-EXISTS: 记忆 "${id}" 已存在（write 冲突 fail-visible——修改请走 edit）`)
    }
    const now = this.#now()
    const entry: MemoryEntry = { id, text: input.text, createdAt: now, updatedAt: now }
    if (input.tags?.length) entry.tags = [...input.tags]
    if (input.sourceSession) entry.sourceSession = input.sourceSession
    log.append('user', 'memory', 'memory', { type: 'write', id, text: entry.text, ...(entry.tags ? { tags: entry.tags } : {}) } satisfies MemoryEventPayload)
    try {
      this.#writeFile(entry)
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆文件写入失败 "${id}"（事件已落链——盘面动作失败显式抛出，§3.2.M7.5 落链先行动作顺序；${(e as Error).message}）`)
    }
    return entry
  }

  /** 修改记忆：落 memory/edit 事件（payload before/after 全文——rollback 的恢复数据源）→ 原子重写 */
  edit(log: SessionLog, id: string, text: string, tags?: string[]): MemoryEntry {
    if (!log || typeof log.append !== 'function') {
      throw new Error('CAR-E-MEM-NOCHAIN: 记忆 CRUD 必须传入会话链（D-46 ②；无会话上下文显式拒绝）')
    }
    const prev = this.#mustGet(id)
    if (typeof text !== 'string' || !text.trim().length) {
      throw new Error(`CAR-E-MEM-EMPTY: 记忆 "${id}" 新正文为空（fail-visible——清空请走 delete）`)
    }
    // tags 语义：undefined = 不变（payload 不带键，重放取前态）；数组 = 整体替换（含空数组 =
    // 清空，payload 恒带键——重放 [] 与清空同构，禁「带键/缺键」二义）
    const next: MemoryEntry = { ...prev, text, updatedAt: this.#now() }
    if (tags !== undefined) {
      const { tags: _drop, ...rest } = next as MemoryEntry & { tags?: string[] }
      void _drop
      const cleaned = tags.length ? { ...(rest as MemoryEntry), tags: [...tags] } : rest
      log.append('user', 'memory', 'memory', { type: 'edit', id, before: prev.text, text, tags } satisfies MemoryEventPayload)
      try { this.#writeFile(cleaned as MemoryEntry) } catch (e) {
        throw new Error(`CAR-E-MEM-IO: 记忆文件写入失败 "${id}"（事件已落链；${(e as Error).message}）`)
      }
      return cleaned as MemoryEntry
    }
    log.append('user', 'memory', 'memory', { type: 'edit', id, before: prev.text, text } satisfies MemoryEventPayload)
    try { this.#writeFile(next) } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆文件写入失败 "${id}"（事件已落链；${(e as Error).message}）`)
    }
    return next
  }

  /** 删除记忆：落 memory/delete 事件（payload 携带被删正文——rollback 可恢复）→ 删文件 */
  remove(log: SessionLog, id: string): void {
    if (!log || typeof log.append !== 'function') {
      throw new Error('CAR-E-MEM-NOCHAIN: 记忆 CRUD 必须传入会话链（D-46 ②；无会话上下文显式拒绝）')
    }
    const prev = this.#mustGet(id)
    log.append('user', 'memory', 'memory', { type: 'delete', id, before: prev.text } satisfies MemoryEventPayload)
    try {
      rmSync(this.#file(id))
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆文件删除失败 "${id}"（事件已落链；${(e as Error).message}）`)
    }
  }

  /**
   * 回滚记忆：沿事件链单步时间回退（undo 栈语义——连续回退逐版本回走：v3→v2→v1）。
   * 恢复数据源 = 链上版本栈重放（链即版本库，不依赖文件系统历史）。落 memory/rollback
   * 事件（before/after 全文 + fromSeq 溯源）→ 文件动作。返回 null = 回退到删除态。
   * 语义：edit 后回退 → 恢复 before；delete 后回退 → undelete（恢复被删正文）；
   * 仅剩 write 初始版 / 链上无历史 → CAR-E-MEM-NOREV。
   */
  rollback(log: SessionLog, id: string): MemoryEntry | null {
    if (!log || typeof log.append !== 'function') {
      throw new Error('CAR-E-MEM-NOCHAIN: 记忆 CRUD 必须传入会话链（D-46 ②；无会话上下文显式拒绝）')
    }
    const states = this.#rebuildStates(log, id)
    if (states.length < 2) {
      throw new Error(states.length
        ? `CAR-E-MEM-NOREV: 记忆 "${id}" 已处初始版本（write seq=${states[0]!.seq}，无更早状态可回退——fail-visible）`
        : `CAR-E-MEM-NOREV: 记忆 "${id}" 无链上历史（rollback 数据源 = 审计链——链外写入的条目无版本可回退，fail-visible）`)
    }
    const cur = states[states.length - 1]!
    const target = states[states.length - 2]! // 单步回退目标（present 或 absent）
    log.append('user', 'memory', 'memory', {
      type: 'rollback',
      id,
      ...(cur.present ? { before: cur.text! } : {}),
      ...(target.present ? { text: target.text!, ...(target.tags ? { tags: target.tags } : {}) } : {}),
      fromSeq: cur.seq,
    } satisfies MemoryEventPayload)
    try {
      if (target.present) {
        const entry: MemoryEntry = { id, text: target.text!, createdAt: target.createdAt!, updatedAt: this.#now() }
        if (target.tags?.length) entry.tags = [...target.tags]
        if (target.sourceSession) entry.sourceSession = target.sourceSession
        this.#writeFile(entry)
        return entry
      }
      rmSync(this.#file(id))
      return null // 回退到删除态：条目移除（调用方以 get 校验）
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆文件动作失败 "${id}"（事件已落链；${(e as Error).message}）`)
    }
  }

  #mustGet(id: string): MemoryEntry {
    const prev = this.get(id)
    if (!prev) {
      throw new Error(`CAR-E-MEM-NOENT: 记忆 "${id}" 不存在（fail-visible——先 write 再操作）`)
    }
    return prev
  }

  /**
   * 链上版本栈重放：按 seq 序重放该 id 的全部 memory 事件。write/edit → push present；
   * delete → push absent；**rollback → pop（单步时间回退的重放同构——调用时回退一步，
   * 重放时同样回退一步，pop 后栈顶即当前有效状态；连续 rollback 逐版本回走）**。
   * 栈底恒为 write 初始版；每个状态记录来源事件 seq（fromSeq 溯源）+ 进入时的正文/元数据。
   */
  #rebuildStates(log: SessionLog, id: string): Array<{ seq: number; present: boolean; text?: string; tags?: string[]; createdAt?: number; sourceSession?: string }> {
    assertValidId(id)
    const stack: Array<{ seq: number; present: boolean; text?: string; tags?: string[]; createdAt?: number; sourceSession?: string }> = []
    for (const e of log.events) {
      if (e.kind !== 'memory') continue
      const p = (e.payload ?? {}) as MemoryEventPayload
      if (p.id !== id) continue
      const prevTop = stack[stack.length - 1]
      if (p.type === 'write') stack.push({ seq: e.seq, present: true, text: p.text, tags: p.tags, createdAt: e.ts, sourceSession: prevTop?.sourceSession })
      else if (p.type === 'edit') stack.push({ seq: e.seq, present: true, text: p.text, tags: p.tags, createdAt: prevTop?.createdAt ?? e.ts, sourceSession: prevTop?.sourceSession })
      else if (p.type === 'delete') stack.push({ seq: e.seq, present: false })
      else if (p.type === 'rollback') stack.pop() // 单步回退重放同构（栈空 pop 为坏链防御——正常链形不发生）
    }
    return stack
  }
}

export interface MemoryInjectionResult {
  count: number
  totalChars: number
  /** 确定性拼装文本（updatedAt 降序全量）——宿主落 system ctx 行的原文（D-C3 预留位） */
  rendered: string
}

/**
 * 注入装载：全量装入（updatedAt 降序，禁静默选择性注入——选择性 = 不可解释），
 * 字符近似预算门控（行为门控非计量出数；超预算 fail-visible 不静默截断——
 * 提示宿主调大预算或删减记忆）。空记忆 = 空串 + count 0（正常态非错误，宿主跳过注入行）。
 */
export function loadMemoryForInjection(store: MemoryStore, opts: { budgetChars: number }): MemoryInjectionResult {
  const budget = opts?.budgetChars
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    throw new Error(`CAR-E-MEM-BUDGET: 注入预算非法（${String(budget)}）——须为正数（字符近似门控口径）`)
  }
  const entries = store.list()
  if (!entries.length) return { count: 0, totalChars: 0, rendered: '' }
  const lines = entries.map(e => `- [${e.id}] ${e.text.replace(/\r?\n/g, ' ')}`)
  const rendered = `[CAR 记忆注入] 共 ${entries.length} 条：\n${lines.join('\n')}`
  if (rendered.length > budget) {
    throw new Error(`CAR-E-MEM-BUDGET: 记忆注入超预算（${rendered.length} > ${budget} 字符）——fail-visible 禁静默截断（调大预算或删减记忆）`)
  }
  return { count: entries.length, totalChars: rendered.length, rendered }
}
