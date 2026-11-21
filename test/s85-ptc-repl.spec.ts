/**
 * s85 · 1.27.0 Q-D1 第二步——PTC 子链与 REPL（D-QD1-1~8，《内核1.27-Q-D1第二步-PTC子链与REPL-迭代规划.md》）
 *
 * 覆盖：
 *  - 绑定复制（D-QD1-4 acorn）：跨调用 const 续写 / 对象引用变异持久 / 重赋值提取 / 失败回退
 *    （replaced 表——部分执行重赋值不污染）/ const 二次声明零 SyntaxError / erasable TS 剥离
 *  - inspect-only（D-QD1-3 仅 REPL）：打印流收集 + 末表达式丢弃 + output-limit 截断保留前缀
 *  - 生命周期（D-QD1-8）：release 后调用拒 / 并发 busy 拒（concurrency-guard kind）/ tools 桥真调用
 *  - PtcFailureKind 六产出点（D-QD1-6）：authorization-denied / concurrency-guard / budget-exceeded /
 *    worker-error / worker-exit / output-limit——逐类断言
 *  - 回归：fresh run_code 面零变化（成功 result 不带 kind——字节兼容）+ makePtcToolDefinition 不动
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPtcRepl, PTC_FAILURE_KINDS, type PtcReplHandle } from '../src/seam.ts'
import { runCode, makePtcToolDefinition } from '../src/ptc/runCode.ts'

function echoBridge(): Map<string, { run: (args: unknown) => Promise<unknown> }> {
  return new Map([['echo', { run: async (args: unknown) => ({ echoed: args }) }]])
}

async function replRun(h: PtcReplHandle, code: string, description = '测试程序', extra?: { authorize?: (r: { code: string }) => Promise<boolean>; budget?: { maxWallMs?: number; maxPrintedBytes?: number } }): Promise<Awaited<ReturnType<PtcReplHandle['run']>>> {
  return h.run({ code, description, budget: extra?.budget })
}

test('S85-1 绑定复制：跨调用 const 续写 + 对象引用变异持久 + 重赋值提取', async () => {
  const h = createPtcRepl({ tools: echoBridge() })
  try {
    const r1 = await replRun(h, 'const base = 41\nconsole.log("call1:", base)')
    assert.equal(r1.ok, true)
    assert.ok(r1.printed!.includes('call1: 41'))
    assert.deepEqual(r1.bindings, ['base'])
    // 跨调用续写：引用 base（const 二次声明不炸——let 语义注入）+ 重赋值提取
    const r2 = await replRun(h, 'const doubled = base * 2\nbase = base + 1\nconsole.log("call2:", doubled)')
    assert.equal(r2.ok, true)
    assert.ok(r2.printed!.includes('call2: 82'))
    assert.ok(r2.bindings!.includes('doubled'))
    // 对象引用变异持久（引用变异自然持久）
    const r3 = await replRun(h, 'const o = { n: 1 }\no.n = 7')
    assert.equal(r3.ok, true)
    const r4 = await replRun(h, 'console.log("o.n =", o.n, "base =", base)')
    assert.ok(r4.printed!.includes('o.n = 7'), '对象引用变异跨调用持久')
    assert.ok(r4.printed!.includes('base = 42'), '重赋值经 getter 回写（base 41→42）')
  } finally {
    h.release()
  }
})

test('S85-2 失败回退：部分执行重赋值不污染（replaced 表）+ 存活绑定保留', async () => {
  const h = createPtcRepl({ tools: echoBridge() })
  try {
    await replRun(h, 'const k = 1')
    const r = await replRun(h, 'k = 99\nconsole.log("mid")\nthrow new Error("boom")')
    assert.equal(r.ok, false)
    assert.match(r.error!, /boom/)
    assert.ok(r.note!.includes('回退'), '失败语义如实标注（注入绑定回退快照）')
    const r2 = await replRun(h, 'console.log("k =", k)')
    assert.ok(r2.printed!.includes('k = 1'), '重赋值回退（k 仍 = 1——部分执行不污染）')
  } finally {
    h.release()
  }
})

test('S85-3 inspect-only：末表达式丢弃 + printed 收集 + output-limit 截断保留前缀', async () => {
  const h = createPtcRepl({ tools: echoBridge() })
  try {
    const r = await replRun(h, 'const hidden = "不应出现在结果面"\nconsole.log("visible line")\nhidden')
    assert.equal(r.ok, true)
    assert.equal(r.discarded, true, '末表达式丢弃显式标注（inspect-only）')
    assert.ok(r.printed!.includes('visible line'))
    assert.ok(!String(r.printed).includes('不应出现'), '末表达式不进结果面')
    // output-limit：小预算注入 → truncated + 前缀保留 + kind 标注
    const r2 = await replRun(h, 'console.log("x".repeat(200))', '测试程序', { budget: { maxPrintedBytes: 50 } })
    assert.equal(r2.ok, true, '打印截断非程序失败（ok 保持）')
    assert.equal(r2.printedTruncated, true, 'truncated 显式标注（绝不静默）')
    assert.equal(r2.kind, 'output-limit', 'output-limit kind 标注面（ok=true 时作标注）')
    assert.ok(r2.printed!.length < 200, '保留可容纳前缀')
    assert.ok(r2.printed!.startsWith('xxx'), '前缀保留（从头开始）')
  } finally {
    h.release()
  }
})

test('S85-4 生命周期：release 后调用拒 + 并发 busy 拒（concurrency-guard）+ tools 桥真调用', async () => {
  const h = createPtcRepl({ tools: echoBridge() })
  // tools 桥真调用（REPL 内 await tools.echo）
  const r0 = await replRun(h, 'const v = await tools.echo({ n: 5 })\nconsole.log("echoed", v.echoed.n)')
  assert.equal(r0.ok, true)
  assert.ok(r0.printed!.includes('echoed 5'))
  // 并发 busy：慢调用（真桥内延迟）在途 → 第二 run 拒
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((r) => { releaseGate = r })
  const slow = new Map([['echo', { run: async (args: unknown) => { await gate; return { echoed: args } } }]])
  const slowRepl = createPtcRepl({ tools: slow })
  const p1 = slowRepl.run({ code: 'await tools.echo({})', description: '慢调用' })
  await new Promise((r) => setTimeout(r, 30))
  const busyRes = await slowRepl.run({ code: 'console.log(1)', description: '并发第二调' })
  assert.equal(busyRes.ok, false)
  assert.equal(busyRes.kind, 'concurrency-guard', '并发 busy = concurrency-guard kind')
  releaseGate()
  const r1 = await p1
  assert.equal(r1.ok, true)
  slowRepl.release()
  // release 后调用拒
  h.release()
  const rAfter = await replRun(h, 'console.log(1)')
  assert.equal(rAfter.ok, false)
  assert.match(rAfter.error!, /repl-released/)
  void h
})

test('S85-5 PtcFailureKind 六产出点：authorization-denied / budget-exceeded / worker-error / worker-exit', async () => {
  const kindsSeen = new Set<string>()
  // authorization-denied（宿主门拒绝——D-QD1-5）
  const hDenied = createPtcRepl({ tools: echoBridge(), authorize: async () => false })
  const rDeny = await replRun(hDenied, 'console.log(1)')
  assert.equal(rDeny.kind, 'authorization-denied')
  kindsSeen.add(rDeny.kind!)
  hDenied.release()
  // budget-exceeded（主侧 killer 强杀——REPL 状态丢失如实报告；桥挂起不 resolve——killer 才可达）
  const hangBridge = new Map([['echo', { run: (args: unknown) => new Promise(() => { /* 挂起——永不 resolve */ }) }]])
  const hBudget = createPtcRepl({ tools: hangBridge })
  const rBudget = await replRun(hBudget, 'await tools.echo({})', '测试', { budget: { maxWallMs: 60 } })
  assert.equal(rBudget.ok, false)
  assert.equal(rBudget.kind, 'budget-exceeded')
  assert.ok(/状态保留|状态已清/.test(rBudget.note!), '状态语义如实报告（worker 计时先到 = 状态保留 / 主侧强杀 = 状态已清——两路皆诚实，禁静默伪装续写）')
  kindsSeen.add(rBudget.kind!)
  hBudget.release()
  // worker-error（程序 throw——注入绑定回退语义）
  const hErr = createPtcRepl({ tools: echoBridge() })
  const rErr = await replRun(hErr, 'throw new Error("程序异常")')
  assert.equal(rErr.kind, 'worker-error')
  kindsSeen.add(rErr.kind!)
  hErr.release()
  // worker-exit（程序内 process.exit——exit 先于 done）
  const hExit = createPtcRepl({ tools: echoBridge() })
  const rExit = await replRun(hExit, 'process.exit(3)')
  assert.equal(rExit.kind, 'worker-exit')
  assert.ok(rExit.error!.includes('worker-exited'), 'exit 兜底口径')
  kindsSeen.add(rExit.kind!)
  hExit.release()
  // 注册表断言（分立两域 D-QD1-6——六类恰一）
  assert.deepEqual([...PTC_FAILURE_KINDS], ['authorization-denied', 'concurrency-guard', 'budget-exceeded', 'worker-error', 'worker-exit', 'output-limit'])
  for (const k of kindsSeen) assert.ok((PTC_FAILURE_KINDS as readonly string[]).includes(k))
})

test('S85-6 保留名 fail-visible + erasable TS 剥离（REPL）', async () => {
  const h = createPtcRepl({ tools: echoBridge() })
  try {
    // 保留名（环境注入面冲突——fail-visible）
    const r1 = await replRun(h, 'const __$extract = 1')
    assert.equal(r1.ok, false)
    assert.match(r1.error!, /保留名/)
    // erasable TS 剥离（类型注解不炸——strip 先于 acorn）
    const r2 = await replRun(h, 'const n: number = 3\nconsole.log("n:", n)')
    assert.equal(r2.ok, true)
    assert.ok(r2.printed!.includes('n: 3'))
  } finally {
    h.release()
  }
})

test('S85-7 fresh run_code 回归：成功 result 不带 kind（字节兼容）+ budget-exceeded kind 标注', async () => {
  const tools = echoBridge()
  // 成功：无 kind 键（1.26 前形态字节兼容）
  const ok = await runCode({ code: 'const v = await tools.echo({ a: 1 })\nreturn v', description: 'fresh 回归', toolCallId: 's85-fresh-1' }, { tools })
  assert.equal(ok.ok, true)
  assert.equal('kind' in ok, false, '成功 result 无 kind 键（字节兼容）')
  // worker-error（程序 throw）
  const err = await runCode({ code: 'throw new Error("x")', description: 'fresh throw', toolCallId: 's85-fresh-2' }, { tools })
  assert.equal(err.kind, 'worker-error')
  // worker-exit（程序内 process.exit——1.27 前该形态挂到 killer 601s，现在 exit 即收）
  const exit = await runCode({ code: 'process.exit(2)', description: 'fresh exit', toolCallId: 's85-fresh-3' }, { tools })
  assert.equal(exit.kind, 'worker-exit')
  // makePtcToolDefinition 形态不动（P-A 真桥回归锚）
  const def = makePtcToolDefinition({ tools })
  assert.equal(def.name, 'run_code')
  assert.equal(def.declaredSideEffect, 'write')
})
