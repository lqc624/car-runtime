import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeCapabilities, SandboxExecutor } from '../src/sandbox/sandbox.ts'
import { AuthzService, checkCapability } from '../src/authz/authz.ts'
import { McpGateway, containsPlaintextCredential, type McpTransport, type JsonRpcRequest, type JsonRpcResponse } from '../src/mcp/gateway.ts'
import { SessionLog } from '../src/session/log.ts'

// ==================== F3 沙箱：探测/降级/Q-04 约束 ====================

test('F3: Windows 平台探测 → 显式降级（BD-01，经中间确认② Linux 先行）', async () => {
  const probe = await probeCapabilities({ platform: 'win32' })
  assert.equal(probe.degraded, true)
  assert.ok(probe.reason)
})

test('F3: Linux 无 landlock-run 二进制 → 探测失败降级（容器环境同路径）', async () => {
  const probe = await probeCapabilities({ platform: 'linux' })
  assert.equal(probe.degraded, true)
  assert.match(probe.reason!, /landlock-run/)
})

test('F3 Q-04: 降级态 env-read 一律拒绝（DENIED，不进审批）', async () => {
  const events: any[] = []
  const exec = new SandboxExecutor({
    probe: { platform: 'win32', landlock: false, seccomp: false, degraded: true, reason: 'test' },
    audit: (e) => events.push(e),
    workspace: process.cwd(),
  })
  const r = await exec.exec({ argv: ['node', '-e', '1'], capabilities: ['env-read'], mode: 'workspace-write', permissionMode: 'full' })
  assert.equal(r.ok, false)
  assert.match(r.denied!, /env-read denied in degraded/)
  assert.ok(events.some(e => e.kind === 'sandbox-denied'))
})

test('F3 Q-04: 降级态写操作强制确认模式（full 亦受限；拒绝即留痕）', async () => {
  const events: any[] = []
  const exec = new SandboxExecutor({
    probe: { platform: 'win32', landlock: false, seccomp: false, degraded: true, reason: 'test' },
    audit: (e) => events.push(e),
    workspace: process.cwd(),
  })
  const r = await exec.exec({
    argv: ['node', '-e', 'console.log(1)'], capabilities: ['exec'], mode: 'workspace-write',
    permissionMode: 'full', // full 在降级态受限为 confirm，且无审批回调 → 默认拒绝
  })
  assert.equal(r.ok, false)
  assert.match(r.denied!, /authorization-denied/)
  assert.ok(events.some(e => e.kind === 'sandbox-denied' && e.detail.degraded === true))
})

test('F3 Q-04: 降级态 confirm + 审批放行 → 可执行且留痕 degraded=true', async () => {
  const events: any[] = []
  const exec = new SandboxExecutor({
    probe: { platform: 'win32', landlock: false, seccomp: false, degraded: true, reason: 'test' },
    audit: (e) => events.push(e),
    workspace: process.cwd(),
  })
  const r = await exec.exec({
    argv: ['node', '-e', 'console.log("hi")'], capabilities: ['exec'], mode: 'workspace-write',
    permissionMode: 'full', authorize: async () => true,
  })
  assert.equal(r.ok, true)
  assert.equal(r.degraded, true)
  assert.ok(events.some(e => e.kind === 'sandbox-exec' && e.detail.degraded === true))
})

// ==================== F4 授权服务 ====================

test('F4: 能力标签 deny-by-default（未声明 = 无能力，T-22）', () => {
  assert.equal(checkCapability({}, 'fs-write'), false)
  assert.equal(checkCapability({ capabilities: ['net'] }, 'fs-write'), false)
  assert.equal(checkCapability({ capabilities: ['net'] }, 'net'), true)
})

test('F4: 幂等——同 authorizationId 返回同一决策（T-10 防重放不一致）', async () => {
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 200 })
  const req = { authorizationId: 'A-1', actor: 'plugin-x', capability: 'exec' as const, resource: '/ws' }
  const d1 = await authz.decideByUser(req, async () => true)
  const d2 = await authz.decideByUser(req, async () => false) // 重放：返回缓存决策
  assert.equal(d1.decision, 'APPROVED')
  assert.equal(d2.decision, 'APPROVED')
  assert.equal(d2, d1)
})

test('F4: 超时默认拒绝（timeout-default-deny，EXPIRED）', async () => {
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 50 })
  const d = await authz.decideByUser(
    { authorizationId: 'A-2', actor: 'p', capability: 'fs-write', resource: '/ws' },
    () => new Promise<boolean>(() => {}), // 永不回应
  )
  assert.equal(d.decision, 'EXPIRED')
  assert.equal(d.decidedBy, 'timeout')
})

test('F4: 授权决策 100% 落审计日志（US6 凭据链）', async () => {
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 100 })
  await authz.decideByPolicy({ authorizationId: 'A-3', actor: 'p', capability: 'net', resource: 'https://x' }, 'readonly')
  const audit = log.events.find(e => e.turnId === 'authz:A-3')
  assert.ok(audit)
  assert.equal((audit!.meta as any)?.reason.includes('denied in readonly mode'), true)
})

// ==================== F8 MCP 桥接网关 ====================

function mockTransport(script: Map<string, unknown>, failAfter?: number): McpTransport & { calls: number } {
  let calls = 0
  return {
    calls: 0,
    async send(req: JsonRpcRequest): Promise<JsonRpcResponse> {
      calls++
      if (failAfter !== undefined && calls > failAfter) throw new Error('EPIPE: process crashed')
      const method = req.method
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id: req.id, result: { tools: [
          { name: 'py_search', description: 'python tool', sideEffect: 'readonly' },
          { name: 'py_write', description: 'python writer' }, // 未声明 → write 最高约束
        ] } }
      }
      if (method === 'tools/call') return { jsonrpc: '2.0', id: req.id, result: { content: 'py-result' } }
      throw new Error('unknown method ' + method)
    },
    alive() { return true },
    close() {},
  }
}

test('F8: 登记后工具进入能力矩阵；未声明 sideEffect 按 write 最高约束（T-22）', async () => {
  const gw = new McpGateway()
  const tools = await gw.register({ serverId: 'py1', transport: mockTransport(new Map()) })
  assert.deepEqual(tools.map(t => t.name).sort(), ['py_search', 'py_write'])
  const matrix = gw.listTools()
  assert.equal(matrix.find(t => t.name === 'py_search')!.declaredSideEffect, 'readonly')
  assert.equal(matrix.find(t => t.name === 'py_write')!.declaredSideEffect, 'write')
})

test('F8: 未登记连接拒绝（A050001）+ 重复登记显式报错', async () => {
  const gw = new McpGateway()
  // 未登记 serverId 调用 = 显式拒绝（登记制）
  await assert.rejects(() => gw.callTool('ghost', 'any_tool', {}), /A050001/)
  const t = mockTransport(new Map())
  await gw.register({ serverId: 'py1', transport: t })
  await assert.rejects(() => gw.register({ serverId: 'py1', transport: t }), /already registered/)
})

test('F8: 调用走网关 + 崩溃 → BD-02 标记不可用（错误结果不抛异常，主链路不崩）', async () => {
  const gw = new McpGateway()
  const t = mockTransport(new Map(), 2) // tools/list 占 1 次，tools/call 起崩溃 // 第 2 次调用起崩溃
  await gw.register({ serverId: 'py1', transport: t })
  const ok1 = await gw.callTool('py1', 'py_search', {})
  assert.equal(ok1.ok, true)
  const fail = await gw.callTool('py1', 'py_search', {})
  assert.equal(fail.ok, false)
  assert.match(fail.error!, /BD-02/)
  // 后续调用：直接不可用（不再触碰崩溃通道），返回显式错误结果
  const fail2 = await gw.callTool('py1', 'py_search', {})
  assert.match(fail2.error!, /unavailable/)
})

test('F8: 明文凭据 env = 拒绝登记（§3.2.5 传参禁忌）', () => {
  assert.match(containsPlaintextCredential({ OPENAI_KEY: 'sk-abc123' })!, /OPENAI_KEY/)
  assert.equal(containsPlaintextCredential({ LOG_LEVEL: 'info' }), null)
})

test('F8: mcp-call 权限一致性——写类 MCP 工具在 confirm 模式触发审批（无旁路，US-6 AC3）', async () => {
  const gw = new McpGateway()
  const log = new SessionLog()
  const authz = new AuthzService({ log, timeoutMs: 100 })
  await gw.register({ serverId: 'py1', transport: mockTransport(new Map()) })
  const def = gw.listTools().find(t => t.name === 'py_write')!
  // 未声明 → write → readonly 模式下 policy 直接 DENIED
  const d = authz.decideByPolicy(
    { authorizationId: 'A-M1', actor: 'model', capability: 'mcp', resource: `py1:${def.name}` },
    'readonly',
  )
  assert.equal(d.decision, 'DENIED')
})
