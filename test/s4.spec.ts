/**
 * S4 · 端到端串联（E2E）+ N2 基线实测 + Q-06 性能定标
 *
 * E2E 链路（对齐高层架构 §5.3 业务闭环五环节）：
 *   触发 → 装配加载（F9+F6）→ 沙箱内事件运行（F7+F4+F3 降级约束）→ 停止收口（F5/ADR-001）
 *   → 日志落盘（F2 哈希链）→ 审计回放（deriveMessages + verifyChain + 基础导出）
 * Q-06 定标：装配时延 / 分发时延 / 日志 1 万事件追加+回放+校验耗时
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../src/kernel/context.ts'
import { declareEvent, EventBus } from '../src/kernel/events.ts'
import { SessionLog, loadSessionLog } from '../src/session/log.ts'
import { runTurn } from '../src/loop/stop.ts'
import { mountPlugin } from '../src/load/loader.ts'
import { probeCapabilities, SandboxExecutor } from '../src/sandbox/sandbox.ts'
import { McpGateway, type McpTransport, type JsonRpcRequest, type JsonRpcResponse } from '../src/mcp/gateway.ts'
import { AuthzService } from '../src/authz/authz.ts'

const cleanup = (p: string) => { try { rmSync(p, { force: true, recursive: true }) } catch {} }

test('E2E：五环节全链路（装配→运行→收口→落盘→回放+MCP 桥接+授权留痕）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-e2e-'))
  try {
    // —— 触发：插件文件（免编译 TS）——
    const pluginFile = join(dir, 'demo-plugin.ts')
    writeFileSync(pluginFile, `export default function apply(api) {\n  api.registerTool({ name: 'e2e_tool', run: async (args) => 'e2e-' + args.tag })\n}\n`)
    const manifest = { name: 'demo', version: '1.0.0' }

    // —— 环节 1：装配加载（F9 两阶段 + F6 免编译 + F1 依赖推导）——
    const t0 = Date.now()
    const plugin = await mountPlugin({ file: pluginFile, manifest })
    const ctx = new Context()
    const log = new SessionLog('S-E2E')
    const authz = new AuthzService({ log, timeoutMs: 100 })
    declareEvent('tools/around', 'waterfall')
    const bus = new EventBus()
    let auditTrail = ''
    bus.on('tools/around', async (_p, next) => { const r = await next(); auditTrail = 'wrapped:' + r; return r })
  bus.on('tools/around', () => Promise.resolve('e2e-ok')) // 下游结果提供者
    const hostTools: any[] = []
    ctx.plugin({
      name: 'demo',
      apply: (c) => {
        // 插件文件工厂已在 mount 时经 Stub 收集注册；bindCore 冲刷进宿主（勿重复注册）
        plugin.bindCore({ registerTool: (t) => { hostTools.push(t); c.provide('tool:e2e_tool', t) } })
      },
    })
    const mountMs = Date.now() - t0
    assert.ok(hostTools.some(t => t.name === 'e2e_tool'), '装配：插件工具注册进能力矩阵')

    // —— 环节 2：事件运行（MCP 桥接同审批门 + waterfall 环绕 + 权限门）——
    const gw = new McpGateway()
    const rpc: McpTransport = {
      async send(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        if (req.method === 'tools/list') return { jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'py_tool', sideEffect: 'readonly' }] } }
        if (req.method === 'tools/call') return { jsonrpc: '2.0', id: req.id, result: { content: 'py-ok' } }
        throw new Error('unreachable')
      },
      alive: () => true, close() {},
    }
    await gw.register({ serverId: 'py1', transport: rpc })
    const mcpResult = await gw.callTool('py1', 'py_tool', {})
    assert.equal(mcpResult.ok, true)
    log.append('user', 'user', 'T0', 'run e2e')
    log.snapshotModelRequest()
    log.append('model', 'toolCall', 'T0', { id: 'm1', tool: 'py_tool', args: {} })
    log.append('plugin', 'toolResult', 'T0', { id: 'm1', result: mcpResult.result })
    // 权限门：write 类走 confirm（授权留痕）
    const decision = await authz.decideByUser(
      { authorizationId: 'A-E2E-1', actor: 'demo', capability: 'fs-write', resource: join(dir, 'out.txt') },
      async () => true,
    )
    assert.equal(decision.decision, 'APPROVED')

    // —— 环节 3：停止收口（F5/ADR-001）——
    const probe = await probeCapabilities()
    const sandbox = new SandboxExecutor({ probe, audit: () => {}, workspace: dir })
    assert.equal(sandbox.degraded, probe.degraded) // 执行器必须忠实反映探测结论：Windows/裸 CI 必降级，Linux+landlock-run 全执法
    const exec = await sandbox.exec({ argv: ['node', '-e', 'console.log("s")'], capabilities: ['exec'], mode: 'workspace-write', permissionMode: 'confirm', authorize: async () => true })
    assert.equal(exec.ok, true)
    const tools = new Map([['e2e_tool', { declaredSideEffect: 'write', run: hostTools.find(t => t.name === 'e2e_tool')!.run } as any]])
    let n = 0
    const turn = await runTurn({
      log, turnId: 'T0', tools, preset: { mode: 'full' },
      model: async (): Promise<any> => n++ === 0
        ? { stopReason: 'toolUse', toolCalls: [{ id: 'c1', tool: 'e2e_tool', args: { tag: 'ok' } }] }
        : { stopReason: 'stop', text: 'final' },
    })
    assert.equal(turn.reason, 'completed')
    // waterfall 环绕实证：分发 → before → next() → after → 结果可改写
    const wrapped = await bus.dispatch<string>('tools/around', {}, () => 'e2e-ok')
    assert.equal(wrapped, 'e2e-ok') // 下游结果透传；环绕 trail 已记录
    assert.deepEqual(auditTrail, 'wrapped:e2e-ok') // handler 侧记录 before/after 顺序

    // —— 环节 4：日志落盘（F2 哈希链 + N1 断言）——
    const jsonl = join(dir, 'session.jsonl')
    writeFileSync(jsonl, log.exportJSONL())
    assert.equal(log.assertModelVisibleLogged().ok, true)

    // —— 环节 5：审计回放（只读加载 + 断链校验 + 投影）——
    const { log: reloaded, brokenAt } = loadSessionLog(jsonl)
    assert.equal(brokenAt, null)
    const replayed = reloaded.deriveMessages()
    assert.ok(replayed.length >= 4)
    assert.deepEqual(replayed[0], { role: 'user', content: 'run e2e' })
    // 授权凭据链可回放（US6：谁在何时调用了什么、凭什么）
    assert.ok(reloaded.events.some(e => e.turnId === 'authz:A-E2E-1'))
    void mountMs
  } finally { cleanup(dir) }
})

test('N2: 首插件跑通耗时实测（目标 ≤300s，实际秒级）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-n2-'))
  try {
    const t0 = Date.now()
    const f = join(dir, 'first.ts')
    writeFileSync(f, `export default function apply(api) { api.registerTool({ name: 'first', run: async () => 42 }) }\n`)
    const p = await mountPlugin({ file: f, manifest: { name: 'first', version: '1.0.0' } })
    let got: unknown
    p.bindCore({ registerTool: async (t) => { got = await t.run({}) } })
    p.api.getRegisteredTools // 能力查询（bind 后可用）
    const ctx = new Context()
    ctx.plugin({ name: 'first', apply: (c) => c.effect(() => async () => {}, 'noop') })
    await ctx.disposeRuntime()
    const wall = Date.now() - t0
    assert.equal(got, 42)
    assert.ok(wall < 300_000, `实测 ${wall}ms`)
    console.log(`  [N2 实测] 首插件跑通 = ${wall}ms（含免编译加载+装配+执行+卸载）`)
  } finally { cleanup(dir) }
})

test('Q-06: 性能定标——装配 / 分发 / 日志 1 万事件', async () => {
  // 装配时延：20 插件依赖图
  const ctx = new Context()
  const t0 = Date.now()
  for (let i = 0; i < 20; i++) {
    ctx.plugin({ name: 'p' + i, apply: (c) => c.provide('svc' + i, { i }) })
  }
  for (let i = 0; i < 20; i++) {
    ctx.plugin({ name: 'c' + i, inject: ['svc' + i], apply: () => {} })
  }
  const mountMs = Date.now() - t0
  // 分发时延：serial 1000 次
  declareEvent('bench/e', 'serial')
  const bus = new EventBus()
  bus.on('bench/e', (_p: unknown, next: () => number) => next() + 1)
  const t1 = Date.now()
  for (let i = 0; i < 1000; i++) await bus.dispatch<number>('bench/e', i, () => i)
  const dispatchMs = Date.now() - t1
  // 日志：1 万事件 追加+哈希链+回放+校验
  const log = new SessionLog('S-BENCH')
  const t2 = Date.now()
  for (let i = 0; i < 10_000; i++) log.append('model', 'assistant', 'TB', 'x' + i)
  const appendMs = Date.now() - t2
  const t3 = Date.now()
  const replayed = log.deriveMessages()
  const chainOk = log.verifyChain() === null
  const replayMs = Date.now() - t3
  assert.equal(replayed.length, 10_000)
  assert.equal(chainOk, true)
  const row = { mountMs20Plugins: mountMs, dispatch1000SerialMs: dispatchMs, append10kMs: appendMs, replayAndVerify10kMs: replayMs }
  console.log('  [Q-06 定标]', JSON.stringify(row))
  // 保守上限断言（CI 波动容差）：装配 <2s、千次分发 <5s、万事件追加 <10s、回放校验 <10s
  assert.ok(mountMs < 2000 && dispatchMs < 5000 && appendMs < 10_000 && replayMs < 10_000)
})
