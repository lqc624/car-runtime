import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convergeBudget, PTC_BUDGET_BASELINE } from '../src/ptc/budget.ts'
import { checkErasableOnly } from '../src/ptc/erasable.ts'
import { runCode, makePtcToolDefinition, type ToolBridge } from '../src/ptc/runCode.ts'
import { runTurn, type ModelStep, type ToolDef } from '../src/loop/stop.ts'
import { SessionLog } from '../src/session/log.ts'

// ==================== 预算收敛（只许下调） ====================

test('PTC 预算: 基线对齐 dsh 一手口径（60s/600s/64MB）', () => {
  assert.deepEqual(PTC_BUDGET_BASELINE, { computeMs: 60_000, maxWallMs: 600_000, maxOutputBytes: 64 * 1024 * 1024 })
  const b = convergeBudget()
  assert.deepEqual(b, { computeMs: 60_000, maxWallMs: 600_000, maxOutputBytes: 64 * 1024 * 1024 })
})

test('PTC 预算: 下调通过；上调 = CAR-E-BUDGET 显式报错（fail-closed）', () => {
  const b = convergeBudget({ computeMs: 30_000, maxWallMs: 1000, maxOutputBytes: 1024 })
  assert.deepEqual(b, { computeMs: 30_000, maxWallMs: 1000, maxOutputBytes: 1024 })
  assert.throws(() => convergeBudget({ maxWallMs: 700_000 }), /只许下调/)
  assert.throws(() => convergeBudget({ maxOutputBytes: 65 * 1024 * 1024 }), /CAR-E-BUDGET/)
  assert.throws(() => convergeBudget({ computeMs: -1 }), /positive/)
})

// ==================== erasable-only 检查 ====================

test('erasable: enum/namespace/参数属性/装饰器/import=require 全拒绝', () => {
  const cases: Array<[string, string]> = [
    ['enum 声明', 'enum Color { Red }\nreturn 1'],
    ['namespace 声明', 'namespace Util {\n  export const x = 1\n}\nreturn 1'],
    ['构造器参数属性', 'class A { constructor(private x: number) {} }\nreturn 1'],
    ['import=require', "import fs = require('node:fs')\nreturn 1"],
    ['装饰器', 'const y = Object()\n@Component()\nclass B {}\nreturn 1'],
  ]
  for (const [name, code] of cases) {
    const r = checkErasableOnly(code)
    assert.equal(r.ok, false, `${name} 应被拒绝`)
    assert.match(r.violation!, /non-erasable/)
  }
  // 普通 erasable async 函数体通过
  assert.equal(checkErasableOnly('const x: number = 1\nawait Promise.resolve()\nreturn x + 1').ok, true)
})

// ==================== runCode：worker 隔离 + 工具桥 + 预算 ====================

function tools(): Map<string, ToolBridge> {
  return new Map([
    ['add', { run: async (a: unknown) => (a as { x: number; y: number }).x + (a as { x: number; y: number }).y }],
  ])
}

test('runCode: code+description 双必填（description = 授权门人审凭据）', async () => {
  const t = tools()
  await assert.rejects(() => runCode({ code: '   ', description: 'd', toolCallId: 'p1', budget: { maxWallMs: 1000 } }, { tools: t }), /code is required/)
  await assert.rejects(() => runCode({ code: 'return 1', description: '', toolCallId: 'p1', budget: { maxWallMs: 5000 } }, { tools: t }), /description is required/)
})

test('runCode: worker 执行程序体 return 值回传（每次新 worker）', async () => {
  const r = await runCode({ code: 'const a = await tools.add({ x: 2, y: 3 })\nreturn { sum: a }', description: '两数相加验证工具桥', toolCallId: 'p2', budget: { maxWallMs: 10_000 } }, { tools: tools() })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.result, { sum: 5 })
  assert.ok(r.wallMs < 10_000)
})

test('runCode: 未知工具调用 = 显式错误（不静默）', async () => {
  const r = await runCode({ code: 'await tools.nope({})\nreturn 1', description: '未知工具调用路径验证', toolCallId: 'p3', budget: { maxWallMs: 5000 } }, { tools: tools() })
  assert.equal(r.ok, false)
  assert.match(r.error!, /unknown tool/)
})

test('runCode: maxWallMs 超限 = budget-exceeded 工具错误结果（不掐 turn 不抛异常）', async () => {
  const r = await runCode({ code: 'while (true) { await new Promise(r => setTimeout(r, 10)) }\nreturn 1', description: '死循环预算护栏验证', toolCallId: 'p4', budget: { maxWallMs: 300 } }, { tools: tools() })
  assert.equal(r.ok, false)
  assert.equal(r.budgetExceeded, true)
  assert.match(r.error!, /budget-exceeded \(maxWallMs=300\)/)
})

test('runCode: erasable 违规在入口拒绝（不产生 worker）', async () => {
  await assert.rejects(() => runCode({ code: 'enum E { A }\nreturn 1', description: 'erasable 挂点验证', toolCallId: 'p5', budget: { maxWallMs: 1000 } }, { tools: tools() }), /CAR-E-PTC.*non-erasable/)
})

// ==================== 停止语义衔接（ADR-001：预算到期不掐 turn） ====================

test('PTC × runTurn: 一等 ToolDefinition 强制 write；程序错误结果交回模型后 turn 正常收口', async () => {
  const log = new SessionLog()
  const ptc = makePtcToolDefinition({ tools: tools() })
  assert.equal(ptc.declaredSideEffect, 'write') // containment 非安全边界 → 最高约束
  const all = new Map<string, ToolDef>([['run_code', ptc as unknown as ToolDef]])
  let n = 0
  const r = await runTurn({
    log, turnId: 'PTC', tools: all, preset: { mode: 'full' },
    model: async (): Promise<ModelStep> => {
      if (n++ === 0) return { stopReason: 'toolUse', toolCalls: [{ id: 'pc1', tool: 'run_code', args: { code: 'return await tools.add({ x: 20, y: 22 })', description: '求和演示' } }] }
      return { stopReason: 'stop', text: 'sum is 42' }
    },
  })
  assert.equal(r.reason, 'completed') // 预算语义外：正常收口
  const call = log.events.find(e => e.kind === 'toolCall')
  assert.ok(call, 'PTC 调用落哈希链（与其他工具同链路，无旁路）')
})

test('PTC × runTurn: 程序体抛错 = 工具错误结果交回模型（turn 不 interrupted/aborted）', async () => {
  const log = new SessionLog()
  const ptc = makePtcToolDefinition({ tools: tools() })
  const all = new Map<string, ToolDef>([['run_code', ptc as unknown as ToolDef]])
  let n = 0
  const r = await runTurn({
    log, turnId: 'PTC2', tools: all, preset: { mode: 'full' },
    model: async (): Promise<ModelStep> => {
      if (n++ === 0) return { stopReason: 'toolUse', toolCalls: [{ id: 'pc2', tool: 'run_code', args: { code: 'throw new Error("boom")', description: '错误路径验证' } }] }
      return { stopReason: 'stop', text: 'handled' }
    },
  })
  assert.equal(r.reason, 'completed') // 错误结果交回模型继续，六值枚举不被 PTC 扩展
  const res = log.events.find(e => e.kind === 'toolResult') as { payload: { error?: string } } | undefined
  assert.ok(res, 'toolResult 落链')
})
