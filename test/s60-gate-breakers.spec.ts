/**
 * 1.17-K4 · 闸门熔断 G8/G9 + 档位矩阵 G10（S60）：D-50（V2-a / V3 = 3/2）
 *
 * 覆盖（设计 §5.4 / §7 AC-5/6）：
 *  - G8 拒绝累计熔断：confirm 下同 turn denies 累计 ≥3 → blocked + meta.gate='denyBreaker'
 *    （denies turn 级跨 batch 累计）；未到阈值继续跑完；显式 0 = 关。
 *  - V2-a：blockOnDeny 缺省随档位——readonly 单次拒绝立即收口（F13 产出点，无 gate 键）；
 *    显式 blockOnDeny=false 可覆盖；显式 true 在 confirm 下同 F13 语义不漂移。
 *  - G9 重复失败熔断（缺省 2）：同签名连击后第 3 次同工具不再派发（run 调用数 = 2），
 *    no-dispatch 成对落链（error='repeated-identical-failure: breaker tripped (no dispatch)'）
 *    + blocked + gate='repeatFailureBreaker' + signature；时间戳/长 hex 归一后仍同签名；
 *    异签名放行（探索合法）；成功派发重置连击；unknown tool 同为失败面。
 *  - G10 矩阵单一事实表：readonly/confirm/full × readonly 类/write 类 × 被拒后 × 收口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTurn, type ModelStep, type ToolDef } from '../src/loop/stop.ts'
import { SessionLog } from '../src/session/log.ts'

const writeTool = (run?: ToolDef['run']): ToolDef =>
  ({ declaredSideEffect: 'write', run: run ?? (async () => 'wrote') })
const readTool = (run?: ToolDef['run']): ToolDef =>
  ({ declaredSideEffect: 'readonly', run: run ?? (async () => 'read-ok') })

/** 模型脚本：按序吐 toolUse 批（每批一调用），脚本尽 = stop */
function scripted(steps: Array<{ tool: string } | { text: string }>) {
  let i = 0
  return async (): Promise<ModelStep> => {
    const s = steps[i++] ?? { text: 'done' }
    if ('tool' in s) return { stopReason: 'toolUse', toolCalls: [{ id: 'c' + i, tool: s.tool, args: {} }] }
    return { stopReason: 'stop', text: s.text }
  }
}

const turnEndMeta = (log: SessionLog): Record<string, unknown> =>
  (log.events.find(e => e.kind === 'turnEnd') as unknown as { meta: Record<string, unknown> }).meta

// ==================== G8：拒绝累计熔断 ====================

test('S60/G8: confirm 下 denies 累计 ≥3 → blocked + gate=denyBreaker（跨 batch 累计）', async () => {
  const log = new SessionLog()
  const r = await runTurn({
    log, turnId: 'T', tools: new Map([['w', writeTool()]]),
    model: scripted([{ tool: 'w' }, { tool: 'w' }, { tool: 'w' }, { tool: 'w' }, { text: 'end' }]),
    preset: { mode: 'confirm' }, // authorize 缺省 = 全拒；blockOnDeny 缺省 false（confirm）
  })
  assert.equal(r.reason, 'blocked', '第 3 次拒绝后 G8 熔断（第 4 批不再发出）')
  assert.equal(r.steps, 3)
  const meta = turnEndMeta(log)
  assert.equal(meta['reason'], 'blocked')
  assert.equal(meta['denies'], 3, 'denies = turn 级累计（跨 3 批各 1）')
  assert.equal(meta['gate'], 'denyBreaker')
})

test('S60/G8: 阈值未到继续跑完（denyBreaker=5）+ 显式 0 = 关', async () => {
  for (const denyBreaker of [5, 0]) {
    const log = new SessionLog()
    const r = await runTurn({
      log, turnId: 'T', tools: new Map([['w', writeTool()]]),
      model: scripted([{ tool: 'w' }, { tool: 'w' }, { tool: 'w' }, { text: 'end' }]),
      preset: { mode: 'confirm', denyBreaker },
    })
    assert.equal(r.reason, 'completed', `denyBreaker=${denyBreaker} = 不熔断（3 次拒绝未达/关闭）`)
    assert.equal(turnEndMeta(log)['gate'], undefined, '无 gate 键')
  }
})

// ==================== V2-a：blockOnDeny 缺省随档位 ====================

test('S60/V2a: readonly 单次拒绝立即收口（F13 产出点无 gate）；显式 false 覆盖走 G8；显式 true 语义不漂移', async () => {
  // readonly 缺省：单拒即收口
  let log = new SessionLog()
  let r = await runTurn({
    log, turnId: 'T', tools: new Map([['w', writeTool()]]),
    model: scripted([{ tool: 'w' }, { tool: 'w' }, { text: 'end' }]),
    preset: { mode: 'readonly' },
  })
  assert.equal(r.reason, 'blocked', 'readonly 拒绝即收口（V2-a 缺省）')
  assert.equal(r.steps, 1)
  assert.equal(turnEndMeta(log)['denies'], 1)
  assert.equal(turnEndMeta(log)['gate'], undefined, 'F13 产出点不带 gate（既有事件形态不漂移）')
  // 显式 false 覆盖：走 G8 累计路径（3 次熔断）
  log = new SessionLog()
  r = await runTurn({
    log, turnId: 'T', tools: new Map([['w', writeTool()]]),
    model: scripted([{ tool: 'w' }, { tool: 'w' }, { tool: 'w' }, { text: 'end' }]),
    preset: { mode: 'readonly', blockOnDeny: false },
  })
  assert.equal(r.reason, 'blocked')
  assert.equal(turnEndMeta(log)['gate'], 'denyBreaker', '显式 false 覆盖后由 G8 兜底')
  // confirm + 显式 true：F13 单次收口语义保持
  log = new SessionLog()
  r = await runTurn({
    log, turnId: 'T', tools: new Map([['w', writeTool()]]),
    model: scripted([{ tool: 'w' }, { text: 'end' }]),
    preset: { mode: 'confirm', blockOnDeny: true },
  })
  assert.equal(r.reason, 'blocked')
  assert.equal(turnEndMeta(log)['denies'], 1, 'G6 单次拒绝即收口（显式 true 不漂移）')
})

// ==================== G9：重复失败熔断 ====================

test('S60/G9: 同签名连击 2 后第 3 次同工具不派发 + no-dispatch 成对落链 + blocked（时间戳归一）', async () => {
  const log = new SessionLog()
  let calls = 0
  const boom = (): never => {
    calls++
    // 时间戳逐次不同——归一化后签名必须相同（去 <ts> 面）
    throw new Error(`boom at 2026-10-24T10:00:00.00${calls}Z ref=deadbeefdeadbeef`)
  }
  const r = await runTurn({
    log, turnId: 'T', tools: new Map([['f', readTool(boom)]]),
    model: scripted([{ tool: 'f' }, { tool: 'f' }, { tool: 'f' }, { text: 'end' }]),
    // 缺省 repeatFailureBreaker=2：派发 2 次失败（连击 2），第 3 次预检拦截
  })
  assert.equal(r.reason, 'blocked')
  assert.equal(calls, 2, '第 3 次不再派发（run 调用数 = 2）')
  const toolCalls = log.events.filter(e => e.kind === 'toolCall')
  const toolResults = log.events.filter(e => e.kind === 'toolResult')
  assert.equal(toolCalls.length, 3, '3 次 toolCall 全落链')
  assert.equal(toolResults.length, 3, '3 次 toolResult 成对无缺口（含 no-dispatch 补记）')
  const third = toolResults[2] as unknown as { payload: { id: string; error: string; signature: string } }
  assert.equal(third.payload.error, 'repeated-identical-failure: breaker tripped (no dispatch)')
  assert.ok(third.payload.signature.startsWith('f:Error: boom at <ts>'), '签名带归一化错误串（<ts>/<id> 已替换）')
  assert.equal(third.payload.id, toolCalls[2]!.payload.id, 'no-dispatch toolResult 与 toolCall 成对（id 一致）')
  const meta = turnEndMeta(log)
  assert.equal(meta['gate'], 'repeatFailureBreaker')
  assert.ok(String(meta['signature']).startsWith('f:Error: boom at <ts>'), 'turnEnd 携签名供事后判定（误伤审计面）')
})

test('S60/G9: 异签名放行（探索合法）+ 成功派发重置连击', async () => {
  const log = new SessionLog()
  let i = 0
  const alternating = readTool(async () => {
    if (++i % 2 === 1) throw new Error(`err-kind-${Math.ceil(i / 2) % 2 === 1 ? 'A' : 'B'}`)
    return 'ok'
  })
  const r = await runTurn({
    log, turnId: 'T', tools: new Map([['f', alternating]]),
    model: scripted([{ tool: 'f' }, { tool: 'f' }, { tool: 'f' }, { tool: 'f' }, { text: 'end' }]),
  })
  assert.equal(r.reason, 'completed', '失败(A)/成功/失败(B)/成功——连击恒 1，不熔断')
  assert.equal(i, 4, '全部派发（无拦截）')
})

test('S60/G9: unknown tool 同为失败面——第 3 次叫错工具名被拦', async () => {
  const log = new SessionLog()
  const r = await runTurn({
    log, turnId: 'T', tools: new Map(),
    model: scripted([{ tool: 'nope' }, { tool: 'nope' }, { tool: 'nope' }, { text: 'end' }]),
  })
  assert.equal(r.reason, 'blocked')
  const results = log.events.filter(e => e.kind === 'toolResult') as unknown as Array<{ payload: { error?: string } }>
  assert.equal(results.length, 3)
  assert.equal(results[2]!.payload.error, 'repeated-identical-failure: breaker tripped (no dispatch)')
  assert.equal(turnEndMeta(log)['gate'], 'repeatFailureBreaker')
})

// ==================== G10：档位矩阵单一事实表 ====================

test('S60/G10: 矩阵——readonly(写)拒+立即收口 / readonly(读)放行 / confirm(写)人审拒→交回(G8 兜底) / full(写)放行', async () => {
  // readonly × write：拒 + 立即收口（单次）
  let log = new SessionLog()
  let executed = false
  let r = await runTurn({
    log, turnId: 'T', tools: new Map([['w', writeTool(async () => { executed = true })]]),
    model: scripted([{ tool: 'w' }, { text: 'end' }]),
    preset: { mode: 'readonly' },
  })
  assert.equal(r.reason, 'blocked')
  assert.equal(executed, false, 'readonly 写类零执行')
  assert.equal(r.steps, 1, '单次收口（不在错误路上烧 token）')

  // readonly × readonly 类：放行
  log = new SessionLog()
  executed = false
  r = await runTurn({
    log, turnId: 'T', tools: new Map([['rr', readTool(async () => { executed = true })]]),
    model: scripted([{ tool: 'rr' }, { text: 'end' }]),
    preset: { mode: 'readonly' },
  })
  assert.equal(r.reason, 'completed')
  assert.equal(executed, true, 'readonly 只读类照常放行')

  // confirm × write 人审拒：交回模型 → G8 累计 3 次兜底收口
  log = new SessionLog()
  executed = false
  r = await runTurn({
    log, turnId: 'T', tools: new Map([['w', writeTool(async () => { executed = true })]]),
    model: scripted([{ tool: 'w' }, { tool: 'w' }, { tool: 'w' }, { text: 'end' }]),
    preset: { mode: 'confirm', authorize: async () => false },
  })
  assert.equal(r.reason, 'blocked')
  assert.equal(turnEndMeta(log)['gate'], 'denyBreaker', 'confirm 拒绝交回模型，累计 3 次熔断')
  assert.equal(executed, false)

  // full × write：整体旁路放行
  log = new SessionLog()
  executed = false
  r = await runTurn({
    log, turnId: 'T', tools: new Map([['w', writeTool(async () => { executed = true })]]),
    model: scripted([{ tool: 'w' }, { text: 'end' }]),
    preset: { mode: 'full' },
  })
  assert.equal(r.reason, 'completed')
  assert.equal(executed, true, 'full 写类放行')
})
