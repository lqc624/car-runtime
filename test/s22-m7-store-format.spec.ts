import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog, loadSessionLog, deriveSessionId } from '../src/session/log.ts'
import { SessionFileStore } from '../src/session/store.ts'
import { compressJsonlZstd, decodeLogBuffer, splitJsonlLines, zstdAvailable } from '../src/session/format.ts'

// ==================== fixture 工具（红线 8：清理 try/catch 容错） ====================

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s22-${name}-`))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8：safe-delete 拦截容错 */ } })
}

function appendConversation(log: SessionLog, n: number): void {
  for (let i = 0; i < n; i++) {
    log.append('user', 'user', 'T0', `请处理第 ${i} 项任务并按标准流程汇报结果`)
    log.append('model', 'assistant', 'T0', `第 ${i} 项任务已完成：读取输入 → 执行标准流程 → 输出结果摘要（含耗时与状态码）`)
  }
}

// ==================== W1 落盘存储层（§3.2.M7.5 Step 1-2） ====================

test('M7-W1: attachSink 逐事件落盘——append 返回即已持久，读回与内存逐字节一致且链完整', () => {
  withTempDir('sink', (dir) => {
    const file = join(dir, 'session-S-m7sink.jsonl')
    const log = new SessionLog('S-m7sink')
    const store = new SessionFileStore(file)
    log.attachSink(line => store.append(line))
    appendConversation(log, 5)
    store.close()
    assert.equal(statSync(file).size > 0, true)
    const { log: reloaded, brokenAt, tornTail } = loadSessionLog(file)
    assert.equal(tornTail, false)
    assert.equal(brokenAt, null)
    assert.equal(reloaded.events.length, log.events.length)
    assert.deepEqual(reloaded.events.map(e => e.hash), log.events.map(e => e.hash))
    // sessionId 经文件名推导还原（审计定位口径）
    assert.equal(reloaded.sessionId, 'S-m7sink')
  })
})

test('M7-W1: sink 写失败 fail-fast——事件不入内存、链尾不推进（内存与盘面永不失配）', () => {
  withTempDir('failfast', (dir) => {
    const file = join(dir, 'log.jsonl')
    const store = new SessionFileStore(file)
    store.append('{"primed":true}')
    store.close()
    const log = new SessionLog('S-ff')
    log.attachSink(line => store.append(line))
    assert.throws(() => log.append('user', 'user', 'T0', 'x'), /CAR-E-STORE/)
    assert.equal(log.events.length, 0)
    assert.equal(log.stats().tailHash, 'GENESIS')
  })
})

// ==================== W2 撕裂尾显式格式校验（§3.2.M7.1 第 4 点） ====================

test('M7-W2: 撕裂尾显式校验——崩溃半行显式丢弃报告，前缀链完整（不算断链）', () => {
  withTempDir('torn', (dir) => {
    const file = join(dir, 'log.jsonl')
    writeFileSync(file, (() => { const l = new SessionLog('S-torn'); appendConversation(l, 4); return l.exportJSONL() })(), 'utf-8')
    appendFileSync(file, '{"seq":8,"ts":123,"actor":"model","kind":"assistant"') // 崩溃半行（无换行）
    const { log, brokenAt, tornTail, tornTailBytes } = loadSessionLog(file)
    assert.equal(brokenAt, null)
    assert.equal(tornTail, true)
    assert.ok(tornTailBytes > 0)
    assert.equal(log.events.length, 8)
  })
})

test('M7-W2: 完整行非法 JSON = CAR-E-FORMAT 拒绝装载（与撕裂尾/断链三语义互斥）', () => {
  withTempDir('badline', (dir) => {
    const file = join(dir, 'log.jsonl')
    const l = new SessionLog('S-bad'); appendConversation(l, 2)
    writeFileSync(file, l.exportJSONL() + 'not-json\n', 'utf-8')
    assert.throws(() => loadSessionLog(file), /CAR-E-FORMAT/)
  })
})

test('M7-W2: splitJsonlLines 边界——空文件/正常收尾/空行过滤/撕裂尾残留不入 lines', () => {
  assert.deepEqual(splitJsonlLines(''), { lines: [], tornTail: false, tornTailBytes: 0 })
  assert.deepEqual(splitJsonlLines('a\nb\n'), { lines: ['a', 'b'], tornTail: false, tornTailBytes: 0 })
  assert.deepEqual(splitJsonlLines('a\n\nb\n'), { lines: ['a', 'b'], tornTail: false, tornTailBytes: 0 }) // 中间空行=噪声过滤
  const r = splitJsonlLines('a\n\nb')
  assert.equal(r.tornTail, true)
  assert.deepEqual(r.lines, ['a']) // 'b' 为撕裂尾残留（显式丢弃，不入 lines）
  assert.equal(r.tornTailBytes, 1)
})

test('M7-W2: deriveSessionId 推导规则——session- 前缀剥离 / events.jsonl 取父目录 / zstd 后缀', () => {
  assert.equal(deriveSessionId('x/session-S-abc.jsonl'), 'S-abc')
  assert.equal(deriveSessionId('x/S-abc.jsonl.zstd'), 'S-abc')
  assert.equal(deriveSessionId('root/sessions/S-xyz/events.jsonl'), 'S-xyz')
  assert.equal(deriveSessionId('events.jsonl'), 'events') // 无父目录兜底
})

// ==================== W3 zstd 存储增强（M2演进 #14③ / M3演进「M7+ 选项」正主） ====================

const ZSTD_OFF = zstdAvailable() ? false : 'zstd 能力不在场（Node <22.15 无此能力）——CI 22.19 原生在场真跑'

test('M7-W3: zstd 归档压缩 + magic 嗅探 layout-blind 直读（能力在场时）', { skip: ZSTD_OFF }, () => {
  withTempDir('zstd', (dir) => {
    const log = new SessionLog('S-m7zstd')
    appendConversation(log, 400) // 800 事件：真实会话量级
    const plain = log.exportJSONL()
    assert.ok(plain.length > 200_000, `fixture 量级不足：${plain.length}`)
    const zbuf = compressJsonlZstd(plain)
    // 规格口径 ≥3x（§3.2.M7.1 第 4 点）：实测 6.21x（800 事件 261213→42035B，libzstd 1.5.5 level 3，WSL 实测 2026-09-19——
    // Node zstdCompressSync 同库同级别同 fixture，断言留 2x 余量防 libzstd 版本漂移）
    const ratio = plain.length / zbuf.length
    assert.ok(ratio >= 3, `压缩比低于规格 3x：${ratio.toFixed(2)}x（${plain.length} → ${zbuf.length}）`)
    const file = join(dir, 'session-S-m7zstd.jsonl.zstd')
    writeFileSync(file, zbuf)
    // layout-blind：读取方不感知后缀，magic 嗅探直读
    const { log: reloaded, brokenAt, encoding, tornTail } = loadSessionLog(file)
    assert.equal(encoding, 'zstd')
    assert.equal(brokenAt, null)
    assert.equal(tornTail, false)
    assert.equal(reloaded.events.length, log.events.length)
    assert.deepEqual(reloaded.events.map(e => e.hash), log.events.map(e => e.hash))
    assert.equal(decodeLogBuffer(Buffer.from(plain, 'utf-8')).encoding, 'plain')
  })
})

test('M7-W3: zstd 能力缺席 = 显式拒绝（CAR-E-ZSTD），不静默降级（能力缺席环境实跑）', { skip: zstdAvailable() ? 'zstd 能力在场（22.15+ 原生）——缺席路径由更早版本环境覆盖' : false }, () => {
  // 能力缺席环境（如 22.19 无 flag / 23.5）：magic 命中后必须显式 throw，不得静默按明文装载
  const fakeZstd = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00])
  assert.throws(() => decodeLogBuffer(fakeZstd), /CAR-E-ZSTD/)
  assert.throws(() => compressJsonlZstd('x'), /CAR-E-ZSTD/)
})
