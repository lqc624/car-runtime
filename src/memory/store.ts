/**
 * 1.15-S1 · 白盒记忆面（K-MEM-1 / D-46）——存储 + CRUD 落链 + 注入装载
 * 1.25.0 · 记忆召回层（Z-5 / Q-Z1 裁决 / D-Z5-1~9）——索引常驻 + 类型标注 + 召回式注入
 *
 * 口径（红线先立后码）：
 *  - **审计链同源（差异化核心，D-V02-2）**：记忆 write/edit/delete/rollback 全部落会话
 *    JSONL 审计事件（EventKind='memory'，actor='user'，turnId='memory'——会话级能力面，
 *    同 'compaction' 先例），哈希链保护——记忆篡改在链上可见；**链即版本库**：rollback
 *    的恢复数据源 = 链上历史事件的 payload（before/after 全文），不依赖文件系统历史；
 *  - **append-only 红线**：CRUD 只走 SessionLog.append（SessionLog 无 update/delete API）；
 *    delete 与 rollback 均为补偿事件追加，已落链事件零改写；node:test 断言操作前后
 *    verifyChain() 均 null 且旧事件逐字节不变；
 *  - **存储形态（D-46 ①，1.25 修订延伸）**：`<workspace>/.car/memory/` 逐条 JSON 文件（记忆
 *    id 为文件名，内含正文 + 元数据），与 `.car/sessions/` 每会话一文件同构——白盒可见性最强、
 *    CRUD 单条原子性天然；写入 = 临时文件 + rename 原子替换（半文件不落地）；工作区分片 =
 *    不同 dir 的 store 实例天然隔离；id 即文件名——形态校验拒绝路径穿越（fail-visible）；
 *    **1.25 增补派生索引 index.md（D-Z5-1）**：纯投影（单一事实源仍是逐条 JSON）+ CRUD 同步
 *    重写 + 读时 updatedAt 对拍修复三重兜底；索引重建不落链（纯投影维护非事实变更），
 *    driftRepaired 修复计数可见（禁静默）；
 *  - **落链作用域（D-46 ②）**：CRUD 事件落调用方传入的会话链（宿主指定当前活跃会话
 *    承载）；log 参数必填——无会话上下文调用显式拒绝（CAR-E-MEM-NOCHAIN，fail-visible，
 *    不留旁路写入通道）；
 *  - **落链与文件动作顺序（§3.2.M7.5 同源）**：先落链（sink 成功后才入内存）后写文件——
 *    审计链为权威；文件动作失败 CAR-E-MEM-IO 显式抛出（调用方知情，fail-visible）；
 *    **1.25 写序延伸（D-Z5-1）**：链 → 条目文件 → 索引重写（最后写）——索引半态由读时
 *    对拍自愈；
 *  - **注入装载（D-46 ③④，2026-11-21 红线修订生效——《ZCode318借鉴裁决记录-2026-11-21.md》§2）**：
 *    D-46 红线「禁静默选择性注入」修订为「**有据可查的选择性注入**」——召回依据（命中
 *    tags/keywords 键面 + 索引行）随注入事件 payload 落链，Model-visible means logged 不动摇；
 *    预算门语义改「**召回后仍超才拒**」；审计链同源原则不动摇——只修「选择性」的取证方式。
 *    两形态并存：①**legacy 全量注入** loadMemoryForInjection（updatedAt 降序全量装入，
 *    字符近似预算门控，超预算 fail-visible——行为逐字节不变，seam 只增不删）；②**1.25
 *    召回式注入** buildMemoryIndex（索引常驻）+ recallMemories（每 turn 确定性召回，零命中
 *    零注入零落链；matchedKeys = 命中键字面 = 「有据可查」的落链形态）；注入落链均由宿主
 *    装配层执行（system ctx 行，D-C3 预留位，Model-visible means logged 由构造保证）；
 *  - **零凭据路径**：本模块不读 env、不触 CredentialService（spec 行为断言锁定）；
 *  - **零新依赖**：node:fs / node:crypto 内置件；确定性红线延续（禁分词禁 LLM 判断禁估算——
 *    召回 = 确定性子串匹配，≥2 字符键门槛，matchedKeys 字面可审计）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SessionLog } from '../session/log.ts'

export type MemoryOp = 'write' | 'edit' | 'delete' | 'rollback'

/**
 * 记忆类型注册表（D-Z5-9：四型可裁剪 = 单一常量旋钮——加型/删型改此数组即可，
 * 链重放对未知 type 字符串透传不校验（校验只在 write/edit 入口），未来加型不破旧链）。
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryEntry {
  id: string
  text: string
  tags?: string[]
  /** 1.25（D-Z5-9）：类型标注（MEMORY_TYPES 注册表校验；缺席 = 无类型，存量兼容） */
  type?: MemoryType
  /** 1.25（D-Z5-9）：钩子句（索引行展示面；缺席 fallback = 正文首行截断 ≤80 字符，确定性非估算） */
  description?: string
  /** 1.25（D-Z5-2）：作者登记触发词（与 tags 并集构成召回匹配键面） */
  keywords?: string[]
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
  /** 1.25（D-Z5-9）：显式提供时携带（写/设置 = 值；清空 = null）；未触碰 = 缺席（与 tags「带键/缺键」二义禁令同纪律） */
  memType?: MemoryType | null
  description?: string
  keywords?: string[]
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

/** 类型校验（D-Z5-9：仅 write/edit 入口——非法值 fail-visible；链重放透传不校验） */
function assertValidType(type: MemoryType): void {
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    throw new Error(`CAR-E-MEM-TYPE: 非法记忆类型 "${String(type)}"（注册表：${MEMORY_TYPES.join('/')}——四型可裁剪，非法值 fail-visible）`)
  }
}

/** 索引行 description 单行化 + 缺席 fallback（正文首行截断 ≤80 字符——确定性非估算，对拍口径两处同源） */
function indexDescriptionOf(entry: MemoryEntry): string {
  const raw = entry.description ?? (entry.text.split(/\r?\n/)[0] ?? '')
  return raw.replace(/\r?\n/g, ' ').slice(0, entry.description === undefined ? 80 : Number.POSITIVE_INFINITY)
}

/** 索引行（文件面带 u token，注入面不带——两形态单一事实源同源派生） */
function indexLineOf(entry: MemoryEntry, withToken: boolean): string {
  const typeSeg = entry.type ? ` [${entry.type}]` : ''
  const uSeg = withToken ? ` u${entry.updatedAt.toString(36)}` : ''
  return `- [${entry.id}]${typeSeg}${uSeg} ${indexDescriptionOf(entry)}`
}

/** index.md 文件头（白盒注记——手改无效，读时对拍重建覆盖） */
const INDEX_HEADER = '# CAR 记忆索引（派生面——CRUD 自动重写；手改/漂移在读时对拍修复，勿手编）'

function indexFileContentOf(entries: MemoryEntry[]): string {
  const lines = entries.map((e) => indexLineOf(e, true))
  return lines.length ? `${INDEX_HEADER}\n${lines.join('\n')}\n` : `${INDEX_HEADER}\n`
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

  #indexFile(): string {
    return join(this.dir, 'index.md')
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

  /** 原子写（临时文件 + rename——半文件不落地；索引与条目同纪律） */
  #writeFile(entry: MemoryEntry): void {
    const file = this.#file(entry.id)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  }

  /**
   * 索引重写（D-Z5-1：CRUD 同步重写——写序最后一步，半态由读时对拍自愈）。
   * 内容 = list() 派生投影；失败 CAR-E-MEM-IO 显式抛出（fail-visible，调用方知情）。
   */
  #rewriteIndex(): void {
    const content = indexFileContentOf(this.list())
    const file = this.#indexFile()
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, content, 'utf8')
      renameSync(tmp, file)
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆索引重写失败 index.md（条目已落盘——索引半态由下次读时对拍自愈；${(e as Error).message}）`)
    }
  }

  /**
   * 创建记忆：落 memory/write 事件（payload 携带完整正文 + 1.25 三可选键）→ 原子写文件 → 索引重写。
   * id 缺省派生 `mem-<ts36>-<rand>`；对已存在 id 冲突显式拒绝（改用 edit）。
   */
  write(log: SessionLog, input: { id?: string; text: string; tags?: string[]; type?: MemoryType; description?: string; keywords?: string[]; sourceSession?: string }): MemoryEntry {
    if (!log || typeof log.append !== 'function') {
      throw new Error('CAR-E-MEM-NOCHAIN: 记忆 CRUD 必须传入会话链（D-46 ②：落链作用域 = 宿主指定活跃会话；无会话上下文显式拒绝，不留旁路写入通道）')
    }
    if (typeof input?.text !== 'string' || !input.text.trim().length) {
      throw new Error('CAR-E-MEM-EMPTY: 记忆正文为空（fail-visible——空正文条目无白盒价值，禁静默落盘）')
    }
    if (input.type !== undefined) assertValidType(input.type)
    const id = input.id ?? `mem-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    assertValidId(id)
    if (this.get(id)) {
      throw new Error(`CAR-E-MEM-EXISTS: 记忆 "${id}" 已存在（write 冲突 fail-visible——修改请走 edit）`)
    }
    const now = this.#now()
    const entry: MemoryEntry = { id, text: input.text, createdAt: now, updatedAt: now }
    if (input.tags?.length) entry.tags = [...input.tags]
    if (input.type) entry.type = input.type
    if (input.description) entry.description = input.description
    if (input.keywords?.length) entry.keywords = [...input.keywords]
    if (input.sourceSession) entry.sourceSession = input.sourceSession
    log.append('user', 'memory', 'memory', {
      type: 'write',
      id,
      text: entry.text,
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...(entry.type ? { memType: entry.type } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.keywords ? { keywords: entry.keywords } : {}),
    } satisfies MemoryEventPayload)
    try {
      this.#writeFile(entry)
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆文件写入失败 "${id}"（事件已落链——盘面动作失败显式抛出，§3.2.M7.5 落链先行动作顺序；${(e as Error).message}）`)
    }
    this.#rewriteIndex()
    return entry
  }

  /**
   * 修改记忆：落 memory/edit 事件（payload before/after 全文——rollback 的恢复数据源）→ 原子重写 → 索引重写。
   * 1.25（D-Z5-9）：meta 第 5 可选参 = { type?, description?, keywords? }，各键语义同 tags——
   * undefined = 不变 / 显式 = 设置（type null = 清空；description '' = 清空；keywords [] = 清空）；
   * payload 显式键恒带（清空形态 = null/''/[]），未触碰键缺席（禁「带键/缺键」二义）。
   */
  edit(log: SessionLog, id: string, text: string, tags?: string[], meta?: { type?: MemoryType | null; description?: string; keywords?: string[] }): MemoryEntry {
    if (!log || typeof log.append !== 'function') {
      throw new Error('CAR-E-MEM-NOCHAIN: 记忆 CRUD 必须传入会话链（D-46 ②；无会话上下文显式拒绝）')
    }
    const prev = this.#mustGet(id)
    if (typeof text !== 'string' || !text.trim().length) {
      throw new Error(`CAR-E-MEM-EMPTY: 记忆 "${id}" 新正文为空（fail-visible——清空请走 delete）`)
    }
    if (meta?.type !== undefined && meta.type !== null) assertValidType(meta.type)
    // tags 语义：undefined = 不变（payload 不带键，重放取前态）；数组 = 整体替换（含空数组 =
    // 清空，payload 恒带键——重放 [] 与清空同构，禁「带键/缺键」二义）
    const next: MemoryEntry = { ...prev, text, updatedAt: this.#now() }
    // 1.25 三字段（D-Z5-9）：同 tags 语义；type 用 null 表清空（string '' 非法类型自然被校验拒绝）
    const typeSet = meta?.type !== undefined
    const descSet = meta?.description !== undefined
    const kwSet = meta?.keywords !== undefined
    if (typeSet) {
      if (meta!.type) next.type = meta!.type
      else delete next.type
    }
    if (descSet) {
      if (meta!.description) next.description = meta!.description
      else delete next.description
    }
    if (kwSet) {
      if (meta!.keywords!.length) next.keywords = [...meta!.keywords!]
      else delete next.keywords
    }
    log.append('user', 'memory', 'memory', {
      type: 'edit',
      id,
      before: prev.text,
      text,
      ...(tags !== undefined ? { tags } : {}),
      ...(typeSet ? { memType: meta!.type } : {}),
      ...(descSet ? { description: meta!.description } : {}),
      ...(kwSet ? { keywords: meta!.keywords } : {}),
    } satisfies MemoryEventPayload)
    try {
      this.#writeFile(next as MemoryEntry)
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆文件写入失败 "${id}"（事件已落链；${(e as Error).message}）`)
    }
    this.#rewriteIndex()
    return next as MemoryEntry
  }

  /** 删除记忆：落 memory/delete 事件（payload 携带被删正文——rollback 可恢复）→ 删文件 → 索引重写 */
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
    this.#rewriteIndex()
  }

  /**
   * 回滚记忆：沿事件链单步时间回退（undo 栈语义——连续回退逐版本回走：v3→v2→v1）。
   * 恢复数据源 = 链上版本栈重放（链即版本库，不依赖文件系统历史）。落 memory/rollback
   * 事件（before/after 全文 + fromSeq 溯源）→ 文件动作 → 索引重写。返回 null = 回退到删除态。
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
    let restored: MemoryEntry | null = null
    try {
      if (target.present) {
        const entry: MemoryEntry = { id, text: target.text!, createdAt: target.createdAt!, updatedAt: this.#now() }
        if (target.tags?.length) entry.tags = [...target.tags]
        if (target.type) entry.type = target.type
        if (target.description) entry.description = target.description
        if (target.keywords?.length) entry.keywords = [...target.keywords]
        if (target.sourceSession) entry.sourceSession = target.sourceSession
        this.#writeFile(entry)
        restored = entry
      } else {
        rmSync(this.#file(id))
      }
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆文件动作失败 "${id}"（事件已落链；${(e as Error).message}）`)
    }
    this.#rewriteIndex() // 索引重写最后一步（半态由读时对拍自愈）；失败以 CAR-E-MEM-IO 索引消息显式抛出
    return restored // null = 回退到删除态：条目移除（调用方以 get 校验）
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
   * 1.25（D-Z5-9）：type/description/keywords 三字段随栈重放消费（edit 显式键带值/清空形态
   * null/''/[]，未触碰键取前态——与 tags「带键/缺键」纪律同构）；重放对未知 type 透传不校验。
   */
  #rebuildStates(log: SessionLog, id: string): Array<{ seq: number; present: boolean; text?: string; tags?: string[]; type?: MemoryType; description?: string; keywords?: string[]; createdAt?: number; sourceSession?: string }> {
    assertValidId(id)
    const stack: Array<{ seq: number; present: boolean; text?: string; tags?: string[]; type?: MemoryType; description?: string; keywords?: string[]; createdAt?: number; sourceSession?: string }> = []
    for (const e of log.events) {
      if (e.kind !== 'memory') continue
      const p = (e.payload ?? {}) as MemoryEventPayload
      if (p.id !== id) continue
      const prevTop = stack[stack.length - 1]
      if (p.type === 'write') stack.push({ seq: e.seq, present: true, text: p.text, tags: p.tags, ...(p.memType ? { type: p.memType } : {}), ...(p.description ? { description: p.description } : {}), ...(p.keywords?.length ? { keywords: p.keywords } : {}), createdAt: e.ts, sourceSession: prevTop?.sourceSession })
      else if (p.type === 'edit') {
        // 显式键（含清空形态）覆盖前态；未触碰键继承前态（tags 同构）
        const nextType = p.memType !== undefined ? (p.memType ?? undefined) : prevTop?.type
        const nextDesc = p.description !== undefined ? (p.description || undefined) : prevTop?.description
        const nextKw = p.keywords !== undefined ? (p.keywords.length ? [...p.keywords] : undefined) : prevTop?.keywords
        stack.push({ seq: e.seq, present: true, text: p.text, tags: p.tags !== undefined ? p.tags : prevTop?.tags, ...(nextType ? { type: nextType } : {}), ...(nextDesc ? { description: nextDesc } : {}), ...(nextKw?.length ? { keywords: nextKw } : {}), createdAt: prevTop?.createdAt ?? e.ts, sourceSession: prevTop?.sourceSession })
      } else if (p.type === 'delete') stack.push({ seq: e.seq, present: false })
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
 * 注入装载（legacy 全量形态，1.25 起保留不改——seam 只增不删，桌面切换召回形态后不再调用）：
 * 全量装入（updatedAt 降序，禁静默选择性注入——选择性 = 不可解释），字符近似预算门控
 * （行为门控非计量出数；超预算 fail-visible 不静默截断——提示宿主调大预算或删减记忆）。
 * 空记忆 = 空串 + count 0（正常态非错误，宿主跳过注入行）。
 * 红线注记（2026-11-21 D-46 修订）：「有据可查的选择性注入」生效后，本全量形态仍是合法形态
 * （全量 = 无选择性，天然有据）；选择性取证由 1.25 buildMemoryIndex/recallMemories 承载。
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

export interface MemoryIndexResult {
  count: number
  totalChars: number
  /** 注入面拼装文本（不含 u token——文件面/注入面两形态，单一事实源同源派生） */
  rendered: string
  /** 索引维护动作（1.25 D-Z5-1 读时对拍）：'absent' = 首建；'drift' = 对拍漂移重建；缺席 = 对拍命中零动作 */
  driftRepaired?: 'absent' | 'drift'
}

/**
 * 索引常驻装载（1.25 D-Z5-1/D-Z5-5）：读 index.md 对拍（§3.2 三态：缺文件首建 / 命中零动作 /
 * 漂移重建——全文件逐字节对拍，任何手改皆漂移），返回注入面文本（一行一记忆：id + type +
 * description/首行截断 fallback）。索引超预算 = fail-visible（一行一记忆是最小不可再分面——
 * 连索引都装不下 = 真撞墙，提示删减/归档记忆）。空记忆 = 空串 + count 0（宿主跳过注入行）。
 */
export function buildMemoryIndex(store: MemoryStore, opts?: { budgetChars?: number }): MemoryIndexResult {
  const entries = store.list()
  const file = join(store.dir, 'index.md')
  const expected = indexFileContentOf(entries)
  let driftRepaired: MemoryIndexResult['driftRepaired']
  if (!existsSync(file)) {
    driftRepaired = 'absent'
  } else {
    let actual: string
    try {
      actual = readFileSync(file, 'utf8')
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆索引读取失败 index.md（${(e as Error).message}）`)
    }
    if (actual !== expected) driftRepaired = 'drift'
  }
  if (driftRepaired !== undefined) {
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, expected, 'utf8')
      renameSync(tmp, file)
    } catch (e) {
      throw new Error(`CAR-E-MEM-IO: 记忆索引重建失败 index.md（${(e as Error).message}）`)
    }
  }
  if (!entries.length) return { count: 0, totalChars: 0, rendered: '', ...(driftRepaired ? { driftRepaired } : {}) }
  const rendered = `[CAR 记忆索引] 共 ${entries.length} 条（正文按召回注入、依据落链）：\n${entries.map((e) => indexLineOf(e, false)).join('\n')}`
  const budget = opts?.budgetChars
  if (budget !== undefined) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
      throw new Error(`CAR-E-MEM-BUDGET: 索引预算非法（${String(budget)}）——须为正数（字符近似门控口径）`)
    }
    if (rendered.length > budget) {
      throw new Error(`CAR-E-MEM-BUDGET: 记忆索引超预算（${rendered.length} > ${budget} 字符）——一行一记忆是最小不可再分面，fail-visible 禁静默截断（删减/归档记忆）`)
    }
  }
  return { count: entries.length, totalChars: rendered.length, rendered, ...(driftRepaired ? { driftRepaired } : {}) }
}

export interface MemoryRecallResult {
  /** 命中清单（matchedKeys = 命中键字面——「有据可查」的落链数据源，宿主随 meta.hits 落链） */
  hits: Array<{ id: string; matchedKeys: string[] }>
  count: number
  totalChars: number
  /** 召回注入文本（命中条目正文全文 + 命中键括注） */
  rendered: string
}

/**
 * 召回式注入装载（1.25 D-Z5-2/D-Z5-3/D-Z5-5）：确定性子串匹配——匹配键面 = tags ∪ keywords
 * （≥2 字符键参与，禁分词禁 LLM 判断禁估算），任一键为 query 子串即命中；matchedKeys =
 * 命中键字面（理由可审计）；hits 排序 = updatedAt 降序。零命中 = 空返回（宿主跳过注入行——
 * 零注入零落链，缺席无需取证）。预算门 = 「召回后仍超才拒」（D-46 修订语义）：筛选已发生
 * rendered 仍超 budgetChars = CAR-E-MEM-BUDGET fail-visible 禁静默截断。
 */
export function recallMemories(store: MemoryStore, query: string, opts: { budgetChars: number }): MemoryRecallResult {
  const budget = opts?.budgetChars
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    throw new Error(`CAR-E-MEM-BUDGET: 召回预算非法（${String(budget)}）——须为正数（字符近似门控口径）`)
  }
  if (typeof query !== 'string') {
    throw new Error(`CAR-E-MEM-QUERY: 召回 query 须为字符串（got ${typeof query}——宿主以用户 turn 文本传入）`)
  }
  const hits: Array<{ id: string; matchedKeys: string[] }> = []
  if (query.length) {
    for (const entry of store.list()) {
      const keys = [...new Set([...(entry.tags ?? []), ...(entry.keywords ?? [])])].filter((k) => typeof k === 'string' && k.length >= 2)
      const matched = keys.filter((k) => query.includes(k))
      if (matched.length) hits.push({ id: entry.id, matchedKeys: matched })
    }
  }
  if (!hits.length) return { hits: [], count: 0, totalChars: 0, rendered: '' }
  const byId = new Map(store.list().map((e) => [e.id, e]))
  const lines = hits.map((h) => {
    const e = byId.get(h.id)!
    const typeSeg = e.type ? ` [${e.type}]` : ''
    return `- [${e.id}]${typeSeg}（命中: ${h.matchedKeys.join('|')}）${e.text.replace(/\r?\n/g, ' ')}`
  })
  const rendered = `[CAR 记忆召回] 命中 ${hits.length} 条（依据：命中键括注于各条 + 落链 meta.hits）：\n${lines.join('\n')}`
  if (rendered.length > budget) {
    throw new Error(`CAR-E-MEM-BUDGET: 召回注入超预算（${rendered.length} > ${budget} 字符）——召回后仍超 fail-visible 禁静默截断（D-46 修订语义；缩召回键面或删减记忆）`)
  }
  return { hits, count: hits.length, totalChars: rendered.length, rendered }
}
