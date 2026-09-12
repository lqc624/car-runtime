import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'
import { forkCrossHost, loadForkedLog } from '../src/session/fork.ts'
import { deriveSessionId, HOST_MAPPINGS } from '../src/host/mappings.ts'
import { createRuntimeFacade } from '../src/host/facade.ts'
import { HostGateway } from '../src/host/hostGateway.ts'

// ==================== forkCrossHost 核心原语 ====================

function sourceLog(): SessionLog {
  const log = new SessionLog(deriveSessionId('claude-code', 'sess-A'))
  log.append('user', 'user', 'T1', { text: '帮我校对这段话' })
  log.append('model', 'assistant', 'T1', { text: '好的，请贴出原文' })
  log.append('model', 'toolCall', 'T2', { tool: 'fs_read', id: 'c1' })
  return log
}

test('fork 跨宿主: 链逐字节迁移 + fork 标记落链 + 目标会话 id 确定性派生', () => {
  const src = sourceLog()
  const fork = forkCrossHost(src, { hostId: 'codex', hostSessionId: 'cx-9' })
  assert.equal(fork.sessionId, deriveSessionId('codex', 'cx-9'))
  assert.equal(fork.migrated, 3)
  assert.equal(fork.log.events.length, 4, '3 迁移 + 1 fork 标记')
  assert.equal(fork.log.verifyChain(), null, '迁移后链完整')
  const marker = fork.log.events[3]!
  assert.equal(marker.kind, 'fork')
  assert.deepEqual(marker.payload, {
    fromSessionId: src.sessionId, targetHostId: 'codex', targetHostSessionId: 'cx-9',
    upToSeq: 3, fromTailHash: src.events[2]!.hash,
  })
})

test('fork 跨宿主: 源链断链拒绝 fork（fail-visible，破损链不扩散）', () => {
  const src = sourceLog()
  ;(src.events as unknown as Array<{ payload: unknown }>)[1]!.payload = { text: '被篡改' }
  assert.throws(() => forkCrossHost(src, { hostId: 'codex', hostSessionId: 'cx-9' }), /chain broken at seq 1/)
})

test('fork 跨宿主: upToSeq 部分迁移（前缀 fork）+ 越界显式报错', () => {
  const fork = forkCrossHost(sourceLog(), { hostId: 'codex', hostSessionId: 'cx-1' }, { upToSeq: 2 })
  assert.equal(fork.migrated, 2)
  assert.equal(fork.log.events.length, 3)
  assert.equal((fork.log.events[2]!.payload as { upToSeq: number }).upToSeq, 2)
  assert.throws(() => forkCrossHost(sourceLog(), { hostId: 'codex', hostSessionId: 'cx-2' }, { upToSeq: 99 }), /out of range/)
  assert.throws(() => forkCrossHost(sourceLog(), { hostId: 'codex', hostSessionId: 'cx-3' }, { upToSeq: -1 }), /out of range/)
})

// ==================== loadForkedLog resume 侧装载 ====================

test('resume 装载: 工件 → 链校验 → 归属校验 → 续跑 append 不断链', () => {
  const src = sourceLog()
  const fork = forkCrossHost(src, { hostId: 'codex', hostSessionId: 'cx-9' })
  const loaded = loadForkedLog(fork.jsonl, { hostId: 'codex', hostSessionId: 'cx-9' })
  assert.equal(loaded.sessionId, fork.sessionId)
  assert.equal(loaded.log.verifyChain(), null)
  // 续跑：装载后 append 正常接链（#tail 已恢复）
  loaded.log.append('user', 'user', 'T2', { text: '继续' })
  assert.equal(loaded.log.verifyChain(), null, '续跑后链仍完整')
  assert.equal(loaded.log.events.length, 5)
  // 投影：源会话消息在宿主 B 可见（续跑上下文完整）
  const msgs = loaded.log.deriveMessages()
  assert.equal((msgs[0] as { content: { text: string } }).content.text, '帮我校对这段话')
})

test('resume 装载: 断链工件 / 非 fork 工件 / 归属不匹配 全部拒绝（零静默）', () => {
  const fork = forkCrossHost(sourceLog(), { hostId: 'codex', hostSessionId: 'cx-9' })
  // ① 篡改中间事件 → 断链
  const tampered = fork.jsonl.split('\n').filter(Boolean).map((l, i) => i === 1 ? l.replace('好的', '已篡改') : l).join('\n')
  assert.throws(() => loadForkedLog(tampered), /chain broken/)
  // ② 普通 SessionLog 导出（无 fork 标记）拒绝
  const plain = new SessionLog('S-plain')
  plain.append('user', 'user', 'T1', { text: 'hi' })
  assert.throws(() => loadForkedLog(plain.exportJSONL()), /no fork marker/)
  // ③ 工件归属 codex/cx-9，却被 claude-code/cc-1 装载 → 拒绝
  assert.throws(() => loadForkedLog(fork.jsonl, { hostId: 'claude-code', hostSessionId: 'cc-1' }), /target mismatch/)
  // ④ 归属匹配 → 通过
  assert.doesNotThrow(() => loadForkedLog(fork.jsonl, { hostId: 'codex', hostSessionId: 'cx-9' }))
})

// ==================== 工具面 E2E：宿主 A fork → 工件 → 宿主 B 导入续跑 ====================

function facadeGateway() {
  const profiles = new Map(HOST_MAPPINGS.map(h => [h.hostId, h]))
  const facade = createRuntimeFacade({ profiles })
  const gw = new HostGateway({ facade, audit: () => {} })
  for (const h of HOST_MAPPINGS) gw.registerHost({ hostId: h.hostId, profile: h, transport: {} as never })
  return { facade, gw }
}

test('E2E 跨宿主: 宿主 A 会话 → session_fork → 工件 → 宿主 B session_start 导入 → session_turn 续跑', async () => {
  const { gw } = facadeGateway()
  // 宿主 A（claude-code）：start + 一个 turn（产生消息与 toolCall 事件）
  const a = await gw.handle('claude-code', 'session_start', { hostSessionId: 'sess-A' })
  const aId = (a.result as { sessionId: string }).sessionId
  await gw.handle('claude-code', 'session_turn', { sessionId: aId, input: { events: [
    { hostEvent: 'user_message', payload: { content: '帮我查库存' } },
    { hostEvent: 'tool_use', payload: { tool_name: 'erp_query', tool_call_id: 'c1' } },
    { hostEvent: 'turn_complete', payload: {} },
  ] } })
  // fork 到宿主 B（codex）
  const fk = await gw.handle('claude-code', 'session_fork', { sessionId: aId, targetHostId: 'codex', targetHostSessionId: 'cx-77' })
  const { sessionId: bId, jsonl } = fk.result as { sessionId: string; jsonl: string }
  assert.equal(bId, deriveSessionId('codex', 'cx-77'))
  // 宿主 B：导入工件 start（归属校验内建）→ replay 可见源会话消息
  const b = await gw.handle('codex', 'session_start', { hostSessionId: 'cx-77', importJsonl: jsonl })
  assert.equal((b.result as { sessionId: string }).sessionId, bId)
  const replay = await gw.handle('codex', 'session_replay', { sessionId: bId })
  const messages = (replay.result as { messages: Array<{ content: unknown }> }).messages
  assert.equal((messages[0]!.content as { text: string }).text, '帮我查库存')
  // 宿主 B 续跑：turnId 不与迁移段冲突（迁移段最大 T1 → 续跑 T2）
  const t2 = await gw.handle('codex', 'session_turn', { sessionId: bId, input: { events: [
    { hostEvent: 'input_item', payload: { text: '继续查' } },
    { hostEvent: 'task_complete', payload: {} },
  ] } })
  assert.equal((t2.result as { reason: string }).reason, 'completed')
  // 链完整性：导入 + 续跑后 verify 通过
  const vf = await gw.handle('codex', 'session_verify', { sessionId: bId })
  assert.equal((vf.result as { ok: boolean }).ok, true)
})

test('E2E 跨宿主负例: 工件被第三方宿主导入 → 归属校验拒绝（不静默降级为普通会话）', async () => {
  const { gw } = facadeGateway()
  const a = await gw.handle('claude-code', 'session_start', { hostSessionId: 'sess-A' })
  const aId = (a.result as { sessionId: string }).sessionId
  const fk = await gw.handle('claude-code', 'session_fork', { sessionId: aId, targetHostId: 'codex', targetHostSessionId: 'cx-77' })
  const { jsonl } = fk.result as { jsonl: string }
  // 第三方宿主（未登记 profile 或归属不匹配）导入 → 显式报错
  await assert.rejects(
    () => gw.handle('codex', 'session_start', { hostSessionId: 'other-id', importJsonl: jsonl }).then(r => { if (r.error) throw new Error(r.error) }),
    /target mismatch|CAR-E-FORK/,
  )
  // fork 到未登记目标宿主 → 显式报错
  await assert.rejects(
    () => gw.handle('claude-code', 'session_fork', { sessionId: aId, targetHostId: 'ghost-host', targetHostSessionId: 'x' }).then(r => { if (r.error) throw new Error(r.error) }),
    /not registered/,
  )
})
