import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { SessionLog, loadSessionLog } from '../src/session/log.ts'
import { zstdAvailable } from '../src/session/format.ts'
import { rebuildIndex, sqliteAvailable } from '../src/session/indexStore.ts'
import { verifyBundle, type ForensicsBundle } from '../src/session/export.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')
const ZSTD_OFF = zstdAvailable() ? false : 'zstd 能力不在场（Node <22.15 无此能力）——CI 22.19 原生在场真跑'

// ==================== fixture 工具（红线 8：清理 try/catch 容错） ====================

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s23-${name}-`))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8：safe-delete 拦截容错 */ } })
}

/** 真实子进程跑 CLI（语义化退出码断言：0=成功 1=数据校验失败 2=用法/输入不可用） */
function car(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('exit', code => resolve({ code, stdout: out, stderr: err }))
  })
}

function writeSessionLog(dir: string, fileName: string, sessionId: string, n: number, corrupt = false): string {
  const log = new SessionLog(sessionId)
  for (let i = 0; i < n; i++) {
    log.append('user', 'user', 'T0', `任务 ${i}：请按标准流程处理并汇报`)
    log.append('model', 'assistant', 'T0', `任务 ${i} 已完成：读取输入 → 执行 → 汇报状态码与耗时`)
  }
  const file = join(dir, fileName)
  let text = log.exportJSONL()
  if (corrupt) {
    const lines = text.split('\n').filter(Boolean)
    const ev = JSON.parse(lines[2]!)
    ev.payload = '篡改后的内容'
    lines[2] = JSON.stringify(ev)
    text = lines.join('\n') + '\n'
  }
  writeFileSync(file, text, 'utf-8')
  return file
}

// ==================== W4 取证包导出（§3.2.M7.2 导出行 + SQ-06） ====================

test('M7-W4: session export 全流程——断链前置校验、落盘读回重验、离线自证（删源后可 verify）', async () => {
  await withTempDir('export', async (dir) => {
    const file = writeSessionLog(dir, 'session-S-export1.jsonl', 'S-export1', 6)
    const out = join(dir, 'bundle')
    const r = await car(['session', 'export', file, '--out', out])
    assert.equal(r.code, 0, r.stderr)
    // 目录结构：manifest.json + sessions/<id>/events.jsonl
    const mfPath = join(out, 'manifest.json')
    const eventsPath = join(out, 'sessions', 'S-export1', 'events.jsonl')
    assert.ok(existsSync(mfPath))
    assert.ok(existsSync(eventsPath))
    // manifest 自证：链锚点 + 事件文件哈希一致（明文口径）
    const mf = JSON.parse(readFileSync(mfPath, 'utf-8')) as ForensicsBundle['manifest']
    assert.equal(mf.verifyChainAtExport, 'PASS')
    assert.equal(mf.eventCount, 12)
    assert.ok(mf.chainHead && mf.chainTail)
    const eventsContent = readFileSync(eventsPath, 'utf-8')
    assert.equal(createHash('sha256').update(eventsContent).digest('hex'), mf.files[0]!.sha256)
    assert.ok(verifyBundle({ files: [{ name: mf.files[0]!.name, content: eventsContent, sha256: mf.files[0]!.sha256 }], manifest: mf }).ok)
    // 离线回放：删源文件后，仅凭导出目录 verify/replay 不依赖运行时
    rmSync(file)
    const v = await car(['session', 'verify', eventsPath])
    assert.equal(v.code, 0, v.stderr)
    assert.match(v.stdout, /哈希链完整：12 事件/)
    const { log: replayed } = loadSessionLog(eventsPath)
    assert.equal(replayed.deriveMessages().length, 12)
  })
})

test('M7-W4: 断链中止——exit 1 + 位置报告 + 不产出导出目录（SQ-06 不出带病审计包）', async () => {
  await withTempDir('broken-export', async (dir) => {
    const file = writeSessionLog(dir, 'session-S-bad.jsonl', 'S-bad', 4, true) // 篡改第 3 行 payload
    const out = join(dir, 'bundle')
    const r = await car(['session', 'export', file, '--out', out])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /断链 @ seq=/)
    assert.equal(existsSync(out), false)
  })
})

test('M7-W4: export --zstd——物理布局 .jsonl.zstd + storage 登记 + 读回重验三方一致', { skip: ZSTD_OFF }, async () => {
  await withTempDir('export-zstd', async (dir) => {
    const file = writeSessionLog(dir, 'session-S-z1.jsonl', 'S-z1', 6)
    const out = join(dir, 'bundle')
    const r = await car(['session', 'export', file, '--out', out, '--zstd'])
    assert.equal(r.code, 0, r.stderr)
    const eventsPath = join(out, 'sessions', 'S-z1', 'events.jsonl.zstd')
    assert.ok(existsSync(eventsPath), '物理文件应为 .jsonl.zstd')
    const mf = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf-8')) as ForensicsBundle['manifest']
    assert.equal(mf.storage?.encoding, 'zstd')
    assert.equal(mf.storage.storedAs, 'sessions/S-z1/events.jsonl.zstd')
    // 三方一致：物理压缩字节哈希 = storage 登记；解码明文哈希 = files 逻辑口径
    const diskBytes = readFileSync(eventsPath)
    assert.equal(createHash('sha256').update(diskBytes).digest('hex'), mf.storage.physicalSha256)
    const { log: reloaded, brokenAt, encoding } = loadSessionLog(eventsPath)
    assert.equal(encoding, 'zstd')
    assert.equal(brokenAt, null)
    assert.equal(reloaded.events.length, 12)
  })
})

test('M7-W4: 用法守卫——缺 --out / 输入不可用（CAR-E-FORMAT）= exit 2', async () => {
  await withTempDir('usage', async (dir) => {
    const r1 = await car(['session', 'export', join(dir, 'whatever.jsonl')])
    assert.equal(r1.code, 2)
    assert.match(r1.stderr, /--out/)
    const bad = join(dir, 'bad.jsonl')
    writeFileSync(bad, 'not-json\n', 'utf-8')
    const r2 = await car(['session', 'verify', bad])
    assert.equal(r2.code, 2)
    assert.match(r2.stderr, /CAR-E-FORMAT/)
  })
})

// ==================== W5 C-02 SQLite 索引（§3.2.M7.5 Step 3） ====================

test('M7-W5: rebuild-index 幂等重建——断链/坏格式文件入 errors 不中断，索引只收链完整会话', async () => {
  await withTempDir('index', async (dir) => {
    const root = join(dir, 'sessions-root')
    mkdirSync(join(root, 'sessions', 'S-nest'), { recursive: true })
    writeSessionLog(root, 'session-S-a1.jsonl', 'S-a1', 3)
    writeSessionLog(root, 'session-S-a2.jsonl', 'S-a2', 2)
    writeSessionLog(join(root, 'sessions', 'S-nest'), 'events.jsonl', 'S-nest', 1)
    writeSessionLog(root, 'session-S-broken.jsonl', 'S-broken', 2, true)
    const bad = join(root, 'session-S-format.jsonl')
    writeFileSync(bad, 'not-json\n', 'utf-8')
    const db = join(dir, 'idx.db')
    const r1 = await rebuildIndex(root, db)
    assert.equal(r1.rows.length, 3)
    assert.equal(r1.errors.length, 2)
    assert.ok(r1.errors.some(e => /哈希链断裂/.test(e.reason)))
    assert.ok(r1.errors.some(e => /CAR-E-FORMAT/.test(e.reason)))
    // 排序确定 + 嵌套 events.jsonl 的 sessionId 取父目录
    assert.deepEqual(r1.rows.map(r => r.sessionId), ['S-a1', 'S-a2', 'S-nest'])
    assert.equal(r1.rows.find(r => r.sessionId === 'S-nest')!.file, join(root, 'sessions', 'S-nest', 'events.jsonl'))
    // 幂等：重跑结果一致（单事务 DELETE+INSERT 覆盖）
    const r2 = await rebuildIndex(root, db)
    assert.deepEqual(r2.rows, r1.rows)
    // 盘上 SQLite 内容抽查：行数与 rows 一致
    const mod = await import('node:sqlite')
    const dbHandle = new (mod as unknown as { DatabaseSync: new (p: string) => { prepare(s: string): { get(): Record<string, unknown> }; close(): void } }).DatabaseSync(db)
    try {
      const cnt = dbHandle.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
      assert.equal(cnt.n, 3)
      const nest = dbHandle.prepare("SELECT eventCount FROM sessions WHERE sessionId = 'S-nest'").get() as { eventCount: number }
      assert.equal(nest.eventCount, 2)
    } finally { dbHandle.close() }
  })
})

test('M7-W5: sqlite 能力探测在场（CI 22.19 经 NODE_OPTIONS，23.4+ 原生）', async () => {
  // 显式登记：能力缺席环境的 rebuildIndex 拒绝路径由 CAR-E-SQLITE 文案覆盖（format.ts 同款三语义口径）
  assert.equal(await sqliteAvailable(), true)
})

test('M7-W5: rebuild-index 对 zstd 归档文件 layout-blind 入索引（能力在场时）', { skip: ZSTD_OFF }, async () => {
  await withTempDir('index-zstd', async (dir) => {
    const { compressJsonlZstd } = await import('../src/session/format.ts')
    const root = join(dir, 'root')
    mkdirSync(root, { recursive: true })
    const log = new SessionLog('S-arch')
    for (let i = 0; i < 3; i++) log.append('user', 'user', 'T0', `q${i}`)
    writeFileSync(join(root, 'S-arch.jsonl.zstd'), compressJsonlZstd(log.exportJSONL()))
    const r = await rebuildIndex(root, join(dir, 'idx.db'))
    assert.equal(r.rows.length, 1)
    assert.equal(r.rows[0]!.encoding, 'zstd')
    assert.equal(r.rows[0]!.sessionId, 'S-arch')
    assert.equal(r.rows[0]!.eventCount, 3)
    assert.equal(r.errors.length, 0)
  })
})
