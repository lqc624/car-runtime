/**
 * 1.6-S2 · 宿主工具面透传（S36）：RuntimeFacade toolList/toolCall 实装（D-25）
 *
 * 覆盖：
 *  - toolList：声明面出站（name/description/parameters）+ **declaredSideEffect 不出站**（权限面
 *    只进权限门红线）；未装配 = 空面（占位形态兼容）
 *  - toolCall 权限门：readonly 执行 / write（显式声明与未声明 T-22 收口）一律 policy 拒绝
 *    （CAR-E-HOST-AUTHZ——mcp-serve 无人审回路，deny-by-default）/ 未知工具显式报错 /
 *    工具异常=成对错误结果（US-5 同款）
 *  - 成对落链：actor='user'（宿主=用户代理）+ turnId='T0'（会话级能力面，sessionTurn 从 T1
 *    起不冲突）+ id 序列 host-tc-N；verifyChain 全程完整；跨源同名 CAR-E-DUP 由 cli 装配层
 *    fail-closed（spawn E2E 断言）
 *  - spawn E2E：mcp-serve 真进程 stdio——tools/list 十面不变 + tool_list 真实出插件工具 +
 *    tool_call readonly 执行 / write 拒绝 / verify 链完整（1.6-GO-5 生产调用点核查）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeFacade } from '../src/host/facade.ts'
import { HostGateway } from '../src/host/hostGateway.ts'
import { HOST_MAPPINGS, deriveSessionId } from '../src/host/mappings.ts'
import type { ToolReg } from '../src/load/loader.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

function makeTools(): Map<string, ToolReg> {
  return new Map([
    ['echo', {
      name: 'echo', description: '回声工具', parameters: { type: 'object', properties: { text: { type: 'string' } } },
      declaredSideEffect: 'readonly', run: async (args: Record<string, unknown>) => 'pong:' + String((args as { text?: string }).text ?? ''),
    }],
    ['write_file', { name: 'write_file', declaredSideEffect: 'write', run: async () => 'written' }],
    ['stealth', { name: 'stealth', run: async () => 'undeclared' }], // 未声明 sideEffect——T-22 收口 write
  ])
}

function gatewayWith(tools?: Map<string, ToolReg>) {
  const facade = createRuntimeFacade({ profiles: new Map(HOST_MAPPINGS.map(h => [h.hostId, h])), ...(tools ? { tools } : {}) })
  const gw = new HostGateway({ facade, audit: () => {} })
  gw.registerHost({ hostId: 'claude-code', profile: HOST_MAPPINGS[0]!, transport: {} as never })
  return { facade, gw }
}

test('S36: toolList 声明面出站——name/description/parameters 齐，declaredSideEffect 权限面不出站', async () => {
  const { gw } = gatewayWith(makeTools())
  await gw.handle('claude-code', 'session_start', { hostSessionId: 's36-list' })
  const r = await gw.handle('claude-code', 'tool_list', {})
  assert.ok(r.ok)
  const tools = (r.result as { tools: Array<Record<string, unknown>> }).tools
  assert.equal(tools.length, 3)
  const echo = tools.find(t => t.name === 'echo')!
  assert.equal(echo.description, '回声工具')
  assert.deepEqual(echo.parameters, { type: 'object', properties: { text: { type: 'string' } } })
  assert.ok(tools.every(t => !('declaredSideEffect' in t)), '权限面不出站红线：sideEffect 信息不经宿主面外泄')
  assert.ok(tools.every(t => !('run' in t)), '执行面不出站')
})

test('S36: toolList 未装配 = 空面（S12 占位形态兼容）', async () => {
  const { gw } = gatewayWith()
  await gw.handle('claude-code', 'session_start', { hostSessionId: 's36-empty' })
  const r = await gw.handle('claude-code', 'tool_list', {})
  assert.ok(r.ok)
  assert.deepEqual((r.result as { tools: unknown[] }).tools, [])
})

test('S36: toolCall readonly 执行——ok + 成对落链（actor=user/turnId=T0/id 序列）+ 链完整', async () => {
  const { gw } = gatewayWith(makeTools())
  const { sessionId } = await (await gw.handle('claude-code', 'session_start', { hostSessionId: 's36-exec' })).result as { sessionId: string }
  // gateway.handle 把 facade 返回值包进 {ok:true, result:<facade envelope>}——双层 ok 语义
  const r1 = await gw.handle('claude-code', 'tool_call', { sessionId, tool: 'echo', arguments: { text: 'hi' } })
  assert.ok(r1.ok)
  assert.deepEqual(r1.result, { ok: true, result: 'pong:hi' })
  const r2 = await gw.handle('claude-code', 'tool_call', { sessionId, tool: 'echo', arguments: { text: 'again' } })
  assert.deepEqual(r2.result, { ok: true, result: 'pong:again' })
  // 落链核查经 sessionExport（生产消费路径）：toolCall actor=user + turnId=T0 + id 序列 host-tc-N
  const exp = await gw.handle('claude-code', 'session_export', { sessionId })
  const bundle = (exp.result as { bundle: { files: Array<{ name: string; content: string }> } }).bundle
  const eventsFile = bundle.files.find(f => f.name.endsWith('events.jsonl'))!
  const events = eventsFile.content.trim().split('\n').map(l => JSON.parse(l)) as Array<{ actor: string; kind: string; turnId: string; payload: { id?: string; tool?: string } }>
  const calls = events.filter(e => e.kind === 'toolCall')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(e => e.actor === 'user' && e.turnId === 'T0'), 'D-25：宿主=用户代理，会话级能力面落 T0（sessionTurn 从 T1 起不冲突）')
  assert.deepEqual(calls.map(e => e.payload.id), ['host-tc-1', 'host-tc-2'])
  const verify = await gw.handle('claude-code', 'session_verify', { sessionId })
  assert.deepEqual((verify.result as { ok: boolean }).ok, true, '工具调用成对落链后哈希链完整')
})

test('S36: toolCall write 类 policy 拒绝（显式声明 + 未声明 T-22 收口双路径）+ 拒绝落链', async () => {
  const { gw } = gatewayWith(makeTools())
  const { sessionId } = await (await gw.handle('claude-code', 'session_start', { hostSessionId: 's36-deny' })).result as { sessionId: string }
  const w = await gw.handle('claude-code', 'tool_call', { sessionId, tool: 'write_file' })
  assert.ok(w.ok, 'handle 层 ok（facade 正常返回 envelope）')
  assert.equal((w.result as { ok: boolean }).ok, false, 'facade 层 ok=false')
  assert.match((w.result as { error?: string }).error!, /CAR-E-HOST-AUTHZ/)
  const s = await gw.handle('claude-code', 'tool_call', { sessionId, tool: 'stealth' })
  assert.equal((s.result as { ok: boolean }).ok, false, 'T-22：未声明 sideEffect 收口 write → 同样拒绝')
  assert.match((s.result as { error?: string }).error!, /CAR-E-HOST-AUTHZ/)
  // 拒绝也落链（runtime/toolResult authorization-denied）——审计全量留痕
  const replay = await gw.handle('claude-code', 'session_replay', { sessionId })
  const results = ((replay.result as { messages: Array<{ role: string; content?: unknown }> }).messages).filter(m => m.role === 'toolResult')
  const denied = results.filter(m => (m.content as { error?: string }).error === 'authorization-denied')
  assert.equal(denied.length, 2, '两次拒绝各落一条授权拒绝记录（单条即终态——D-23 不收敛）')
  const verify = await gw.handle('claude-code', 'session_verify', { sessionId })
  assert.deepEqual((verify.result as { ok: boolean }).ok, true)
})

test('S36: toolCall 未知工具显式报错 + 成对落链；工具异常=成对错误结果（US-5 同款）', async () => {
  const tools = new Map<string, ToolReg>([['boom', { name: 'boom', declaredSideEffect: 'readonly', run: async () => { throw new Error('炸了') } }]])
  const { gw } = gatewayWith(tools)
  const { sessionId } = await (await gw.handle('claude-code', 'session_start', { hostSessionId: 's36-err' })).result as { sessionId: string }
  const unk = await gw.handle('claude-code', 'tool_call', { sessionId, tool: 'nope' })
  assert.ok(unk.ok, 'handle 层正常返回')
  assert.equal((unk.result as { ok: boolean }).ok, false, 'facade 层显式拒绝')
  assert.match((unk.result as { error?: string }).error!, /unknown tool "nope"/)
  const err = await gw.handle('claude-code', 'tool_call', { sessionId, tool: 'boom', arguments: {} })
  assert.equal((err.result as { ok: boolean }).ok, false)
  assert.match((err.result as { error?: string }).error!, /炸了/)
  const replay = await gw.handle('claude-code', 'session_replay', { sessionId })
  const results = ((replay.result as { messages: Array<{ role: string; content?: unknown }> }).messages).filter(m => m.role === 'toolResult')
  assert.equal((results[0]!.content as { error?: string }).error, 'unknown tool "nope"')
  assert.match((results[1]!.content as { error?: string }).error!, /炸了/, '工具异常=结果非中断（US-5/D5 语义同款）')
})

test('S36: 未装配 tool 面时 toolCall 显式报错（S13 静默占位退役——fail-visible）', async () => {
  const { gw } = gatewayWith()
  const { sessionId } = await (await gw.handle('claude-code', 'session_start', { hostSessionId: 's36-nobridge' })).result as { sessionId: string }
  const r = await gw.handle('claude-code', 'tool_call', { sessionId, tool: 'echo' })
  assert.equal(r.ok, false)
  assert.match(r.error!, /tool 面未装配/)
})

// ==================== spawn E2E（生产调用点——1.6-GO-5） ====================

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s36-${name}-`))
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

function talk(requests: string[], plugin: string): Promise<{ outs: any[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve', '--plugin', plugin], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('exit', () => {
      try { resolve({ outs: out.split('\n').filter(Boolean).map(l => JSON.parse(l)), stderr: err }) } catch (e) { reject(e) }
    })
    for (const r of requests) child.stdin.write(r + '\n')
    child.stdin.end()
  })
}

test('S36: spawn E2E——mcp-serve 真进程 tool_list 透传插件工具面 + tool_call 执行/拒绝 + verify 链完整', async () => {
  await withTempDir('e2e', async dir => {
    const plugin = join(dir, 'p.ts')
    writeFileSync(plugin, [
      'export const manifest = { name: "s36p", version: "1.0.0" }',
      'export default function apply(api) {',
      '  api.registerTool({ name: "echo", description: "回声", declaredSideEffect: "readonly", parameters: { type: "object", properties: { text: { type: "string" } } }, run: async (a) => "pong:" + a.text })',
      '  api.registerTool({ name: "write_file", declaredSideEffect: "write", run: async () => "written" })',
      '}',
    ].join('\n'))
    // 派生 id 进程内预计算（确定性派生——session_start 返回必须一致）
    const sid = deriveSessionId('claude-code', 's36-e2e')
    const { outs } = await talk([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's36-e2e' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_list', arguments: {} } }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_call', arguments: { sessionId: sid, tool: 'echo', arguments: { text: 'hi' } } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'tool_call', arguments: { sessionId: sid, tool: 'write_file', arguments: {} } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'session_verify', arguments: { sessionId: sid } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'session_replay', arguments: { sessionId: sid } } }),
    ], plugin)
    assert.equal(outs[0].result.tools.length, 10, 'MCP tools/list 十面不变（宿主能力面与插件工具面分层）')
    assert.equal(JSON.parse(outs[1].result.content[0].text).sessionId, sid, '确定性派生经真进程复核')
    const listed = JSON.parse(outs[2].result.content[0].text) as { tools: Array<Record<string, unknown>> }
    assert.deepEqual(listed.tools.map(t => t.name), ['echo', 'write_file'], 'tool_list 透传插件声明面')
    assert.equal(listed.tools.find(t => t.name === 'echo')!.description, '回声')
    assert.ok(listed.tools.every(t => !('declaredSideEffect' in t)), '权限面不出站经真进程协议面复核')
    assert.deepEqual(JSON.parse(outs[3].result.content[0].text), { ok: true, result: 'pong:hi' }, 'readonly 工具经宿主面真实执行（facade envelope 经 stdio content 透出）')
    const denied = JSON.parse(outs[4].result.content[0].text) as { ok: boolean; error?: string }
    assert.equal(denied.ok, false, 'write 类工具 policy 拒绝（facade envelope——handle 层未抛错）')
    assert.match(denied.error!, /CAR-E-HOST-AUTHZ/)
    assert.equal(JSON.parse(outs[5].result.content[0].text).ok, true, '工具调用成对落链后哈希链完整')
    const msgs = JSON.parse(outs[6].result.content[0].text).messages as Array<{ role: string; content?: unknown; toolCall?: unknown }>
    assert.ok(msgs.some(m => m.role === 'assistant' && (m.toolCall as { tool?: string })?.tool === 'echo'), 'toolCall 落链经 replay 可见')
    assert.deepEqual(msgs.filter(m => m.role === 'toolResult').map(m => m.content), [
      { id: 'host-tc-1', result: 'pong:hi' },
      { id: 'host-tc-2', error: 'authorization-denied', granted: false, mode: 'host-policy' },
    ])
  })
})

test('S36: spawn E2E——tool_call 带 sessionId 全链（readonly 执行 / write 拒绝 / verify 完整）', async () => {
  await withTempDir('e2e2', async dir => {
    const plugin = join(dir, 'p.ts')
    writeFileSync(plugin, [
      'export const manifest = { name: "s36p2", version: "1.0.0" }',
      'export default function apply(api) {',
      '  api.registerTool({ name: "echo", description: "回声", declaredSideEffect: "readonly", run: async (a) => "pong:" + a.text })',
      '  api.registerTool({ name: "write_file", declaredSideEffect: "write", run: async () => "written" })',
      '}',
    ].join('\n'))
    const start = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's36-e2e2' } } })
    const first = await talk([start], plugin)
    const sid = JSON.parse(first.outs[0].result.content[0].text).sessionId as string
    const { outs } = await talk([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's36-e2e2' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_call', arguments: { sessionId: sid, tool: 'echo', arguments: { text: 'hi' } } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_call', arguments: { sessionId: sid, tool: 'write_file', arguments: {} } } }),
    ], plugin)
    assert.deepEqual(JSON.parse(outs[1].result.content[0].text), { ok: true, result: 'pong:hi' }, 'readonly 工具经宿主面真实执行（跨进程幂等派生会话）')
    const denied2 = JSON.parse(outs[2].result.content[0].text) as { ok: boolean; error?: string }
    assert.equal(denied2.ok, false, 'write 类工具 policy 拒绝经真进程协议面可达')
    assert.match(denied2.error!, /CAR-E-HOST-AUTHZ/)
  })
})

test('S36: spawn E2E——跨源同名工具 CAR-E-DUP fail-closed 启动中止（exit 1）', async () => {
  await withTempDir('e2e3', async dir => {
    const pA = join(dir, 'a.ts')
    const pB = join(dir, 'b.ts')
    for (const [p, name] of [[pA, 'a'], [pB, 'b']] as const) {
      writeFileSync(p, `export const manifest = { name: "${name}", version: "1.0.0" }\nexport default function apply(api) { api.registerTool({ name: "dup_tool", declaredSideEffect: "readonly", run: async () => "${name}" }) }\n`)
    }
    const code = await new Promise<number>(resolve => {
      const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve', '--plugin', pA, '--plugin', pB], { stdio: ['pipe', 'pipe', 'pipe'] })
      let err = ''
      child.stderr.on('data', d => { err += d })
      child.on('exit', c => { resolve(c ?? -1) })
      child.stdin.end()
    })
    assert.equal(code, 1, '禁静默覆盖：fail-closed 启动中止（1.4-S1 跨源同名纪律同款）')
  })
})
