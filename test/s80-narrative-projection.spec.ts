/**
 * s80 · 1.24.1 F4 宿主叙事投影排除（对象形态 system 不进模型上下文）
 *
 * 判据（桌面 B-2 真模型演练 2026-11-15 实锤——tokenhub openai 严格网关 400）：
 *  - system kind payload 为对象（browser/*、bash/* 等宿主审计叙事）→ 不投影
 *    （model_visible=0 与 settlement 同纪律——1.24 W2 D-W2-1 同族）；
 *  - payload 为字符串（1.4-S2 system prompt / T-MP persona 注入）→ 投影保持（兼容线）；
 *  - 对象叙事夹在 assistant(toolCall) 与 toolResult 之间 → 投影后 tool 消息相邻性完整
 *    （openai 严格网关「tool_calls 必须紧跟足量 tool 消息」校验的前置）；
 *  - 对象 system 仍隔断跨叙事 thinking 附加（1.22 隔断语义不变）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLog } from '../src/session/log.ts'

test('S80-1 对象叙事不投影：browser/bash 叙事零进上下文', () => {
  const log = new SessionLog('s80-narrative')
  log.append('user', 'user', 'T1', 'hi')
  log.append('runtime', 'system', 'session', { type: 'browser/start', url: 'https://x' })
  log.append('runtime', 'system', 'session', { type: 'browser/exit', url: 'https://x', reason: 'loaded' })
  log.append('model', 'assistant', 'T1', 'opened')
  const msgs = log.deriveMessages()
  assert.equal(msgs.filter((m) => m.role === 'system').length, 0, '对象叙事 = model_visible 0')
  assert.equal(msgs.at(-1)!.role, 'assistant')
})

test('S80-2 字符串 system 投影保持：system prompt / persona 注入（兼容线）', () => {
  const log = new SessionLog('s80-str')
  log.append('runtime', 'system', 'system', '你是集成测试助手')
  log.append('user', 'user', 'T1', 'hi')
  log.append('runtime', 'system', 'session', { type: 'session-start', workspaceId: 'w' })
  log.append('runtime', 'system', 'T1', '风格指令文本', { injection: 'persona', toneStyle: 'terse', chars: 6 })
  const msgs = log.deriveMessages()
  const systems = msgs.filter((m) => m.role === 'system')
  assert.deepEqual(systems.map((m) => m.content), ['你是集成测试助手', '风格指令文本'], '字符串形态投影；对象叙事排除')
})

test('S80-3 工具环相邻性：叙事夹在 toolCall 与 toolResult 之间 → 投影后 assistant→tool 紧邻（tokenhub 400 复现形态修复）', () => {
  const log = new SessionLog('s80-adjacency')
  log.append('user', 'user', 'T1', 'open page')
  log.append('model', 'toolCall', 'T1', { id: 'call-1', tool: 'browser_open', args: { url: 'https://x' } })
  log.append('runtime', 'system', 'session', { type: 'browser/start', url: 'https://x' })
  log.append('runtime', 'system', 'session', { type: 'browser/exit', url: 'https://x', reason: 'loaded', durationMs: 148 })
  log.append('plugin', 'toolResult', 'T1', { id: 'call-1', result: { url: 'https://x', title: 'X' } })
  const msgs = log.deriveMessages()
  const idx = msgs.findIndex((m) => m.toolCall)
  assert.ok(idx >= 0, 'toolCall 消息在投影')
  assert.equal(msgs[idx + 1]?.role, 'toolResult', 'assistant(toolCall) 下一条 = toolResult（相邻性完整）')
  assert.equal(msgs[idx + 1]?.content?.id, 'call-1')
  assert.equal(msgs.filter((m) => m.role === 'system').length, 0)
})

test('S80-4 对象 system 仍隔断跨叙事 thinking 附加（1.22 隔断语义不变）', () => {
  const log = new SessionLog('s80-thinking')
  log.append('user', 'user', 'T1', 'q1')
  log.append('model', 'thinking', 'T1', 'pondering q1')
  log.append('runtime', 'system', 'session', { type: 'browser/start', url: 'https://x' }) // 叙事隔断
  log.append('model', 'toolCall', 'T1', { id: 'c1', tool: 'fs_read', args: {} })
  log.append('plugin', 'toolResult', 'T1', { id: 'c1', result: {} })
  const msgs = log.deriveMessages()
  const tc = msgs.find((m) => m.toolCall)!
  assert.equal(tc.thinking, undefined, '对象 system 隔断后 thinking 不附加（1.22 口径）')
})
