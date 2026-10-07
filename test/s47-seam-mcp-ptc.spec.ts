/**
 * s47 · seam MCP/PTC 真桥蓝本回归（1.12-S2 / D-20/D-35/D-36/D-37）
 *
 * 断言面（全部经 seam 公共 API 驱动——本文件仅 `import * as seam from '../src/seam.ts'` 一个内核入口，
 * 禁深路径 import：出面即唯一通路，反证窄面完备性 R-1/D-36 负面清单）：
 *  - MCP 蓝本（cli.ts --mcp 段同构）：登记注册 → 工具入声明面（T-22 缺省 write）→ callTool traceparent
 *    三态（无 tp 零注入字节面不变 / 有 tp 双载体同值 D-29+D-32 / BD-02 崩溃标记不可用）；跨源同名冲突显式报错；
 *  - 明文凭据红线（CR-05 随行为面走）：McpGateway.register env / resolveMcpHeaders 明文与 ${ENV} 展开/fail-visible；
 *  - PTC 蓝本（cli.ts --ptc 段同构）：toolsMap→registry 快照 → renderSdkFromRegistry → makePtcToolDefinition
 *    （run_code 强制 write + worker 真执行 + audit 结构化 + spanBridge 挂 ptcRelay）；
 *  - 窄面反证（R-4）：runCode/JsonRpc 层/trace 通道内部件不在 seam 面；
 *  - reload 面（D-37 确认性）：mountPlugin reloadEpoch 击穿 ESM 缓存 + invalidate 语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as seam from '../src/seam.ts'
import type { ClientTransport, JsonRpcRequest, JsonRpcResponse } from '../src/mcp/gateway.ts'

// 类型面借用（s47 消费方写法：类型经 seam 出面的模块路径取得——类型不占运行时窄面，
// 平台 TS 消费同等形态；此处 import type 不构成「深路径运行时依赖」）
void (0 as unknown as ClientTransport)

function fakeTransport(handler: (req: JsonRpcRequest) => JsonRpcResponse | Promise<JsonRpcResponse>) {
  const seen: Array<{ req: JsonRpcRequest; opts?: { traceparent?: string } }> = []
  const transport: ClientTransport = {
    send: async (req, opts) => { seen.push({ req, opts }); return await handler(req) },
    alive: () => true,
    close() {},
  }
  return { transport, seen }
}

const toolsListResponse = (id: number): JsonRpcResponse => ({
  jsonrpc: '2.0', id,
  result: { tools: [
    { name: 'search', description: '搜索文档', sideEffect: 'readonly', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'deploy' }, // 未声明 sideEffect → T-22 缺省 write
  ] },
})

test('s47: MCP 蓝本——注册入声明面（T-22 缺省 write）+ callTool traceparent 三态', async () => {
  const gw = new seam.McpGateway()
  const { transport, seen } = fakeTransport(req => req.method === 'tools/list'
    ? toolsListResponse(req.id)
    : { jsonrpc: '2.0', id: req.id, result: { content: [{ text: '命中 3 条' }] } })
  const tools = await gw.register({ serverId: 'docs', transport })
  assert.equal(tools.length, 2)
  assert.equal(tools.find(t => t.name === 'search')!.declaredSideEffect, 'readonly', '声明面照录')
  assert.equal(tools.find(t => t.name === 'deploy')!.declaredSideEffect, 'write', 'T-22：未声明按 write 最高约束')

  // 三态①：无 traceparent → send 第二参缺席 + params 无 _meta（JSON-RPC 字节面不变，D-29）
  const r1 = await gw.callTool('docs', 'search', { q: 'x' })
  assert.ok(r1.ok)
  assert.equal(seen.at(-1)!.opts, undefined)
  assert.equal((seen.at(-1)!.req.params as { _meta?: unknown })._meta, undefined)
  // 三态②：有 traceparent → send opts + params._meta 双载体同值（D-32）
  const tp = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
  await gw.callTool('docs', 'search', { q: 'x' }, { traceparent: tp })
  assert.equal(seen.at(-1)!.opts?.traceparent, tp)
  assert.equal((seen.at(-1)!.req.params as { _meta: { traceparent: string } })._meta.traceparent, tp)
  // 三态③：未知工具 → 显式错误结果（登记制）
  const r3 = await gw.callTool('docs', 'nope', {})
  assert.equal(r3.ok, false)
})

test('s47: MCP 蓝本——跨源同名冲突显式报错（CLI toolsMap 同构，禁静默覆盖）', async () => {
  const mk = (id: number) => fakeTransport(req => req.method === 'tools/list'
    ? { jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'deploy' }] } }
    : { jsonrpc: '2.0', id: req.id, result: {} })
  const a = mk(0), b = mk(1)
  const gwA = new seam.McpGateway(), gwB = new seam.McpGateway()
  const toolsMap = new Map<string, { run: (args: unknown) => Promise<unknown>; declaredSideEffect?: 'readonly' | 'write' }>()
  for (const [id, { transport }] of [['a', a], ['b', b]] as const) {
    const gw = id === 'a' ? gwA : gwB
    for (const t of await gw.register({ serverId: id, transport })) {
      const modelName = `mcp_${id}_${t.name}`
      if (toolsMap.has(modelName)) throw new Error(`CAR-E-MCP: 工具名冲突 ${modelName}（跨源同名禁静默覆盖）`)
      toolsMap.set(modelName, { run: async () => { throw new Error('unreachable') }, declaredSideEffect: t.declaredSideEffect ?? 'write' })
    }
  }
  // 不同 serverId 暴露同名工具 'deploy'：modelName 均为 mcp_a_deploy / mcp_b_deploy——serverId 前缀天然去重
  assert.equal(toolsMap.size, 2)
  // 同 serverId 重复注册 = 登记制显式报错（A050001 同源）
  await assert.rejects(() => gwA.register({ serverId: 'a', transport: a.transport }), /already registered/)
})

test('s47: MCP 蓝本——BD-02 崩溃隔离（错误结果 + 整体不可用，不抛异常不阻断主链路）', async () => {
  const gw = new seam.McpGateway()
  let n = 0
  const { transport } = fakeTransport(req => {
    if (req.method === 'tools/list') return toolsListResponse(req.id)
    n++
    throw new Error('worker crashed')
  })
  await gw.register({ serverId: 'flaky', transport })
  const r = await gw.callTool('flaky', 'search', { q: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error!, /BD-02/)
  assert.equal(n, 1, '首调到达传输层')
  const r2 = await gw.callTool('flaky', 'search', { q: 'x' })
  assert.equal(r2.ok, false)
  assert.match(r2.error!, /unavailable/)
  assert.equal(n, 1, '标记不可用后不再触达传输层（不传导进主链路）')
})

test('s47: 明文凭据红线——env/headers 双入口拒绝 + ${ENV} 展开 fail-visible（CR-05 随行为面走）', async () => {
  const gw = new seam.McpGateway()
  const { transport } = fakeTransport(req => toolsListResponse(req.id))
  await assert.rejects(
    () => gw.register({ serverId: 'leak', transport, env: { API_KEY: 'sk-1234' } }),
    /CAR-E-MCP.*plaintext credential/,
    'register env 明文拒绝（McpGateway 内建，平台无需直触检测函数）',
  )
  assert.throws(() => seam.resolveMcpHeaders({ 'X-Auth': 'sk-abc123' }), /CAR-E-MCP/, 'headers 明文拒绝（值整体呈凭据前缀形态）')
  assert.throws(
    () => seam.resolveMcpHeaders({ 'X-Auth': 'Bearer ${MISSING_VAR}' }, {}),
    /MISSING_VAR/,
    '${ENV} 缺变量 fail-visible（禁静默空值）',
  )
  const resolved = seam.resolveMcpHeaders({ 'X-Auth': 'Bearer ${T}' }, { T: 'tok' })
  assert.deepEqual(resolved, { 'X-Auth': 'Bearer tok' })
})

test('s47: PTC 蓝本——registry 快照 → SDK 块 → run_code 强制 write + worker 真执行 + ptcRelay 挂链', async () => {
  // CLI --ptc 段同构：toolsMap → registry 快照 → renderSdkFromRegistry → makePtcToolDefinition
  const toolsMap = new Map<string, { run: (args: unknown) => Promise<unknown>; description?: string; parameters?: unknown; declaredSideEffect: 'readonly' | 'write' }>([
    ['mcp_docs_search', { run: async (a) => `命中:${(a as { q: string }).q}`, description: '搜索文档', parameters: { type: 'object', properties: { q: { type: 'string' } } }, declaredSideEffect: 'readonly' }],
    ['lookup', { run: async () => 'ok', declaredSideEffect: 'write' }],
  ])
  const registry = new Map([...toolsMap].map(([name, t]) => [name, { run: t.run, description: t.description, inputSchema: t.parameters }]))
  const sdkBlock = seam.renderSdkFromRegistry(registry)
  assert.ok(sdkBlock.includes('mcp_docs_search') && sdkBlock.includes('lookup'), 'SDK 声明块含全部桥接工具')

  const audits: Array<Record<string, unknown>> = []
  // spanBridge 挂真 relay（CLI 同款：tracer.startTurn → turn.ptcRelay()；otel 关 = noop 面语义不变）
  const tracer = new seam.TurnTracer(seam.createTelemetryFacade(null))
  const turn = tracer.startTurn('T47')
  const ptc = seam.makePtcToolDefinition({ tools: registry, audit: d => audits.push(d), spanBridge: () => turn.ptcRelay() })
  assert.equal(ptc.name, 'run_code')
  assert.equal(ptc.declaredSideEffect, 'write', 'T-22：run_code 强制 write，授权门无旁路')
  assert.ok((ptc.parameters as { properties: { code: unknown; description: unknown } }).properties.code, 'run_code 入参 schema 进模型声明面')

  const result = await (ptc.run as (a: { code: string; description: string }) => Promise<unknown>)({
    code: 'const r = await tools.mcp_docs_search({ q: "weather" })\nreturn r',
    description: 's47 蓝本程序',
  })
  assert.equal(result, '命中:weather', 'worker 内经消息桥回调主线程工具（子调用过宿主权限门）')
  assert.ok(audits.some(a => a.kind === 'ptc-start'), '审计事件结构化（可落哈希链，s15 同口径）')
})

test('s47: 窄面反证——runCode/JsonRpc 层/trace 通道内部件不在 seam 面（D-36 负面清单）', async () => {
  const seamNs = seam as unknown as Record<string, unknown>
  for (const absent of [
    'runCode', 'PtcRequest', 'PtcResult', 'RunCodeOpts', 'PtcSpanBridge', // PTC 红线单点：runCode 直调面不出
    'JsonRpcRequest', 'JsonRpcResponse', 'ServerTransport', 'McpTransport', // JSON-RPC 编码层
    'rawPost', 'RawHttpResponse', 'parseTraceparent', 'formatTraceparent', 'containsPlaintextCredential', // trace/凭据内部件
  ]) {
    assert.equal(seamNs[absent], undefined, `负面清单符号不应出面: ${absent}`)
  }
  // 反向：正面清单在位（27 运行时符号由 s44 全量承载，此处抽 D-20 新增六符号）
  for (const present of ['McpGateway', 'createStdioClientTransport', 'createHttpMcpTransport', 'resolveMcpHeaders', 'makePtcToolDefinition', 'renderSdkFromRegistry']) {
    assert.notEqual(seamNs[present], undefined, `正面清单符号缺位: ${present}`)
  }
})

test('s47: 传输工厂构造面——stdio 即刻 spawn / http TLS 门（D-21 url 分流 + D-12a 同款）', () => {
  const stdio = seam.createStdioClientTransport({ command: process.execPath, args: ['--version'] })
  assert.equal(typeof stdio.send, 'function')
  assert.equal(typeof stdio.alive, 'function')
  assert.equal(typeof stdio.close, 'function')
  stdio.close()
  const http = seam.createHttpMcpTransport({ url: 'https://mcp.example.com/mcp' })
  assert.equal(typeof http.send, 'function')
  const loopback = seam.createHttpMcpTransport({ url: 'http://127.0.0.1:9999/mcp' })
  assert.equal(typeof loopback.send, 'function', 'http loopback 豁免（D-12a 同款口径）')
  assert.throws(() => seam.createHttpMcpTransport({ url: 'http://mcp.example.com/mcp' }), /CAR-E-LLM-TLS/, '非回环 http 拒绝（TLS 强制）')
})

test('s47: reload 面确认（D-37）——reloadEpoch 击穿 ESM 缓存 + invalidate 语义（自 1.10 可达，零加法）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's47-'))
  const file = join(dir, 'plugin.ts')
  writeFileSync(file, [
    '// s47 reload 探针：模块顶层副作用 = 重求值计数（erasable-only 合规）',
    'globalThis.__s47Reloads = ((globalThis.__s47Reloads as number | undefined) ?? 0) + 1',
    'export default (api: unknown) => { void api }',
    '',
  ].join('\n'))
  try {
    const manifest = { name: 's47', version: '1.0.0' }
    const p0 = await seam.mountPlugin({ file, manifest, reloadEpoch: 0 })
    assert.equal(globalThis.__s47Reloads, 1)
    const p1 = await seam.mountPlugin({ file, manifest, reloadEpoch: 1 })
    assert.equal(globalThis.__s47Reloads, 2, 'epoch+1 击穿模块缓存 → 重求值（热重载语义，D-23）')
    assert.equal(p1.isInvalidated(), false)
    p1.invalidate()
    assert.equal(p1.isInvalidated(), true, 'invalidate 语义（旧实例卸载标记）')
    void p0
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete (globalThis as { __s47Reloads?: number }).__s47Reloads
  }
})
