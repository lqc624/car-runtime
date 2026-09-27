/**
 * 1.2 · 会话索引后续项（S28）：--session id 经索引定位（W3-1）+ 运行时异步索引更新（W3-2）
 *
 * 覆盖（1.2-迭代规划 W3-1/W3-2；M7 §4/§5 登记后续出清）：
 *  - lookupSession：命中全字段还原 / 未收录 null / 索引不存在 / 索引文件无效显式报错
 *  - CLI 三入口 --session 全链：verify / replay / export 经索引定位；互斥、缺 db、未收录显式报错
 *  - IndexUpdater：append → flush → 索引可见（自举建库建表）；快照覆盖；close flush；失败非致命
 *  - 生产调用点：car run 真进程 append → sessions-index.db 自动可见（「更新半边」闭环）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionLog } from '../src/session/log.ts'
import { SessionFileStore } from '../src/session/store.ts'
import { rebuildIndex, lookupSession, IndexUpdater } from '../src/session/indexStore.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s28-${name}-`))
  try {
    const r = fn(dir)
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } }
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
    return Promise.resolve()
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
    throw e
  }
}

/** 写一个链完整会话文件（car run 同构：log + attachSink(fs store)），返回 sessionId */
function makeSession(dir: string, file: string, sessionId: string, turns = 2): string {
  const log = new SessionLog(sessionId)
  const store = new SessionFileStore(join(dir, file))
  log.attachSink(line => store.append(line))
  for (let i = 0; i < turns; i++) {
    log.append('user', 'user', `T${i}`, `question ${i}`)
    log.append('model', 'assistant', `T${i}`, `answer ${i}`)
  }
  store.close()
  return sessionId
}

function car(args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, ...args], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('exit', code => resolve({ code: code ?? -1, stdout: out, stderr: err }))
  })
}

// ==================== lookupSession（W3-1） ====================

test('S28: lookupSession——命中全字段还原 / 未收录 null / 索引不存在 / 索引文件无效显式报错', async () => {
  await withTempDir('lookup', async dir => {
    makeSession(dir, 'session-S-lookup-a.jsonl', 'S-lookup-a')
    makeSession(dir, 'session-S-lookup-b.jsonl', 'S-lookup-b')
    const dbPath = join(dir, 'sessions-index.db')
    const r = await rebuildIndex(dir, dbPath)
    assert.equal(r.errors.length, 0)

    const hit = await lookupSession(dbPath, 'S-lookup-a')
    assert.ok(hit)
    assert.equal(hit.sessionId, 'S-lookup-a')
    assert.equal(hit.file, join(dir, 'session-S-lookup-a.jsonl'))
    assert.equal(hit.eventCount, 4)
    assert.equal(hit.tornTail, false)
    assert.equal(hit.encoding, 'plain')

    assert.equal(await lookupSession(dbPath, 'S-missing'), null, '未收录 = null（可索引 = 可验证）')

    await assert.rejects(
      () => lookupSession(join(dir, 'nope.db'), 'S-lookup-a'),
      /CAR-E-INDEX: 会话索引不存在/,
      'db 缺文件显式报错（lookup 不产生建文件副作用）',
    )

    const bad = join(dir, 'bad.db')
    writeFileSync(bad, 'this is not a sqlite database')
    await assert.rejects(() => lookupSession(bad, 'S-lookup-a'), /CAR-E-INDEX: 索引文件无效/)
  })
})

test('S28: CLI --session 三入口——verify/replay/export 经索引定位全链（真进程）', async () => {
  await withTempDir('cli-session-flag', async dir => {
    const sid = makeSession(dir, 'session-S-cli-s1.jsonl', 'S-cli-s1')
    await rebuildIndex(dir, join(dir, 'sessions-index.db'))

    const v = await car(['session', 'verify', '--session', sid, '--db', 'sessions-index.db'], { cwd: dir })
    assert.equal(v.code, 0, v.stderr)
    assert.match(v.stdout, /哈希链完整：4 事件/)

    const rp = await car(['session', 'replay', '--session', sid, '--db', 'sessions-index.db'], { cwd: dir })
    assert.equal(rp.code, 0, rp.stderr)
    assert.match(rp.stdout, /"role":"user"/)
    assert.match(rp.stdout, /answer 1/)

    const ex = await car(['session', 'export', '--session', sid, '--out', 'out-bundle', '--db', 'sessions-index.db'], { cwd: dir })
    assert.equal(ex.code, 0, ex.stderr)
    assert.match(ex.stdout, /取证包导出：4 事件/)
    assert.ok(existsSync(join(dir, 'out-bundle', 'manifest.json')))
  })
})

test('S28: CLI --session 显式拒绝面——与位置路径互斥 / 缺 db / 未收录 / 坏格式会话不入索引（真进程）', async () => {
  await withTempDir('cli-session-flag-reject', async dir => {
    const sid = makeSession(dir, 'session-S-cli-r1.jsonl', 'S-cli-r1')
    // 与位置路径互斥
    const both = await car(['session', 'verify', 's1.jsonl', '--session', sid, '--db', 'sessions-index.db'], { cwd: dir })
    assert.equal(both.code, 2)
    assert.match(both.stderr, /互斥/)
    // 未建索引 + cwd 无 sessions-index.db → 显式报错提示 rebuild
    const nodb = await car(['session', 'verify', '--session', sid], { cwd: dir })
    assert.equal(nodb.code, 2)
    assert.match(nodb.stderr, /CAR-E-INDEX: 会话索引不存在/)
    // 建索引后查不存在的 id → 未收录显式报错
    await rebuildIndex(dir, join(dir, 'sessions-index.db'))
    const miss = await car(['session', 'verify', '--session', 'S-absent', '--db', 'sessions-index.db'], { cwd: dir })
    assert.equal(miss.code, 2)
    assert.match(miss.stderr, /未收录索引/)
    // 坏格式会话（完整非法行）不入索引（「可索引 = 可验证」）→ --session 定位失败
    const bf = join(dir, 'session-S-broken.jsonl')
    makeSession(dir, 'session-S-broken.jsonl', 'S-broken')
    writeFileSync(bf, readFileSync(bf, 'utf-8') + 'not-a-json-line\n')
    const rb = await rebuildIndex(dir, join(dir, 'broken.db'))
    assert.equal(rb.rows.some(r => r.sessionId === 'S-broken'), false, '坏格式文件不入索引（errors 通道）')
    assert.equal(rb.errors.length, 1)
    const broken = await car(['session', 'verify', '--session', 'S-broken', '--db', 'broken.db'], { cwd: dir })
    assert.equal(broken.code, 2)
    assert.match(broken.stderr, /未收录索引/)
  })
})

// ==================== IndexUpdater（W3-2） ====================

test('S28: IndexUpdater——append 后 flush 索引可见（自举建库建表）/ 快照覆盖 / close flush（真 sqlite）', async () => {
  await withTempDir('updater', async dir => {
    const dbPath = join(dir, 'sessions-index.db')
    const log = new SessionLog('S-updater-1')
    const store = new SessionFileStore(join(dir, 'session-S-updater-1.jsonl'))
    const file = join(dir, 'session-S-updater-1.jsonl')
    const updater = new IndexUpdater({ dbPath, debounceMs: 30 })
    // 单 sink 语义（SessionLog.attachSink 覆盖式）——更新器经链式包装接入，不改日志层；
    // sink 先于事件入内存（fail-fast），故 record 按行增量（seq/hash 自行数据）
    log.attachSink(line => { store.append(line); updater.record('S-updater-1', line, file) })

    log.append('user', 'user', 'T0', 'q0')
    await updater.flush()
    assert.equal(updater.stats.updates, 1)
    let row = await lookupSession(dbPath, 'S-updater-1')
    assert.ok(row, 'flush 后索引可见（无 rebuild 自举）')
    assert.equal(row!.eventCount, 1)

    // debounce 窗口内多次 record 合并为一次 upsert，行快照 = 最新 append 时点全量
    log.append('model', 'assistant', 'T0', 'a0')
    log.append('user', 'user', 'T1', 'q1')
    await updater.flush()
    row = await lookupSession(dbPath, 'S-updater-1')
    assert.equal(row!.eventCount, 3)

    // close flush（car run 关句柄前收口）
    log.append('user', 'user', 'T2', 'q2')
    await updater.close()
    assert.equal(updater.stats.updates, 3)
    row = await lookupSession(dbPath, 'S-updater-1')
    assert.equal(row!.eventCount, 4)
    assert.equal(row!.tornTail, false, '活会话按构造完整（tornTail=false 口径）')
    assert.equal(row!.encoding, 'plain')
    store.close()
  })
})

test('S28: IndexUpdater 失败非致命——db 路径不可用持续留痕不抛出（append 路径零影响）', async () => {
  await withTempDir('updater-fail', async dir => {
    // dbPath 指向目录 → open 必败
    const badPath = join(dir, 'a-directory')
    mkdirSync(badPath)
    const errors: string[] = []
    const updater = new IndexUpdater({ dbPath: badPath, onError: e => errors.push(e.message) })
    const log = new SessionLog('S-fail-1')
    const store = new SessionFileStore(join(dir, 'x.jsonl'))
    log.attachSink(line => { store.append(line); updater.record('S-fail-1', line, join(dir, 'x.jsonl')) })

    // 事件照常落盘（updater 错误绝不传播到 append 路径——R-2 钉死）
    log.append('user', 'user', 'T0', 'q')
    await updater.flush()
    assert.equal(updater.stats.failures, 1)
    assert.ok(errors[0], '错误经 onError 留痕（不向调用方抛出）')
    assert.match(errors[0]!, /CAR-E-INDEX|CAR-E-SQLITE/)

    // 继续使用不抛出
    log.append('user', 'user', 'T1', 'q')
    await updater.close()
    assert.equal(updater.stats.failures, 2)
    // 落盘本体未受影响：文件行数 = 事件数
    assert.equal(readFileSync(join(dir, 'x.jsonl'), 'utf-8').trim().split('\n').length, 2)
    store.close()
  })
})

test('S28: 生产调用点——car run 真进程 append → cwd sessions-index.db 自动可见（「更新半边」闭环）', async () => {
  await withTempDir('car-run-index', async dir => {
    // 工具名避开 demo_tool：CLI 演示脚手架硬编码注册 demo_tool，同名插件工具触发预存在的 provide
    // 撞名边缘（登记不修——W1 重做 car run 装配面时出清）
    writeFileSync(join(dir, 'p.ts'), `export const manifest = { name: 'p', version: '1.0.0' }\nexport default function apply(api) {\n  api.registerTool({ name: 't', run: async () => 'ok' })\n}\n`)
    const r = await car(['run', 'p.ts'], { cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    const dbPath = join(dir, 'sessions-index.db')
    assert.ok(existsSync(dbPath), 'car run 运行后 cwd 索引自举在位')
    // 经 sqlite 直查（run 会话 id 为 S-<time36> 运行期生成，全表核对）
    const mod = await import('node:sqlite')
    const DatabaseSync = (mod as unknown as { DatabaseSync: new (path: string) => { prepare(s: string): { all(...v: unknown[]): Record<string, unknown>[] }; close(): void } }).DatabaseSync
    const db = new DatabaseSync(dbPath)
    try {
      const all = db.prepare('SELECT sessionId, eventCount, file FROM sessions').all()
      assert.ok(all.length >= 1, 'run 会话入索引')
      const hit = all.find(x => String(x.sessionId).startsWith('S-'))
      assert.ok(hit, 'run 会话 id 在索引')
      // realpath 比较（1.2-BUG-4）：macOS 子进程 cwd 为物理路径 /private/var…，父进程持逻辑路径 /var…
      assert.equal(realpathSync(String(hit!.file)), realpathSync(join(dir, `session-${hit!.sessionId}.jsonl`)))
      assert.ok(Number(hit!.eventCount) >= 3, '事件计数 = run 全程 append 量（装配+对话+收口）')
    } finally {
      db.close()
    }
  })
})
