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
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
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
interface SqliteStmt { run(...v: SqliteValue[]): unknown }
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStmt; close(): void }

/** node:sqlite 能力探测（模块存在性；静态 import 在无能力 Node 上会崩模块加载，故动态） */
export async function sqliteAvailable(): Promise<boolean> {
  try { await import('node:sqlite'); return true } catch { return false }
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
