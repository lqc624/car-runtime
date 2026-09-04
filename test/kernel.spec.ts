import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../src/kernel/context.ts'
import { SessionLog } from '../src/session/log.ts'

// ==================== 内核 F1/F9 + ADR-002 ====================

test('F1: inject 依赖推导——provider 未就绪时 PENDING，就绪后自动挂载', () => {
  const ctx = new Context()
  const order: string[] = []
  ctx.plugin({ name: 'consumer', inject: ['svc'], apply: (c) => { c.get('svc'); order.push('consumer') } })
  ctx.plugin({ name: 'provider', apply: (c) => { order.push('provider'); c.provide('svc', { v: 1 }) } })
  assert.deepEqual(order, ['provider', 'consumer']) // provider 先挂载；provide 同步解锁 consumer
})

test('F1: 缺依赖服务时 get 显式报错（禁静默）', () => {
  const ctx = new Context()
  // apply 同步异常在加载期（plugin() 调用点）显式抛出，调用方直接感知
  assert.throws(() => ctx.plugin({ name: 'bad', apply: (c) => c.get('nope') }), /not provided/)
  assert.throws(() => ctx.get('nope'), /not provided/)
})

test('F1: 重复 provide 同名服务 = 加载期硬报错 + 冲突链', () => {
  const ctx = new Context()
  ctx.provide('dup', 1, 'p1')
  assert.throws(() => ctx.provide('dup', 2, 'p2'), /already provided by "p1".*p2/)
})

test('F1: 重复注册同名插件 = 显式报错', () => {
  const ctx = new Context()
  ctx.plugin({ name: 'x', apply: () => {} })
  assert.throws(() => ctx.plugin({ name: 'x', apply: () => {} }), /already registered/)
})

test('F1: fiber 内 effect 注册逆序回卷（确定性）', async () => {
  const ctx = new Context()
  const marks: string[] = []
  ctx.plugin({
    name: 'p', apply: (c) => {
      for (const l of ['e1', 'e2', 'e3']) c.effect(() => async () => { marks.push(l + ':end') }, l)
    },
  })
  await ctx.disposeRuntime()
  assert.deepEqual(marks, ['e3:end', 'e2:end', 'e1:end'])
})

test('ADR-002 strict-topo：consumer 先于 provider 卸载（逐层排空）', async () => {
  const ctx = new Context()
  const events: string[] = []
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  ctx.plugin({ name: 'db', apply: (c) => c.effect(() => async () => { await sleep(30); events.push('db:end') }, 'db-teardown') })
  ctx.plugin({ name: 'cache', inject: ['dbConn'], apply: (c) => c.effect(() => async () => { await sleep(20); events.push('cache:end') }, 'cache-teardown') })
  ctx.plugin({ name: 'api', inject: ['dbConn', 'cacheConn'], apply: (c) => c.effect(() => async () => { events.push('api:end') }, 'api-teardown') })
  ctx.provide('dbConn', {}, 'db')
  ctx.provide('cacheConn', {}, 'cache')
  const report = await ctx.disposeRuntime({ order: 'strict-topo' })
  assert.deepEqual(events, ['api:end', 'cache:end', 'db:end']) // 消费者层先排空
  assert.deepEqual(report.order, ['api', 'cache', 'db'])
})

test('ADR-002 concurrent 模式：跨 fiber 并发（对照/降级模式可用）', async () => {
  const ctx = new Context()
  ctx.plugin({ name: 'a', apply: (c) => c.effect(() => async () => {}, 'a') })
  ctx.plugin({ name: 'b', apply: (c) => c.effect(() => async () => {}, 'b') })
  const report = await ctx.disposeRuntime({ order: 'concurrent' })
  assert.equal(report.unloaded.length, 2)
})

test('ADR-002: strict-topo 模式下 disposer 抛错被捕获进 DisposeReport（屏障不悬挂）', async () => {
  const ctx = new Context()
  ctx.plugin({ name: 'boom', apply: (c) => c.effect(() => () => { throw new Error('boom') }, 'boom') })
  ctx.plugin({ name: 'ok', apply: (c) => c.effect(() => () => {}, 'ok') })
  const report = await ctx.disposeRuntime()
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].plugin, 'boom')
  assert.equal(report.unloaded.length, 2)
})

test('F9: 依赖环 = 拓扑分层显式报错（加载期失败，不进入运行）', async () => {
  const ctx = new Context()
  // 通过互 inject 构造环（S1 骨架：环在 disposeRuntime 拓扑分层时暴露）
  ctx.plugin({ name: 'a', inject: ['bSvc'], apply: (c) => {} })
  ctx.plugin({ name: 'b', inject: ['aSvc'], apply: (c) => {} })
  ctx.provide('bSvc', 1, 'b')
  ctx.provide('aSvc', 1, 'a')
  await assert.rejects(() => ctx.disposeRuntime(), /dependency cycle/)
})

test('POC-2 约束：effect 绑定插件 fiber 作用域（不串到根）', async () => {
  const ctx = new Context()
  let disposed = 0
  ctx.plugin({ name: 'scoped', apply: (c) => c.effect(() => () => { disposed++ }, 't') })
  await ctx.disposeRuntime()
  assert.equal(disposed, 1)
})

// ==================== 会话日志 F2 / N1 ====================

test('F2: 哈希链篡改检出并定位序号', () => {
  const log = new SessionLog()
  log.append('user', 'user', 'T0', 'hi')
  log.append('model', 'assistant', 'T0', 'hello')
  log.append('runtime', 'turnEnd', 'T0', null, { reason: 'completed' })
  assert.equal(log.verifyChain(), null)
  ;(log.events as any)[1] = { ...(log.events as any)[1], payload: 'tampered' }
  assert.equal(log.verifyChain(), 1)
})

test('F2: deriveMessages 前缀投影（upTo 语义）', () => {
  const log = new SessionLog()
  log.append('user', 'user', 'T0', 'q1')
  const snapAt1 = log.deriveMessages(1)
  log.append('model', 'assistant', 'T0', 'a1')
  assert.deepEqual(log.deriveMessages(1), snapAt1)
  assert.equal(log.deriveMessages().length, 2)
})

test('N1: Model-visible means logged 断言（快照=前缀投影）', () => {
  const log = new SessionLog()
  log.append('user', 'user', 'T0', 'q')
  log.snapshotModelRequest()
  log.append('model', 'assistant', 'T0', 'a')
  log.append('plugin', 'toolResult', 'T0', 'r')
  const r = log.assertModelVisibleLogged()
  assert.equal(r.ok, true)
})

test('N1: 断言失败可检出（模拟日志被篡改后投影漂移）', () => {
  const log = new SessionLog()
  log.append('user', 'user', 'T0', 'q')
  log.snapshotModelRequest()
  // 模拟「模型看到了日志外的东西」：快照后直接改历史（绕过 append API 的场景以校验断言灵敏度）
  ;(log.events as any)[0] = { ...(log.events as any)[0], payload: 'mutated' }
  const r = log.assertModelVisibleLogged()
  assert.equal(r.ok, false)
})
