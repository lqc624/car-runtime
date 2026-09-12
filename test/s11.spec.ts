import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSessionId, normalizeHostEvent, HOST_MAPPINGS } from '../src/host/mappings.ts'
import { HostGateway, HOST_TOOLS, ingestHostEvent, type RuntimeFacade } from '../src/host/hostGateway.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ==================== session id 归一化 ====================

test('T-1: deriveSessionId 确定性 + 跨宿主隔离 + 无语义解析', () => {
  const a1 = deriveSessionId('claude-code', 'sess-42')
  const a2 = deriveSessionId('claude-code', 'sess-42')
  assert.equal(a1, a2, '幂等')
  assert.match(a1, /^SH-[0-9a-f]{24}$/)
  assert.notEqual(deriveSessionId('codex', 'sess-42'), a1, '不同宿主同 id → 不同 CAR 会话（跨宿主隔离）')
  assert.notEqual(deriveSessionId('claude-code', 'sess-43'), a1)
})

// ==================== 归一化 schema（host-mappings-v1） ====================

test('T-1: 命中映射——两宿主同语义事件归一化结果等价', () => {
  const cc = normalizeHostEvent(HOST_MAPPINGS[0], 'user_message', { content: 'hello' })
  const cx = normalizeHostEvent(HOST_MAPPINGS[1], 'input_item', { text: 'hello' })
  assert.equal(cc.kind, 'user')
  assert.equal(cx.kind, 'user')
  assert.deepEqual(cc.payload, cx.payload) // { text: 'hello' }——等价性核心断言
  assert.equal(cc.degraded, false)
  assert.equal(cx.degraded, false)
})

test('T-1: 未命中 → hostRaw 降级留痕（零静默）', () => {
  const r = normalizeHostEvent(HOST_MAPPINGS[0], 'unknown_future_event', { foo: 1 })
  assert.equal(r.kind, 'hostRaw')
  assert.equal(r.degraded, true)
  assert.equal(r.payload.hostEvent, 'unknown_future_event')
  assert.deepEqual(r.payload.raw, { foo: 1 }, '原样保留可回溯')
})

test('T-1: toolCall 归一化——字段重命名（tool_name→tool / name→tool）', () => {
  const cc = normalizeHostEvent(HOST_MAPPINGS[0], 'tool_use', { tool_name: 'fs', tool_call_id: 'c1' })
  const cx = normalizeHostEvent(HOST_MAPPINGS[1], 'function_call', { name: 'fs', call_id: 'c1' })
  assert.deepEqual(cc.payload, cx.payload) // { tool: 'fs', id: 'c1' }
})

// ==================== HostGateway（9 tool 面 + 登记制） ====================

function mockFacade(): RuntimeFacade {
  return {
    sessionStart: async ({ hostSessionId }) => ({ sessionId: deriveSessionId('claude-code', hostSessionId) }),
    sessionTurn: async () => ({ reason: 'completed', steps: 1 }),
    sessionStop: async () => ({ reason: 'aborted' }),
    sessionStatus: async () => ({ state: 'idle' }),
    sessionReplay: async () => ({ messages: [] }),
    sessionVerify: async () => ({ ok: true, brokenAt: null }),
    sessionExport: async () => ({ bundle: {} }),
    toolList: async () => ({ tools: ['t1'] }),
    toolCall: async () => ({ ok: true, result: 'x' }),
  }
}

test('T-1: 登记制——未登记 host 拒绝（A050001）+ 重复登记报错', async () => {
  const audits: string[] = []
  const gw = new HostGateway({ facade: mockFacade(), audit: e => audits.push(e.kind) })
  const r = await gw.handle('ghost', 'session_status', {})
  assert.equal(r.ok, false)
  assert.match(r.error!, /A050001/)
  assert.ok(audits.includes('host-rejected'), '拒绝也留痕')
  gw.registerHost({ hostId: 'claude-code', profile: HOST_MAPPINGS[0], transport: { onRequest: async () => ({ jsonrpc: '2.0', id: 1 }), alive: () => true, close: () => {} } })
  assert.throws(() => gw.registerHost({ hostId: 'claude-code', profile: HOST_MAPPINGS[0], transport: {} as never }), /already registered/)
})

test('T-1: 10 tool 面固定 + 未知 tool 拒绝（step 循环不暴露）', async () => {
  const gw = new HostGateway({ facade: mockFacade(), audit: () => {} })
  assert.deepEqual(gw.listTools().sort(), [...HOST_TOOLS].sort())
  assert.equal(HOST_TOOLS.length, 10)
  gw.registerHost({ hostId: 'claude-code', profile: HOST_MAPPINGS[0], transport: {} as never })
  const r = await gw.handle('claude-code', 'run_step', {})
  assert.equal(r.ok, false)
  assert.match(r.error!, /step 循环不暴露/)
})

test('T-1: 端到端分发——facade 调用 + 审计留痕', async () => {
  const audits: string[] = []
  const gw = new HostGateway({ facade: mockFacade(), audit: e => audits.push(e.kind) })
  gw.registerHost({ hostId: 'claude-code', profile: HOST_MAPPINGS[0], transport: {} as never })
  const r = await gw.handle('claude-code', 'session_start', { hostSessionId: 'sess-42' })
  assert.equal(r.ok, true)
  assert.match((r.result as { sessionId: string }).sessionId, /^SH-/)
  assert.ok(audits.includes('host-call'))
})

// ==================== 双宿主等价：契约测试框架（S13 扩全五类） ====================

test('契约测试 v0: 同一 fixture 序列在两宿主 profile 下归一化等价', () => {
  const fixtures: Array<{ semantic: string; cc: [string, Record<string, unknown>]; cx: [string, Record<string, unknown>] }>[] = [
    [{
      semantic: 'user-input',
      cc: ['user_message', { content: 'hi' }],
      cx: ['input_item', { text: 'hi' }],
    }],
    [{
      semantic: 'tool-call',
      cc: ['tool_use', { tool_name: 'fs', tool_call_id: 'c1' }],
      cx: ['function_call', { name: 'fs', call_id: 'c1' }],
    }],
  ]
  const flat = fixtures.flat()
  for (const f of flat) {
    const a = normalizeHostEvent(HOST_MAPPINGS[0], f.cc[0], f.cc[1])
    const b = normalizeHostEvent(HOST_MAPPINGS[1], f.cx[0], f.cx[1])
    assert.equal(a.kind, b.kind, `${f.semantic}: kind 等价`)
    assert.deepEqual(a.payload, b.payload, `${f.semantic}: payload 等价`)
    assert.equal(a.degraded, b.degraded)
  }
})

test('静态架构断言: 宿主标识字符串只允许出现在 mappings 数据文件', () => {
  const scan = (dir: string): string[] => readdirSync(dir, { recursive: true } as never)
    .filter(f => String(f).endsWith('.ts'))
    .map(f => join(dir, String(f)))
  // 只扫生产代码（src/）——测试 fixture 自身含宿主标识属预期；mappings.ts 为唯一数据白名单
  const files = scan('src').filter(f => !f.replaceAll('\\', '/').endsWith('src/host/mappings.ts'))
  const offenders = files.filter(f => /claude-code|codex/.test(readFileSync(f, 'utf-8')))
  assert.deepEqual(offenders, [], `宿主标识泄漏到非数据文件: ${offenders.join(', ')}`)
})

test('ingestHostEvent: 未登记宿主归一化拒绝（登记制在归一化之前）', () => {
  assert.throws(() => ingestHostEvent('unregistered', 'user_message', {}), /A050001/)
})
