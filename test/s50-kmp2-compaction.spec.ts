/**
 * 1.14-S2 · K-MP-2 历史压缩面（S50，D-40）
 *
 * 覆盖（红线背书优先）：
 *  - 链不可变双断言：applyCompaction 前后 verifyChain() 均 null；已落链事件逐字节不变
 *    （压缩 = 只追加 compact 事件，原事件零改写）
 *  - 投影语义：compact 后 deriveMessages = [system 摘要] + 保护段原样；被折叠 turn 不再现；
 *    compact 之前登记的请求快照（atSeq ≤ compact.seq）投影仍为全量形态（N1 逐快照自洽）
 *  - 工具对完整性（toolPairIntegrity）：边界落在 toolCall↔toolResult 跨 turn 配对中间 →
 *    自动回退成对整体移出（投影中配对同在保护段）
 *  - 保护段：首个 system 恒不折叠；最近 protectLastTurns 个 turn 原样
 *  - 幂等/fail-visible：无可压缩区间（第二次 apply）→ CAR-E-COMPACT-NORANGE 显式报错
 *  - 摘要注入缝：summarize 回调产物进 payload.summary 与投影；空产物 → CAR-E-COMPACT-SUMMARY
 *  - shouldCompact：enabled 缺省关 = 零变化；阈值事实计数；压缩后重新计数
 *  - config 解析：llm.compaction 拍平（合法 + 非法值 CAR-E-CONFIG）
 *  - 兼容线：无 compact 事件的日志投影与 1.13 逐字节一致（显式对拍）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '../src/session/log.ts'
import { applyCompaction, planCompaction, shouldCompact, defaultSummarizer } from '../src/session/compact.ts'
import { loadCarConfig } from '../src/load/config.ts'

function buildSession(turns: number, opts: { toolAcrossTurns?: boolean } = {}): SessionLog {
  const log = new SessionLog('S-s50')
  log.append('user', 'system', 'sys', 'You are CAR.')
  for (let t = 1; t <= turns; t++) {
    const tid = `T${t}`
    log.append('user', 'user', tid, `用户问题 ${t}`)
    if (opts.toolAcrossTurns && t === turns - 2) {
      // 跨 turn 配对：toolCall 在 T3（可折叠区间），toolResult 落 T4（保护段）——边界破裂场景
      log.append('model', 'toolCall', tid, { id: `X${t}`, tool: 'fs_read', args: { p: t } })
      continue
    }
    if (opts.toolAcrossTurns && t === turns - 1) {
      log.append('plugin', 'toolResult', tid, { id: `X${t - 1}`, result: `res-${t - 1}` })
    }
    log.append('model', 'assistant', tid, `回答 ${t}`)
    log.append('runtime', 'turnEnd', tid, null, { reason: 'completed' })
  }
  return log
}

const drain = (log: SessionLog) => log.deriveMessages()

// ==================== 链不可变（红线） ====================

test('S50-1 红线：压缩前后 verifyChain 均 null + 已落链事件逐字节不变（只追加）', () => {
  const log = buildSession(8)
  const before = log.events.map(e => JSON.stringify(e))
  assert.equal(log.verifyChain(), null)
  applyCompaction(log, { protectLastTurns: 2 })
  assert.equal(log.verifyChain(), null, '压缩后链校验仍 PASS')
  const after = log.events.map(e => JSON.stringify(e))
  assert.equal(after.length, before.length + 1, '只新增一条 compact 事件')
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], `事件 seq=${i} 逐字节不变`)
  }
  const compact = log.events.at(-1)!
  assert.equal(compact.kind, 'compact')
  assert.equal(compact.actor, 'runtime')
})

// ==================== 投影语义 ====================

test('S50-2 投影：compact 后 = [system 摘要] + 保护段原样，被折叠 turn 不再现', () => {
  const log = buildSession(8)
  const evt = applyCompaction(log, { protectLastTurns: 2 }) // 保护 T7/T8，折叠 T1~T6
  const msgs = drain(log) as Array<{ role: string; content?: unknown }>
  assert.equal(msgs[0]!.role, 'system')
  assert.equal(msgs[0]!.content, (evt.payload as { summary: string }).summary, '首条 = 摘要（compact payload 原文）')
  const userMsgs = msgs.filter(m => m.role === 'user').map(m => String(m.content))
  assert.ok(userMsgs.includes('用户问题 7') && userMsgs.includes('用户问题 8'), '保护段 turn 原样保留')
  assert.equal(userMsgs.some(c => /用户问题 [1-6]$/.test(c)), false, '被折叠 turn 的 user 消息不再出现在投影')
  // 原事件仍在链上（append-only）——折叠只发生在投影层
  assert.match(JSON.stringify(log.events), /用户问题 1/)
})

test('S50-3 N1 自洽：压缩前快照断言在压缩后仍成立；压缩后新请求投影含摘要', () => {
  const log = buildSession(6)
  log.snapshotModelRequest() // 压缩前请求（全量形态）
  applyCompaction(log, { protectLastTurns: 2 })
  assert.deepEqual(log.assertModelVisibleLogged(), { ok: true }, '旧快照（atSeq ≤ compact.seq）投影不受压缩影响')
  log.snapshotModelRequest() // 压缩后请求（摘要形态）
  assert.deepEqual(log.assertModelVisibleLogged(), { ok: true })
})

test('S50-4 兼容线：无 compact 事件的投影与 1.13 逐字节一致', () => {
  const log = buildSession(4)
  const expected = [
    { role: 'system', content: 'You are CAR.' },
    { role: 'user', content: '用户问题 1' },
    { role: 'assistant', content: '回答 1' },
    { role: 'user', content: '用户问题 2' },
    { role: 'assistant', content: '回答 2' },
    { role: 'user', content: '用户问题 3' },
    { role: 'assistant', content: '回答 3' },
    { role: 'user', content: '用户问题 4' },
    { role: 'assistant', content: '回答 4' },
  ]
  assert.deepEqual(drain(log), expected)
  assert.equal(log.verifyChain(), null)
})

// ==================== 工具对完整性 ====================

test('S50-5 toolPairIntegrity：跨 turn 配对边界自动回退成对移出', () => {
  const log = buildSession(5, { toolAcrossTurns: true }) // toolCall X3 在 T3（可折叠），toolResult X3 落 T4（保护段）
  const x3Call = log.events.find(e => e.kind === 'toolCall' && (e.payload as { id: string }).id === 'X3')!
  const plan = planCompaction(log, 2) // 保护 T4/T5
  assert.equal(plan.compactedUpTo, x3Call.seq, '边界回退到 toolCall X3（成对整体移出折叠区间）')
  applyCompaction(log, { protectLastTurns: 2 })
  const msgs = JSON.stringify(drain(log))
  assert.ok(msgs.includes('X3') && msgs.includes('"toolCall"'), 'toolCall X3 保留在保护段投影')
  assert.ok(msgs.includes('res-3'), 'toolResult X3 与 call 同在保护段（配对不破裂）')
})

// ==================== 幂等 / fail-visible ====================

test('S50-6 幂等：无可压缩区间（第二次 apply）→ CAR-E-COMPACT-NORANGE 显式报错', () => {
  const log = buildSession(4)
  applyCompaction(log, { protectLastTurns: 2 })
  assert.throws(() => applyCompaction(log, { protectLastTurns: 2 }), /CAR-E-COMPACT-NORANGE/)
  assert.throws(() => planCompaction(buildSession(2), 4), /CAR-E-COMPACT-NORANGE/, '全部在保护段同样显式报错')
})

// ==================== 摘要 ====================

test('S50-7 摘要注入缝：summarize 产物进 payload 与投影；缺省确定性生成器含事实要素', () => {
  const log = buildSession(6)
  const seen: number[] = []
  const evt = applyCompaction(log, {
    protectLastTurns: 2,
    summarize: events => {
      seen.push(events.length)
      return 'LLM 摘要：此前讨论了测试问题。'
    },
  })
  assert.equal(seen.length, 1, 'summarize 收到折叠区间事件')
  assert.equal((evt.payload as { summary: string }).summary, 'LLM 摘要：此前讨论了测试问题。')
  assert.equal((drain(log)[0] as { content: string }).content, 'LLM 摘要：此前讨论了测试问题。')

  const log2 = buildSession(6)
  const evt2 = applyCompaction(log2, { protectLastTurns: 2 })
  const summary = (evt2.payload as { summary: string }).summary
  assert.match(summary, /\[会话压缩摘要\]/)
  assert.match(summary, /用户问题 1/)
  assert.doesNotMatch(summary, /fs_read/, '无工具会话的确定性摘要不含工具行（事实拼装禁估算）')
  assert.throws(
    () => applyCompaction(buildSession(6), { protectLastTurns: 2, summarize: () => '  ' }),
    /CAR-E-COMPACT-SUMMARY/,
    '空摘要 fail-visible',
  )
})

// ==================== shouldCompact / config ====================

test('S50-8 shouldCompact：缺省关 = 零变化；阈值事实计数；压缩后重新计数', () => {
  const log = buildSession(4) // 13 事件
  assert.equal(shouldCompact(log, undefined), false, '未配置 = 不触发（1.13 行为零变化）')
  assert.equal(shouldCompact(log, { enabled: false, thresholdEvents: 1 }), false)
  assert.equal(shouldCompact(log, { enabled: true, thresholdEvents: 100 }), false, '13 < 100 不触发')
  assert.equal(shouldCompact(log, { enabled: true, thresholdEvents: 13 }), true, '计数含全部事件')
  applyCompaction(log, { protectLastTurns: 2 })
  assert.equal(shouldCompact(log, { enabled: true, thresholdEvents: 13 }), false, '压缩后从上次边界重新计数（14-7=7 < 13）')
})

test('S50-9 config 解析：llm.compaction 拍平 + 非法值 CAR-E-CONFIG', () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-s50-cfg-'))
  try {
    const okPath = join(dir, 'car.config.json')
    writeFileSync(okPath, JSON.stringify({ llm: { compaction: { enabled: true, thresholdEvents: 50, protectLastTurns: 2 } } }))
    const ok = loadCarConfig({ explicitPath: okPath })
    assert.equal(ok.error, undefined)
    assert.deepEqual(ok.config.llm?.compaction, { enabled: true, thresholdEvents: 50, protectLastTurns: 2 })

    const badPath = join(dir, 'bad.config.json')
    writeFileSync(badPath, JSON.stringify({ llm: { compaction: { enabled: true, thresholdEvents: -1 } } }))
    const bad = loadCarConfig({ explicitPath: badPath })
    assert.match(bad.error ?? '', /CAR-E-CONFIG/, 'thresholdEvents 非法 → CAR-E-CONFIG fail-visible')

    const unknownPath = join(dir, 'unknown.config.json')
    writeFileSync(unknownPath, JSON.stringify({ llm: { compaction: { foo: 1 } } }))
    const unknown = loadCarConfig({ explicitPath: unknownPath })
    assert.match(unknown.error ?? '', /未知键 llm.compaction.foo/, '未登记键显式拒绝')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S50-11 长会话端到端：211 事件真实规模触发缺省阈值 200 + 折叠/保护/重计三面正确（D-49 观察项验证缺口，设计 §10.4-2）', () => {
  // §10.3 实测：真实会话最大 44 事件（距阈值 4.5 倍，从未触发）——本用例补端到端触发证据
  const log = buildSession(70) // 1 system + 70 × (user+assistant+turnEnd) = 211
  assert.equal(log.events.length, 211)
  assert.equal(shouldCompact(log, { enabled: true }), true, '211 ≥ 缺省阈值 200——真实规模可触发')
  const before = log.events.map(e => JSON.stringify(e))
  assert.equal(log.verifyChain(), null)
  const evt = applyCompaction(log, { protectLastTurns: 4 }) // 保护 T67~T70，折叠 T1~T66
  assert.equal(log.events.length, 212, '只追加一条 compact 事件')
  assert.equal(log.verifyChain(), null, '压缩后链校验仍 PASS')
  for (let i = 0; i < before.length; i++) {
    assert.equal(JSON.stringify(log.events[i]), before[i], `事件 seq=${i} 逐字节不变（append-only）`)
  }
  assert.ok((evt.payload as { summary: string }).summary.length > 0, '摘要产物在位')
  const msgs = drain(log) as Array<{ role: string; content?: unknown }>
  assert.equal(msgs[0]!.role, 'system')
  assert.equal(msgs[0]!.content, (evt.payload as { summary: string }).summary, '首条 = 摘要')
  const userMsgs = msgs.filter(m => m.role === 'user').map(m => String(m.content))
  for (const t of [67, 68, 69, 70]) assert.ok(userMsgs.includes(`用户问题 ${t}`), `保护段 T${t} 原样保留`)
  assert.equal(userMsgs.some(c => /^用户问题 ([1-9]|[1-5][0-9]|6[0-6])$/.test(c)), false, '被折叠 turn 不再现')
  assert.match(JSON.stringify(log.events), /用户问题 1/, '原事件仍在链上（折叠只在投影层）')
  assert.equal(shouldCompact(log, { enabled: true }), false, '压缩后从边界重新计数（不足 200）')
})
