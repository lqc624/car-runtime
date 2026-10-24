/**
 * 1.18-K5 · D-51 压缩 token 维度阈值（S62）
 *
 * 覆盖（规划 AC-3）：
 *  - 缺省零变化：thresholdTokens 缺席 = 1.17 行为零变化（事件维度独裁）
 *  - token 单独命中：事件数低于阈值 + 最近 usage 全上下文 ≥ thresholdTokens → 触发
 *  - 双阈值 OR：事件维度命中（无 usage）照样触发（既有行为不漂移）
 *  - 口径：input + cacheRead + cacheCreation（两族归一化后 = 最近一次请求全上下文）
 *  - 最近一条 usage 口径：多请求 turn 以最后一条为准（上下文只看最新）
 *  - 无 usage（首轮前）不触发；非数值字段容错按 0（stop.ts 聚合同纪律）
 *  - enabled 缺省关 = 零变化；thresholdTokens ≤ 0 不生效
 *  - config 解析：llm.compaction.thresholdTokens 拍平（合法）+ 非法值（0/负/非整数）CAR-E-CONFIG
 *  - 端到端：token 命中 → shouldCompact 放行 → applyCompaction 落链 → 投影折叠（下游不变）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '../src/session/log.ts'
import { shouldCompact, applyCompaction } from '../src/session/compact.ts'
import { loadCarConfig } from '../src/load/config.ts'

/** 三 turn 会话（事件数远低于 200）+ 可选 usage 事实（chatStep 落链形态） */
function buildLog(usages: Array<{ input?: number; cacheRead?: number; cacheCreation?: number }>): SessionLog {
  const log = new SessionLog('S-s62')
  log.append('user', 'system', 'sys', 'You are CAR.')
  for (let t = 1; t <= 3; t++) {
    log.append('user', 'user', `T${t}`, `用户问题 ${t}`)
    const u = usages[t - 1]
    if (u) {
      log.append('runtime', 'usage', `T${t}`, {
        model: 'probe-model', adapterId: 'anthropic',
        input: u.input ?? 0, output: 100,
        cacheRead: u.cacheRead ?? 0, cacheCreation: u.cacheCreation ?? 0,
        providerRaw: {},
      })
    }
    log.append('model', 'assistant', `T${t}`, `回答 ${t}`)
    log.append('runtime', 'turnEnd', `T${t}`, null, { reason: 'completed' })
  }
  return log
}

// ==================== 缺省与门控 ====================

test('S62-1 缺省零变化：thresholdTokens 缺席时 usage 再大也不触发（事件维度独裁）', () => {
  const log = buildLog([{ input: 999_999 }])
  assert.equal(shouldCompact(log, { enabled: true }), false)
  assert.equal(shouldCompact(log, { enabled: true, thresholdEvents: 200 }), false)
})

test('S62-2 enabled 缺省关 = 零变化（token 命中也不触发）', () => {
  const log = buildLog([{ input: 999_999 }])
  assert.equal(shouldCompact(log, { thresholdTokens: 1000 }), false)
  assert.equal(shouldCompact(log, undefined), false)
})

test('S62-3 thresholdTokens ≤ 0 不生效（容错面 = 缺席，禁负值恒真）', () => {
  const log = buildLog([{ input: 5 }])
  assert.equal(shouldCompact(log, { enabled: true, thresholdTokens: 0 }), false)
  assert.equal(shouldCompact(log, { enabled: true, thresholdTokens: -100 }), false)
})

// ==================== 触发面 ====================

test('S62-4 token 单独命中：事件数 15 < 200，最近 usage 全上下文 ≥ 阈值 → 触发', () => {
  const log = buildLog([{}, {}, { input: 90_000 }])
  assert.equal(shouldCompact(log, { enabled: true, thresholdTokens: 78_000 }), true)
})

test('S62-5 双阈值 OR：事件维度命中（无任何 usage）照样触发（既有行为不漂移）', () => {
  const log = buildLog([])
  for (let i = 0; i < 200; i++) log.append('user', 'user', `X${i}`, `补齐事件数 ${i}`)
  assert.equal(shouldCompact(log, { enabled: true, thresholdTokens: 999_999 }), true)
})

test('S62-6 口径 = input + cacheRead + cacheCreation（provider 报告全上下文）', () => {
  // input 单独不够，三分量之和过线 → 触发
  const log = buildLog([{ input: 30_000, cacheRead: 40_000, cacheCreation: 10_000 }])
  assert.equal(shouldCompact(log, { enabled: true, thresholdTokens: 78_000 }), true)
  // 三分量之和不过线 → 不触发
  const log2 = buildLog([{ input: 30_000, cacheRead: 40_000 }])
  assert.equal(shouldCompact(log2, { enabled: true, thresholdTokens: 78_000 }), false)
})

test('S62-7 最近一条 usage 口径：以最后一条为准（上下文只看最新）', () => {
  // 早期大上下文、最近小 → 不触发
  const shrunk = buildLog([{ input: 90_000 }, {}, { input: 5_000 }])
  assert.equal(shouldCompact(shrunk, { enabled: true, thresholdTokens: 78_000 }), false)
  // 早期小、最近大 → 触发
  const grown = buildLog([{ input: 5_000 }, {}, { input: 90_000 }])
  assert.equal(shouldCompact(grown, { enabled: true, thresholdTokens: 78_000 }), true)
})

test('S62-8 无 usage（首轮前）不触发；非数值字段容错按 0', () => {
  assert.equal(shouldCompact(buildLog([]), { enabled: true, thresholdTokens: 100 }), false)
  const corrupt = new SessionLog('S-s62-corrupt')
  corrupt.append('user', 'system', 'sys', 'You are CAR.')
  corrupt.append('user', 'user', 'T1', 'q')
  corrupt.append('runtime', 'usage', 'T1', { input: 'corrupted', output: 1, providerRaw: {} })
  assert.equal(shouldCompact(corrupt, { enabled: true, thresholdTokens: 100 }), false)
})

// ==================== 端到端（下游不变） ====================

test('S62-9 端到端：token 命中 → applyCompaction 落链 → 投影折叠（事件阈值从未触及）', () => {
  const log = buildLog([{}, {}, { input: 90_000 }])
  assert.equal(log.events.length < 200, true, '前置：事件数远低于 200（token 维度独走）')
  const cfg = { enabled: true, thresholdTokens: 78_000, protectLastTurns: 2 }
  assert.equal(shouldCompact(log, cfg), true)
  const before = log.events.map(e => JSON.stringify(e))
  assert.equal(log.verifyChain(), null)
  const compactEvent = applyCompaction(log, { protectLastTurns: 2 })
  assert.equal(log.verifyChain(), null, '压缩后链校验仍 PASS')
  assert.equal(log.events.length, before.length + 1, '只追加一条 compact 事件')
  for (let i = 0; i < before.length; i++) assert.equal(JSON.stringify(log.events[i]), before[i])
  assert.equal(compactEvent.kind, 'compact')
  const payload = compactEvent.payload as { compactedUpTo: number }
  assert.equal(typeof payload.compactedUpTo, 'number', '折叠边界随 compact 事件落链')
  const msgs = log.deriveMessages()
  assert.equal(msgs.some(m => m.role === 'user' && m.content === '用户问题 1'), false, 'T1 已折叠')
  assert.equal(msgs.some(m => m.role === 'user' && m.content === '用户问题 3'), true, '保护段原样')
})

// ==================== config 解析 ====================

test('S62-10 config：llm.compaction.thresholdTokens 合法拍平 + 非法值 CAR-E-CONFIG', () => {
  const dir = mkdtempSync(join(tmpdir(), 's62-cfg-'))
  try {
    const okPath = join(dir, 'car.config.json')
    writeFileSync(okPath, JSON.stringify({ llm: { compaction: { enabled: true, thresholdTokens: 78000 } } }))
    const ok = loadCarConfig({ explicitPath: okPath })
    assert.equal(ok.error, undefined)
    assert.deepEqual(ok.config.llm?.compaction, { enabled: true, thresholdTokens: 78000 })

    for (const bad of [0, -5, 1.5, '78000']) {
      writeFileSync(okPath, JSON.stringify({ llm: { compaction: { thresholdTokens: bad } } }))
      const r = loadCarConfig({ explicitPath: okPath })
      assert.match(r.error ?? '', /CAR-E-CONFIG/, `thresholdTokens=${String(bad)} 应拒绝`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
