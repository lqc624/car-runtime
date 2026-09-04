import { test } from 'node:test'
import assert from 'node:assert/strict'
import { declareEvent, EventBus } from '../src/kernel/events.ts'
import { runTurn, type ModelStep, type ToolDef, type ToolCall } from '../src/loop/stop.ts'
import { SessionLog } from '../src/session/log.ts'
import { mountPlugin, parseManifest } from '../src/load/loader.ts'
import { writeFileSync, rmSync } from 'node:fs'

// ==================== F7 事件分发契约 ====================

test('F7: 未声明事件的订阅 = 启动期静态报错（US-7 AC2）', () => {
  const bus = new EventBus()
  assert.throws(() => bus.on('undeclared/event', () => {}), /undeclared event/)
})

test('F7: bail 模式——首断即止（短路是设计意图）', async () => {
  declareEvent('guard/check', 'bail')
  const bus = new EventBus()
  const calls: string[] = []
  bus.on('guard/check', () => { calls.push('h1'); return 'BLOCK' })
  bus.on('guard/check', () => { calls.push('h2'); return 'BLOCK2' })
  const r = await bus.dispatch('guard/check', {})
  assert.equal(r, 'BLOCK')
  assert.deepEqual(calls, ['h1'])
})

test('F7: serial 模式——有序检查点链式传值', async () => {
  declareEvent('ctx/enrich', 'serial')
  const bus = new EventBus()
  bus.on('ctx/enrich', (_p: unknown, next: () => string) => next() + '!A')
  bus.on('ctx/enrich', (_p: unknown, next: () => string) => next() + '!B')
  assert.equal(await bus.dispatch<string>('ctx/enrich', 'x', () => 'base'), 'base!A!B')
})

test('F7: waterfall 模式——环绕中间件（next() 前后均可介入）', async () => {
  declareEvent('tools/around', 'waterfall')
  const bus = new EventBus()
  const trace: string[] = []
  bus.on('tools/around', async (_p: unknown, next: () => Promise<string>) => {
    trace.push('before')
    const r = await next()
    trace.push('after')
    return r.toUpperCase()
  })
  bus.on('tools/around', () => Promise.resolve('raw'))
  const r = await bus.dispatch<string>('tools/around', {})
  assert.equal(r, 'RAW')
  assert.deepEqual(trace, ['before', 'after'])
})

test('F7: parallel 模式扇出聚合；emit 模式广播无返回', async () => {
  declareEvent('audit/fanout', 'parallel')
  declareEvent('lifecycle/notify', 'emit')
  const bus = new EventBus()
  bus.on('audit/fanout', (p: number) => p * 2)
  bus.on('audit/fanout', (p: number) => p * 3)
  assert.deepEqual(await bus.dispatch<number, number>('audit/fanout', 5), [10, 15])
  const seen: number[] = []
  bus.on('lifecycle/notify', () => { seen.push(1) })
  assert.equal(await bus.dispatch('lifecycle/notify', {}), undefined)
  assert.deepEqual(seen, [1])
})

test('F7: 契约重复声明且模式不一致 = 显式报错', () => {
  declareEvent('dup/e', 'serial')
  assert.throws(() => declareEvent('dup/e', 'bail'), /re-declared/)
})

// ==================== F5 停止语义（ADR-001） ====================

test('F5 AC1: 工具批次 → step null 续走，无异常', async () => {
  const log = new SessionLog()
  let n = 0
  const tools = new Map([['t', { declaredSideEffect: 'readonly', run: async () => 'ok' } as ToolDef]])
  const r = await runTurn({
    log, turnId: 'T', tools,
    model: async (): Promise<ModelStep> => n++ === 0
      ? { stopReason: 'toolUse', toolCalls: [{ id: 'c1', tool: 't', args: {} }] }
      : { stopReason: 'stop', text: 'done' },
  })
  assert.equal(r.reason, 'completed')
  const kinds = log.events.map(e => e.kind)
  assert.ok(kinds.includes('toolCall') && kinds.includes('toolResult'))
})

test('F5 AC2: step1 max-tokens + steering 续跑 → turn/end 保留 max-tokens（不被冲销）', async () => {
  const log = new SessionLog()
  let n = 0
  const r = await runTurn({
    log, turnId: 'T',
    model: async (): Promise<ModelStep> => n++ === 0 ? { stopReason: 'length' } : { stopReason: 'stop', text: 'recovered' },
  })
  assert.equal(r.reason, 'max-tokens')
  const end = log.events.find(e => e.kind === 'turnEnd') as any
  assert.equal(end.meta.reason, 'max-tokens')
})

test('F5 AC3: 截断响应含写工具 → 解析前收口（无副作用落地）', async () => {
  const log = new SessionLog()
  let executed = false
  const tools = new Map([['writeFile', { declaredSideEffect: 'write', run: async () => { executed = true } } as ToolDef]])
  const r = await runTurn({
    log, turnId: 'T', tools,
    model: async (): Promise<ModelStep> => ({ stopReason: 'length', truncatedTools: [{ id: 'c1', tool: 'writeFile' }] }),
  })
  assert.equal(r.reason, 'max-tokens')
  assert.equal(executed, false)
})

test('F5 AC4: 只读白名单 + retryReadOnly → 补错重试（Pi 式）', async () => {
  const log = new SessionLog()
  let n = 0
  const tools = new Map([['search', { declaredSideEffect: 'readonly', run: async () => 'results' } as ToolDef]])
  const r = await runTurn({
    log, turnId: 'T', tools,
    preset: { maxTokensRetryReadOnly: true },
    model: async (): Promise<ModelStep> => {
      if (n++ === 0) return { stopReason: 'length', truncatedTools: [{ id: 'c1', tool: 'search' }] }
      return { stopReason: 'stop', text: 'done' }
    },
  })
  // I4 一致性：即便只读重试续走，turn/end 仍保留 max-tokens（与 AC2 同语义）
  assert.equal(r.reason, 'max-tokens')
  assert.equal(r.steps, 2, '重试后续走了一个 step')
  const err = log.events.find(e => e.kind === 'toolResult' && JSON.stringify((e.payload as any)?.error || '').includes('truncated'))
  assert.ok(err, '只读工具收到截断错误结果')
})

test('F5: 取消 → 未派发调用补记成对事件，reason=aborted（日志无缺口）', async () => {
  const log = new SessionLog()
  const signal = { aborted: false }
  let i = 0
  const tools = new Map([['t1', { declaredSideEffect: 'readonly', run: async () => { if (++i === 1) signal.aborted = true; return 'x' } } as ToolDef]])
  const r = await runTurn({
    log, turnId: 'T', tools, signal,
    model: async (): Promise<ModelStep> => ({ stopReason: 'toolUse', toolCalls: [
      { id: 'c1', tool: 't1', args: {} }, { id: 'c2', tool: 't1', args: {} },
    ] }),
  })
  assert.equal(r.reason, 'aborted')
  // 日志无缺口：c2 的 toolCall 与合成错误 toolResult 成对存在
  const c2call = log.events.some(e => e.kind === 'toolCall' && (e.payload as any).id === 'c2')
  const c2result = log.events.some(e => e.kind === 'toolResult' && (e.payload as any).id === 'c2' && (e.payload as any).error === 'aborted-before-dispatch')
  assert.ok(c2call && c2result, '未派发调用补记成对事件')
})

test('F5: concludesTurn=OR——任一工具收口即 completed', async () => {
  const log = new SessionLog()
  const tools = new Map([
    ['commit', { declaredSideEffect: 'write', concludesTurn: true, run: async () => 'committed' } as ToolDef],
    ['probe', { declaredSideEffect: 'readonly', run: async () => 'p' } as ToolDef],
  ])
  const r = await runTurn({
    log, turnId: 'T', tools, preset: { mode: 'full' },
    model: async (): Promise<ModelStep> => ({ stopReason: 'toolUse', toolCalls: [
      { id: 'c1', tool: 'probe', args: {} }, { id: 'c2', tool: 'commit', args: {} },
    ] }),
  })
  assert.equal(r.reason, 'completed')
})

test('F5: terminate=AND——整批全部 terminate 才 aborted；权限门拒绝写操作', async () => {
  const log = new SessionLog()
  const tools = new Map([
    ['danger', { declaredSideEffect: 'write', terminate: true, run: async () => 'never' } as ToolDef],
  ])
  let authorizeCalled = false
  let n = 0
  const r = await runTurn({
    log, turnId: 'T', tools,
    preset: { mode: 'confirm', authorize: async () => { authorizeCalled = true; return false } },
    model: async (): Promise<ModelStep> => n++ === 0
      ? { stopReason: 'toolUse', toolCalls: [{ id: 'c1', tool: 'danger', args: {} }] }
      : { stopReason: 'stop', text: 'acknowledged' },
  })
  assert.equal(r.reason, 'completed') // 单工具被拒后无收口信号 → 模型继续 → stop
  assert.equal(authorizeCalled, true)
  const denied = log.events.some(e => e.kind === 'toolResult' && (e.payload as any)?.error === 'authorization-denied')
  assert.ok(denied, '拒绝记录落日志')
})

// ==================== F6 装配层（Stub/invalidate/manifest） ====================

test('F6: manifest 校验——version 非精确 semver = 冲突链报错', () => {
  assert.throws(() => parseManifest({ name: 'p', version: '^1.0.0' }, 'plugin.ts'), /exact semver.*plugin\.ts/)
  assert.throws(() => parseManifest({ version: '1.0.0' }, 'plugin.ts'), /"name" is required/)
  assert.throws(() => parseManifest({ name: 'p', version: '1.0.0', peerPolicyOverride: { relaxed: true } as any }, 'm.ts'), /reason.*required/)
  const ok = parseManifest({ name: 'p', version: '1.0.0' }, 'm.ts')
  assert.equal(ok.name, 'p')
})

test('F6: Stub 占位——bindCore 前调用显式抛错，bind 后可用；invalidate 后再访问报错', async () => {
  const file = new URL('./fixture-plugin.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  writeFileSync(file, `export default function apply(api) {\n  api.registerTool({ name: 'tool-v1', run: async () => 'v1' })\n}\n`)
  try {
    const p = await mountPlugin({ file, manifest: { name: 'hot', version: '1.0.0' } })
    // 注册类动作 Stub 期可用（收集待注册项）；能力查询 bind 前显式抛错
    assert.throws(() => p.api.getRegisteredTools(), /CAR-STUB/)
    const hostTools: Array<{ name: string }> = []
    p.bindCore({
      registerTool: (t) => { hostTools.push(t) },
      getRegisteredTools: () => hostTools,
    })
    // bind 后冲刷 pending 注册
    assert.deepEqual(p.api.getRegisteredTools().map((t) => t.name), ['tool-v1'])
    assert.deepEqual(hostTools.map((t) => t.name), ['tool-v1'])
    p.invalidate()
    assert.throws(() => p.api.getRegisteredTools(), /CAR-INVALIDATED/)
  } finally { try { rmSync(file, { force: true }) } catch {} }
})

test('F6: 热重载——同文件 epoch 击穿缓存，新代码生效 + 旧句柄失效', async () => {
  const file = new URL('./fixture-reload.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  let p1: Awaited<ReturnType<typeof mountPlugin>> | undefined
  try {
    writeFileSync(file, `export default function apply(api) { api.registerTool({ name: 'tool-v1', run: async () => 1 }) }\n`)
    p1 = await mountPlugin({ file, manifest: { name: 'r', version: '1.0.0' } })
    p1.bindCore({
      registerTool(t: { name: string }) {},
      getRegisteredTools: () => [{ name: 'tool-v1' }],
    })
    assert.deepEqual(p1.api.getRegisteredTools(), [{ name: 'tool-v1' }])
    // 重写源文件 → epoch+1 重载
    writeFileSync(file, `export default function apply(api) { api.registerTool({ name: 'tool-v2', run: async () => 2 }) }\n`)
    const p2 = await mountPlugin({ file, manifest: { name: 'r', version: '1.0.1' }, reloadEpoch: 1 })
    p2.bindCore({
      registerTool(t: { name: string }) {},
      getRegisteredTools: () => [{ name: 'tool-v2' }],
    })
    assert.deepEqual(p2.api.getRegisteredTools(), [{ name: 'tool-v2' }])
    p1.invalidate()
    assert.throws(() => p1!.api.getRegisteredTools(), /CAR-INVALIDATED/)
  } finally {
    try { rmSync(file, { force: true }) } catch {}
    void p1
  }
})

test('F6: 非工厂默认导出 = 冲突链报错', async () => {
  const file = new URL('./fixture-bad.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  writeFileSync(file, `export default 42\n`)
  try {
    await assert.rejects(() => mountPlugin({ file, manifest: { name: 'b', version: '1.0.0' } }), /default-export a factory/)
  } finally { try { rmSync(file, { force: true }) } catch {} }
})
