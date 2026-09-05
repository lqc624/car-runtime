import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePackage, isWhitelisted, type RegistryConfig } from '../src/load/registry.ts'
import { HOST_MAPPINGS } from '../src/host/mappings.ts'
import { HostGateway } from '../src/host/hostGateway.ts'
import { createRuntimeFacade } from '../src/host/facade.ts'
import { deriveSessionId } from '../src/host/mappings.ts'

// ==================== registry resolution（T-3/T-4 fail-closed 组合） ====================

const enterprise: RegistryConfig = {
  registries: [
    { url: 'https://verdaccio.corp.local', priority: 1, signed: false },
    { url: 'https://artifactory.corp.local/npm', priority: 2, signed: true },
  ],
  allowNpmFallback: false,
  offline: false,
}

test('registry: resolution 四级顺序——② 白名单 priority 升序', () => {
  const r = resolvePackage({ name: 'pkg', version: '1.0.0' }, enterprise)
  assert.equal(r.source, 'registry')
  assert.equal(r.url, 'https://verdaccio.corp.local')
  assert.match(r.decisionId, /^RD-[0-9a-f]{16}$/)
})

test('registry: ① 显式源绑定命中 → 直连；未命中 → 硬失败不降级', () => {
  const hit = resolvePackage({ name: 'pkg', version: '1.0.0', pinnedRegistry: 'https://artifactory.corp.local/npm' }, enterprise)
  assert.equal(hit.source, 'registry')
  assert.equal(hit.url, 'https://artifactory.corp.local/npm')
  const miss = resolvePackage({ name: 'pkg', version: '1.0.0', pinnedRegistry: 'https://evil.example.com' }, enterprise)
  assert.equal(miss.source, 'rejected')
  assert.match(miss.detail, /硬失败不换源/)
})

test('registry: ③ 兜底可关——企业默认拒绝；④ 离线最高优先级', () => {
  const empty: RegistryConfig = { registries: [], allowNpmFallback: false, offline: false }
  const r = resolvePackage({ name: 'pkg', version: '1.0.0' }, empty)
  assert.equal(r.source, 'rejected')
  assert.match(r.detail, /白名单为空且兜底关闭/)
  const open: RegistryConfig = { registries: [], allowNpmFallback: true, offline: false }
  assert.equal(resolvePackage({ name: 'pkg', version: '1.0.0' }, open).source, 'npm-fallback')
  const offline = resolvePackage({ name: 'pkg', version: '1.0.0', pinnedRegistry: 'https://artifactory.corp.local/npm' }, { ...enterprise, offline: true })
  assert.equal(offline.source, 'rejected', '离线覆盖一切（含显式绑定）')
})

test('registry: 审计回调全量落盘（含拒绝决策）+ isWhitelisted', () => {
  const audited: string[] = []
  resolvePackage({ name: 'a', version: '1.0.0' }, enterprise, d => audited.push(d.kind))
  resolvePackage({ name: 'b', version: '1.0.0', pinnedRegistry: 'https://evil' }, enterprise, d => audited.push(d.kind))
  assert.equal(audited.length, 2)
  assert.ok(auditsAllRegistry(audited))
  function auditsAllRegistry(kinds: string[]) { return kinds.every(k => k === 'registry-resolution') }
  assert.equal(isWhitelisted('https://verdaccio.corp.local', enterprise), true)
  assert.equal(isWhitelisted('https://evil.example.com', enterprise), false)
})

// ==================== 双宿主契约测试：五类语义扩全（S11 v0 → S13 v1） ====================

function setup() {
  const profiles = new Map(HOST_MAPPINGS.map(h => [h.hostId, h]))
  const facade = createRuntimeFacade({ profiles })
  const gw = new HostGateway({ facade, audit: () => {} })
  for (const h of HOST_MAPPINGS) gw.registerHost({ hostId: h.hostId, profile: h, transport: {} as never })
  return gw
}

/** 五类语义 × 双宿主 fixture（契约测试数据源——host-mappings-v1 的行为化规约） */
const FIVE_CLASSES = [
  { semantic: 'user-input', cc: ['user_message', { content: 'hi' }], cx: ['input_item', { text: 'hi' }] },
  { semantic: 'assistant-output', cc: ['assistant_message', { content: 'done' }], cx: ['agent_message', { message: 'done' }] },
  { semantic: 'tool-call', cc: ['tool_use', { tool_name: 'fs', tool_call_id: 'c1' }], cx: ['function_call', { name: 'fs', call_id: 'c1' }] },
  { semantic: 'tool-result', cc: ['tool_result', { tool_call_id: 'c1', status: 'ok' }], cx: ['function_call_output', { call_id: 'c1', status: 'ok' }] },
  { semantic: 'turn-end', cc: ['turn_complete', { reason: 'completed' }], cx: ['task_complete', { reason: 'completed' }] },
] as const

test('契约测试 v1: 五类语义双宿主全链路投影等价（经 facade 落哈希链）', async () => {
  const gw = setup()
  const ccId = ((await gw.handle('claude-code', 'session_start', { hostSessionId: 'fx' })).result as { sessionId: string }).sessionId
  const cxId = ((await gw.handle('codex', 'session_start', { hostSessionId: 'fx' })).result as { sessionId: string }).sessionId
  await gw.handle('claude-code', 'session_turn', { sessionId: ccId, input: { events: FIVE_CLASSES.map(f => ({ hostEvent: f.cc[0], payload: f.cc[1] })) } })
  await gw.handle('codex', 'session_turn', { sessionId: cxId, input: { events: FIVE_CLASSES.map(f => ({ hostEvent: f.cx[0], payload: f.cx[1] })) } })
  const r1 = await gw.handle('claude-code', 'session_replay', { sessionId: ccId })
  const r2 = await gw.handle('codex', 'session_replay', { sessionId: cxId })
  const m1 = (r1.result as { messages: unknown[] }).messages
  const m2 = (r2.result as { messages: unknown[] }).messages
  assert.deepEqual(m1, m2, '五类语义投影逐字节一致')
  assert.equal(m1.length, 4, 'user/assistant/toolCall(assistant)/toolResult 入投影；turnEnd 不入消息流')
  // 两侧哈希链独立完整
  const v1 = await gw.handle('claude-code', 'session_verify', { sessionId: ccId })
  const v2 = await gw.handle('codex', 'session_verify', { sessionId: cxId })
  assert.equal((v1.result as { ok: boolean }).ok, true)
  assert.equal((v2.result as { ok: boolean }).ok, true)
})

test('契约测试 v1: 降级同步——未知宿主事件在两侧同构落 hostRaw', async () => {
  const gw = setup()
  const ccId = ((await gw.handle('claude-code', 'session_start', { hostSessionId: 'dg' })).result as { sessionId: string }).sessionId
  const cxId = ((await gw.handle('codex', 'session_start', { hostSessionId: 'dg' })).result as { sessionId: string }).sessionId
  await gw.handle('claude-code', 'session_turn', { sessionId: ccId, input: { events: [{ hostEvent: 'future_thing', payload: { p: 1 } }] } })
  await gw.handle('codex', 'session_turn', { sessionId: cxId, input: { events: [{ hostEvent: 'future_thing', payload: { p: 1 } }] } })
  const e1 = await gw.handle('claude-code', 'session_export', { sessionId: ccId })
  const e2 = await gw.handle('codex', 'session_export', { sessionId: cxId })
  for (const e of [e1, e2]) {
    const jsonl = (e.result as { bundle: { files: { name: string; content: string }[] } }).bundle.files[0].content
    assert.ok(jsonl.includes('"hostRaw"'), 'hostRaw 载体')
    assert.ok(jsonl.includes('future_thing'), '原事件名留痕')
  }
})

test('契约测试 v1: 会话隔离与确定性派生（同 hostSessionId 跨宿主独立）', async () => {
  assert.notEqual(deriveSessionId('claude-code', 's'), deriveSessionId('codex', 's'))
  const gw = setup()
  const a = await gw.handle('claude-code', 'session_start', { hostSessionId: 'dup' })
  const b = await gw.handle('claude-code', 'session_start', { hostSessionId: 'dup' })
  assert.equal((a.result as { sessionId: string }).sessionId, (b.result as { sessionId: string }).sessionId, '同宿主幂等')
})
