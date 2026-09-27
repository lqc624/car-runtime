/**
 * C-02 会话索引（§3.2.M7.2 索引行 + §3.2.M7.5 Step 3「异步可容忍，丢失可 rebuild」）
 *
 * 口径：
 *  - node:sqlite 能力探测（22.5+ 需 --experimental-sqlite / 23.4+ 原生）；不可用 = CAR-E-SQLITE 显式拒绝，非静默；
 *  - rebuild 语义：全量从 JSONL 重建，单事务幂等覆盖（DELETE + INSERT），任何时刻盘上索引自洽；
 *  - 损坏面不吞错：断链 / CAR-E-FORMAT / zstd 能力缺失的文件不入索引，逐条进 errors 报告——
 *    索引只收录链完整会话（审计面口径：可索引 = 可验证）；
 *  - 物理编码 layout-blind：plain / zstd 统一经 format.ts 装载，索引记录 encoding 供检索。
 */
import { readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadSessionLog, type SessionEvent } from './log.ts'

export interface SessionIndexRow {
  sessionId: string
  file: string
  eventCount: number
  chainHead: string | null
  chainTail: string | null
  firstTs: number | null
  lastTs: number | null
  tornTail: boolean
  encoding: 'plain' | 'zstd'
}

export interface RebuildResult {
  dbPath: string
  rows: SessionIndexRow[]
  errors: { file: string; reason: string }[]
}

type SqliteValue = string | number | null
interface SqliteStmt { run(...v: SqliteValue[]): unknown; get(...v: SqliteValue[]): unknown }
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStmt; close(): void }

const CAR_E_SQLITE = 'CAR-E-SQLITE: 当前 Node 无 node:sqlite 能力（22.5+ 需 --experimental-sqlite，23.4+ 原生）——显式拒绝，不静默降级'

/** node:sqlite 能力探测（模块存在性；静态 import 在无能力 Node 上会崩模块加载，故动态） */
export async function sqliteAvailable(): Promise<boolean> {
  try { await import('node:sqlite'); return true } catch { return false }
}

/** 打开索引库（db 文件必须已存在——lookup 不产生建文件副作用；open 失败 = 索引文件无效显式报错） */
async function openExistingDb(dbPath: string): Promise<SqliteDb> {
  if (!existsSync(dbPath)) {
    throw new Error(`CAR-E-INDEX: 会话索引不存在：${dbPath}——先执行 car session rebuild-index 建立索引`)
  }
  const mod = await import('node:sqlite').catch(() => null)
  if (!mod) throw new Error(CAR_E_SQLITE)
  const DatabaseSync = (mod as unknown as { DatabaseSync: new (path: string) => SqliteDb }).DatabaseSync
  try {
    return new DatabaseSync(dbPath)
  } catch (e) {
    throw new Error(`CAR-E-INDEX: 索引文件无效（打开失败：${(e as Error).message}）：${dbPath}`)
  }
}

/** 单会话检索（1.2-S1 W3-1）：--session <id> 经索引解析 sessionId → 文件；未收录 = null（「可索引 = 可验证」口径——断链会话不入索引） */
export async function lookupSession(dbPath: string, sessionId: string): Promise<SessionIndexRow | null> {
  const db = await openExistingDb(dbPath)
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()
    if (!table) throw new Error(`CAR-E-INDEX: 索引文件无效（无 sessions 表）：${dbPath}`)
    const row = db.prepare('SELECT * FROM sessions WHERE sessionId = ?').get(sessionId) as Record<string, SqliteValue> | undefined
    if (!row) return null
    return {
      sessionId: String(row.sessionId),
      file: String(row.file),
      eventCount: Number(row.eventCount),
      chainHead: row.chainHead == null ? null : String(row.chainHead),
      chainTail: row.chainTail == null ? null : String(row.chainTail),
      firstTs: row.firstTs == null ? null : Number(row.firstTs),
      lastTs: row.lastTs == null ? null : Number(row.lastTs),
      tornTail: Number(row.tornTail) === 1,
      encoding: row.encoding === 'zstd' ? 'zstd' : 'plain',
    }
  } catch (e) {
    const msg = (e as Error).message
    if (msg.startsWith('CAR-E-')) throw e // 本层显式错误原样透传
    // SQLite 惰性校验：非索引文件 open 不报错、query 才报（file is not a database）——统一收口为显式口径
    throw new Error(`CAR-E-INDEX: 索引文件无效（${msg}）：${dbPath}`)
  } finally {
    db.close()
  }
}

const CREATE_SESSIONS_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  eventCount INTEGER NOT NULL,
  chainHead TEXT,
  chainTail TEXT,
  firstTs INTEGER,
  lastTs INTEGER,
  tornTail INTEGER NOT NULL DEFAULT 0,
  encoding TEXT NOT NULL DEFAULT 'plain',
  rebuiltAt TEXT NOT NULL
)`

/** 单行增量 upsert（1.2-S2 W3-2「更新半边」）：库/表不存在则自举创建（活会话无需先 rebuild 即可入索引） */
export async function upsertSessionRow(dbPath: string, row: SessionIndexRow): Promise<void> {
  const mod = await import('node:sqlite').catch(() => null)
  if (!mod) throw new Error(CAR_E_SQLITE)
  const DatabaseSync = (mod as unknown as { DatabaseSync: new (path: string) => SqliteDb }).DatabaseSync
  try {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(CREATE_SESSIONS_SQL)
      db.prepare(
        'INSERT OR REPLACE INTO sessions (sessionId, file, eventCount, chainHead, chainTail, firstTs, lastTs, tornTail, encoding, rebuiltAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(row.sessionId, row.file, row.eventCount, row.chainHead, row.chainTail, row.firstTs, row.lastTs, row.tornTail ? 1 : 0, row.encoding, new Date().toISOString())
    } finally {
      db.close()
    }
  } catch (e) {
    const msg = (e as Error).message
    if (msg.startsWith('CAR-E-')) throw e
    throw new Error(`CAR-E-INDEX: 索引更新失败（${msg}）：${dbPath}`)
  }
}

/**
 * 运行时索引更新器（1.2-S2 W3-2）：file-backed 会话 append 后的异步增量通道。
 *
 * 口径（M7 §4.2 登记 + 1.2 规划 R-2）：
 *  - 按行增量：SessionLog.append 的 sink 先于事件入内存调用（fail-fast 语义），故 record
 *    直接收行 JSON——seq/ts/hash 取自行数据（seq 权威：eventCount = seq+1），不读内存快照；
 *  - debounce 合并：窗口内多次 append 只落一次 upsert（行状态由最新 append 覆盖）；
 *  - 失败非致命：upsert 任何错误经 onError 留痕并计数，绝不向 append 路径传播——
 *    索引是派生缓存，丢失由 rebuild-index 兜底（语义自洽，M7 已登记）；
 *  - SQLite 能力缺席：首次 flush 显式登记一次后停用（非静默，后续 record 不再调度）；
 *  - 活会话行口径：tornTail=false（按构造完整）、encoding='plain'（zstd 定位归档/导出，M7 W3）。
 */
interface PendingState {
  sessionId: string
  file: string
  eventCount: number
  chainHead: string
  chainTail: string
  firstTs: number
  lastTs: number
}

export class IndexUpdater {
  readonly #dbPath: string
  readonly #debounceMs: number
  readonly #onError: (e: Error) => void
  #state: PendingState | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #capabilityMissing = false
  #updates = 0
  #failures = 0

  constructor(opts: { dbPath: string; debounceMs?: number; onError?: (e: Error) => void }) {
    this.#dbPath = opts.dbPath
    this.#debounceMs = opts.debounceMs ?? 2_000
    this.#onError = opts.onError ?? (e => { try { console.error(`[index-updater] ${e.message}`) } catch { /* 收口期 stderr 不可用 */ } })
  }

  get stats(): { updates: number; failures: number } {
    return { updates: this.#updates, failures: this.#failures }
  }

  /** append sink 链上调用（行 JSON）：seq 权威增量；非预期行防御性忽略 */
  record(sessionId: string, line: string, file: string): void {
    if (this.#capabilityMissing) return
    let e: { seq?: unknown; ts?: unknown; hash?: unknown }
    try { e = JSON.parse(line) as { seq?: unknown; ts?: unknown; hash?: unknown } } catch { return }
    const seq = Number(e.seq)
    const ts = Number(e.ts)
    const hash = typeof e.hash === 'string' ? e.hash : ''
    if (!Number.isFinite(seq) || !Number.isFinite(ts) || !hash) return
    const s = this.#state
    if (!s || s.sessionId !== sessionId || s.file !== file) {
      this.#state = { sessionId, file: resolve(file), eventCount: seq + 1, chainHead: hash, chainTail: hash, firstTs: ts, lastTs: ts }
    } else {
      s.eventCount = Math.max(s.eventCount, seq + 1)
      s.chainTail = hash
      s.lastTs = ts
    }
    this.#timer ??= setTimeout(() => { void this.flush() }, this.#debounceMs)
  }

  /** 立即落 pending（close/exit 时点调用；幂等——无 pending 即空转） */
  async flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (!this.#state) return
    const s = this.#state
    const row: SessionIndexRow = { ...s, tornTail: false, encoding: 'plain' }
    try {
      await upsertSessionRow(this.#dbPath, row)
      this.#updates++
    } catch (e) {
      this.#failures++
      const msg = (e as Error).message
      if (msg.startsWith('CAR-E-SQLITE')) {
        // 能力缺席：登记一次后停用（后续 record 不再调度——禁每窗口重复刷屏）
        this.#capabilityMissing = true
      }
      this.#onError(e as Error)
    }
  }

  /** 收口：取消未决 timer + 落 pending（car run 关句柄前调用） */
  async close(): Promise<void> {
    await this.flush()
  }
}

function scanLogFiles(root: string): string[] {
  const rels = readdirSync(root, { recursive: true }) as string[]
  return rels
    .filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'))
    .sort()
    .map(f => join(root, f))
}

/** 装载 + 校验 + 抽取索引行（格式/断链/zstd 能力问题以 throw 上抛 → errors 通道） */
function buildRow(file: string): SessionIndexRow {
  const { log, brokenAt, encoding, tornTail } = loadSessionLog(file)
  if (brokenAt !== null) throw new Error(`哈希链断裂 @ seq=${brokenAt}`)
  const events = log.events as SessionEvent[]
  const first = events[0]
  const last = events[events.length - 1]
  return {
    sessionId: log.sessionId,
    file,
    eventCount: events.length,
    chainHead: first?.hash ?? null,
    chainTail: last?.hash ?? null,
    firstTs: first?.ts ?? null,
    lastTs: last?.ts ?? null,
    tornTail,
    encoding,
  }
}

export async function rebuildIndex(root: string, dbPath: string): Promise<RebuildResult> {
  const mod = await import('node:sqlite').catch(() => null)
  if (!mod) throw new Error('CAR-E-SQLITE: 当前 Node 无 node:sqlite 能力（22.5+ 需 --experimental-sqlite，23.4+ 原生）——显式拒绝，不静默降级')
  const DatabaseSync = (mod as unknown as { DatabaseSync: new (path: string) => SqliteDb }).DatabaseSync

  const rows: SessionIndexRow[] = []
  const errors: { file: string; reason: string }[] = []
  for (const file of scanLogFiles(root)) {
    try { rows.push(buildRow(file)) }
    catch (e) { errors.push({ file, reason: (e as Error).message }) }
  }

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sessionId TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      eventCount INTEGER NOT NULL,
      chainHead TEXT,
      chainTail TEXT,
      firstTs INTEGER,
      lastTs INTEGER,
      tornTail INTEGER NOT NULL DEFAULT 0,
      encoding TEXT NOT NULL DEFAULT 'plain',
      rebuiltAt TEXT NOT NULL
    )`)
    const rebuiltAt = new Date().toISOString()
    db.exec('BEGIN')
    db.exec('DELETE FROM sessions')
    const insert = db.prepare(
      'INSERT INTO sessions (sessionId, file, eventCount, chainHead, chainTail, firstTs, lastTs, tornTail, encoding, rebuiltAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const r of rows) {
      insert.run(r.sessionId, r.file, r.eventCount, r.chainHead, r.chainTail, r.firstTs, r.lastTs, r.tornTail ? 1 : 0, r.encoding, rebuiltAt)
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  return { dbPath, rows, errors }
}
