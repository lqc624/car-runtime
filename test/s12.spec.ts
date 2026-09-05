import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { HOST_MAPPINGS } from '../src/host/mappings.ts'
import { HostGateway } from '../src/host/hostGateway.ts'
import { createRuntimeFacade } from '../src/host/facade.ts'
import { createStdioServer } from '../src/host/stdio.ts'
import { loadSessionLog } from '../src/session/log.ts'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function setup() {
  const profiles = new Map(HOST_MAPPINGS.map(h => [h.hostId, h]))
  const facade = createRuntimeFacade({ profiles })
  const audits: Array<{ kind: string }> = []
  const gw = new HostGateway({ facade, audit: e => audits.push({ kind: e.kind }) })
  for (const h of HOST_MAPPINGS) gw.registerHost({ hostId: h.hostId, profile: h, transport: {} as never })
  return { gw, audits, facade }
}

// ==================== stdio ServerTransport（JSON-RPC over 换行分隔 JSON） ====================

test('S12: stdio——tools/list 返回 9 tool 面；tools/call 分发到 HostGateway', async () => {
  const { gw } = setup()
  const server = createStdioServer((tool, args) => gw.handle('claude-code', tool, args))
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)))
  const done = server.serve(input, output)
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 'sess-9' } } }) + '\n')
  input.end()
  await done
  await new Promise(r => setImmediate(r))
  assert.equal(lines.length, 2)
  const list = JSON.parse(lines[0])
  assert.equal(list.result.tools.length, 9)
  const call = JSON.parse(lines[1])
  assert.match(call.result.content[0].text, /"sessionId":"SH-/)
})

test('S12: stdio——未知 method 显式报错；非法 JSON 不崩溃', async () => {
  const { gw } = setup()
  const server = createStdioServer((tool, args) => gw.handle('claude-code', tool, args))
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)))
  const done = server.serve(input, output)
  input.write('not-json\n')
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'host/secret' }) + '\n')
  input.end()
  await done
  await new Promise(r => setImmediate(r))
  const parseErr = JSON.parse(lines[0])
  assert.equal(parseErr.error.code, -32700)
  const unknown = JSON.parse(lines[1])
  assert.equal(unknown.error.code, -32601)
})

// ==================== 归一化数据流：宿主事件 → SessionLog 全链路 ====================

test('S12: 端到端——宿主事件批归一化落哈希链，verify/replay/export 全通', async () => {
  const { gw } = setup()
  const start = await gw.handle('claude-code', 'session_start', { hostSessionId: 'sess-42' })
  const sessionId = (start.result as { sessionId: string }).sessionId
  // 宿主报一批事件（含一条未知事件——降级通道）
  const turn = await gw.handle('claude-code', 'session_turn', {
    sessionId,
    input: { events: [
      { hostEvent: 'user_message', payload: { content: '帮我查下部署状态' } },
      { hostEvent: 'tool_use', payload: { tool_name: 'doctor', tool_call_id: 'c1' } },
      { hostEvent: 'tool_result', payload: { tool_call_id: 'c1', status: 'ok' } },
      { hostEvent: 'assistant_message', payload: { content: '部署正常' } },
      { hostEvent: 'turn_complete', payload: { reason: 'completed' } },
      { hostEvent: 'brand_new_host_event', payload: { x: 1 } }, // 未命中 → hostRaw
    ] },
  })
  assert.equal((turn.result as { reason: string }).reason, 'completed')
  const verify = await gw.handle('claude-code', 'session_verify', { sessionId })
  assert.equal((verify.result as { ok: boolean }).ok, true)
  const replay = await gw.handle('claude-code', 'session_replay', { sessionId })
  const msgs = (replay.result as { messages: Array<{ role: string; content?: { text?: string } }> }).messages
  assert.ok(msgs.some(m => m.role === 'user' && m.content?.text === '帮我查下部署状态'), 'user 归一化入链')
  assert.ok(msgs.some(m => m.role === 'assistant' && m.content?.text === '部署正常'))
  // hostRaw 事件进日志但不进消息投影（原始通道）
  const exportR = await gw.handle('claude-code', 'session_export', { sessionId })
  const bundle = (exportR.result as { bundle: { files: { name: string; content: string }[] } }).bundle
  const jsonl = bundle.files[0].content
  assert.ok(jsonl.includes('brand_new_host_event'), '未命中事件 hostRaw 留痕')
  assert.ok(jsonl.includes('session_registered'), '登记事件落哈希链')
  // 导出包可离线重放（落盘 → loadSessionLog 断链校验）
  const dir = mkdtempSync(join(tmpdir(), 'car-s12-'))
  try {
    const file = join(dir, 'events.jsonl')
    writeFileSync(file, jsonl)
    const { log, brokenAt } = loadSessionLog(file)
    assert.equal(brokenAt, null)
    assert.ok(log.deriveMessages().length >= 2)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 沙箱 trash 容错 */ }
  }
})

test('S12: 跨宿主等价——codex 同语义事件批产出等价日志投影', async () => {
  const { gw } = setup()
  const cc = await gw.handle('claude-code', 'session_start', { hostSessionId: 's1' })
  const cx = await gw.handle('codex', 'session_start', { hostSessionId: 's1' })
  const ccId = (cc.result as { sessionId: string }).sessionId
  const cxId = (cx.result as { sessionId: string }).sessionId
  assert.notEqual(ccId, cxId, '跨宿主会话隔离')
  await gw.handle('claude-code', 'session_turn', { sessionId: ccId, input: { events: [
    { hostEvent: 'user_message', payload: { content: 'hi' } },
    { hostEvent: 'tool_use', payload: { tool_name: 'fs', tool_call_id: 'c1' } },
  ] } })
  await gw.handle('codex', 'session_turn', { sessionId: cxId, input: { events: [
    { hostEvent: 'input_item', payload: { text: 'hi' } },
    { hostEvent: 'function_call', payload: { name: 'fs', call_id: 'c1' } },
  ] } })
  const r1 = await gw.handle('claude-code', 'session_replay', { sessionId: ccId })
  const r2 = await gw.handle('codex', 'session_replay', { sessionId: cxId })
  const m1 = (r1.result as { messages: unknown[] }).messages
  const m2 = (r2.result as { messages: unknown[] }).messages
  assert.deepEqual(m1, m2, '双宿主等价核心断言：投影逐字节一致')
})

test('S12: 审计全留痕——host-call 与拒绝均落审计（无旁路）', async () => {
  const { gw, audits } = setup()
  await gw.handle('ghost', 'session_start', {}) // 未登记
  await gw.handle('claude-code', 'session_start', { hostSessionId: 'x' })
  assert.ok(audits.some(a => a.kind === 'host-rejected'))
  assert.ok(audits.some(a => a.kind === 'host-call'))
})
