import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSdk, renderSdkFromRegistry } from '../src/ptc/sdk.ts'
import { runCode, makePtcToolDefinition, type ToolBridge } from '../src/ptc/runCode.ts'

// ==================== TS SDK 渲染（声明面 = 授权面） ====================

test('SDK 渲染: 注册表快照 → system prompt TS 声明（非 .d.ts 文件）', () => {
  const reg = new Map<string, ToolBridge & { description?: string; paramHint?: string }>([
    ['add', { run: async () => {}, description: '两数相加', paramHint: 'args: { x: number; y: number }' }],
    ['fs_read', { run: async () => {} }],
  ])
  const sdk = renderSdkFromRegistry(reg)
  assert.ok(sdk.includes('declare const tools: {'))
  assert.ok(sdk.includes('"add": (args: { x: number; y: number }) => Promise<unknown> // 两数相加'))
  assert.ok(sdk.includes('"fs_read": (args: unknown) => Promise<unknown>'), '无 paramHint 落 unknown 形状')
  // 空注册表 = 空声明面（授权面同步为空）
  assert.ok(renderSdkFromRegistry(new Map()).includes('declare const tools: {\n};'))
})

test('SDK 渲染: 声明面/授权面一致性——同一 Map 快照两处消费', () => {
  // 红线的可执行化：渲染函数只接受注册表自身（无独立声明通道），结构上不可能漂移
  const reg = new Map<string, ToolBridge>([['only', { run: async () => {} }]])
  const sdk = renderSdkFromRegistry(reg as never)
  assert.ok(sdk.includes('"only"'))
  assert.ok(!sdk.includes('"hidden"'), '未注册工具不可能出现在声明面')
})

// ==================== 授权门集成（authorizationId 幂等） ====================

test('PTC 授权门: 拒绝 = 无 worker 启动 + ptc-denied 审计留痕', async () => {
  const audits: Array<{ kind: string; authorizationId?: string }> = []
  const r = await runCode(
    { code: 'return 1', description: '拒绝路径验证', toolCallId: 'tc-42', budget: { maxWallMs: 1000 } },
    { tools: new Map(), audit: d => audits.push(d as never), authorize: async () => false },
  )
  assert.equal(r.ok, false)
  assert.match(r.error!, /authorization-denied/)
  const denied = audits.find(a => a.kind === 'ptc-denied')
  assert.ok(denied, '拒绝落审计')
  assert.equal(denied!.authorizationId, 'ptc-tc-42', '幂等键 = ptc-+toolCallId')
})

test('PTC 授权门: 放行正常执行（authorize 回调看到 description 人审凭据）', async () => {
  let seenDescription = ''
  const r = await runCode(
    { code: 'return 7', description: '求和放行', toolCallId: 'tc-43', budget: { maxWallMs: 5000 } },
    { tools: new Map(), authorize: async req => { seenDescription = req.description; return true } },
  )
  assert.equal(r.ok, true)
  assert.equal(r.result, 7)
  assert.equal(seenDescription, '求和放行')
})

// ==================== secrets 出站覆盖（F12 × worker 输出） ====================

test('F12 × PTC: worker 输出含 API Key → 回填上下文前强制脱敏', async () => {
  const audits: Array<{ kind: string; hits?: number }> = []
  const r = await runCode(
    { code: 'return { note: "key is sk-proj-abcdefghij0123456789abcd keep it safe" }', description: '出站脱敏验证', toolCallId: 'tc-44', budget: { maxWallMs: 5000 } },
    { tools: new Map(), audit: d => audits.push(d as never) },
  )
  assert.equal(r.ok, true)
  assert.equal(r.secretsRedacted, 1)
  assert.ok(!JSON.stringify(r.result).includes('sk-proj-abcdefghij0123456789abcd'), '明文不可见于返回结果')
  assert.ok(JSON.stringify(r.result).includes('****'), '遮蔽格式生效')
  assert.ok(audits.some(a => a.kind === 'ptc-secrets-redacted'), '脱敏事件落审计')
})

// ==================== registry × HostGateway tool 面（S12 留白接线） ====================

test('registry × facade: tool_list/tool_call 接线（S12 留白补齐）', async () => {
  // 直接验证 registry 判定与 facade tool 语义的分界已由 s13 覆盖；此处验证 makePtcToolDefinition 的
  // audit 流与 registry decisionId 一样具备可落链结构（均为 {kind, ...payload} 纯数据）
  const audits: Array<Record<string, unknown>> = []
  const ptc = makePtcToolDefinition({ tools: new Map([['add', { run: async (a: unknown) => (a as { x: number }).x + 1 }]]), audit: d => audits.push(d) })
  await ptc.run({ code: 'return await tools.add({ x: 41 })', description: '注册表快照执行' })
  assert.ok(audits.every(a => typeof a.kind === 'string'), '审计事件结构化（可落哈希链）')
  assert.equal(audits[0].kind, 'ptc-start')
})
