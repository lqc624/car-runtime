/**
 * 1.15.2 · abort 不杀进程（S57，桌面 S6 终验 R-1 实证回归）
 *
 * 缺陷面：取消时 `req.destroy(new Error('aborted'))` 在 Electron Node 24 宿主（Electron 44 /
 * node 24.21）内表现为进程级未捕获异常——响应流侧异步派发、无监听 → utilityProcess 直接退出，
 * 句柄全失、引导队列被 resume 误标 interrupted（S6 终验④ 实测：停止后下一次发送，T2 收到
 * turnEnd=interrupted/recovered）。修复：取消改 `req.destroy()`（不带 Error，取消语义由
 * spec.signal/D-19 承载）+ res 侧 error 监听双保险。
 *
 * 断言：
 *  - 流中途 abort → 无 uncaughtException（进程存活）；
 *  - 取消 ≠ 失败（D-19）：不产 error chunk、不 retry，迭代器静默收口；
 *  - 兼容线：无取消的正常流仍按 finishReason 收口（修复不改变成功路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOpenAICompatAdapter } from '../src/runtime-core/llm.ts'
import type { LlmRequest } from '../src/runtime-core/types.ts'

const BASE_REQ: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }

/** 持续吐 delta 的 SSE 服务（每 40ms 一块，直到连接关闭） */
function slowSseServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let n = 0
      const timer = setInterval(() => {
        n++
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'c' + n } }] })}\n\n`)
      }, 40)
      res.on('close', () => clearInterval(timer))
      req.on('error', () => clearInterval(timer))
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

test('S57-1 流中途 abort：无 uncaughtException + 静默收口（不产 error chunk）', async () => {
  const srv = await slowSseServer()
  let uncaught: unknown = null
  const onUncaught = (e: unknown): void => { uncaught = e }
  process.on('uncaughtException', onUncaught)
  try {
    const adapter = createOpenAICompatAdapter({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      provider: 'openai-compat',
      firstByteMs: 5_000,
      timeoutMs: 20_000,
      retries: 0,
    })
    const signal = { aborted: false }
    const chunks: unknown[] = []
    for await (const c of adapter.chat({ ...BASE_REQ, signal })) {
      chunks.push(c)
      if (chunks.length === 1) signal.aborted = true // 首块后取消（模拟用户点停止）
    }
    // 给 res 'error' 异步派发留出窗口——修复前此处必现 uncaughtException
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(uncaught, null, `abort 触发进程级未捕获异常：${String((uncaught as Error)?.message ?? uncaught)}`)
    const errors = chunks.filter((c) => (c as { finishReason?: string }).finishReason === 'error')
    assert.equal(errors.length, 0, '取消 ≠ 失败：不得产出 error chunk（D-19）')
    assert.ok(chunks.length >= 1, '首块应已到达')
  } finally {
    process.off('uncaughtException', onUncaught)
    await srv.close()
  }
})

test('S57-2 兼容线：未取消的流按 finishReason 正常收口（修复零影响成功路径）', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  try {
    const adapter = createOpenAICompatAdapter({ baseUrl: `http://127.0.0.1:${port}/v1`, provider: 'openai-compat', retries: 0 })
    const chunks: Array<{ finishReason?: string }> = []
    for await (const c of adapter.chat(BASE_REQ)) chunks.push(c)
    assert.equal(chunks[chunks.length - 1]!.finishReason, 'stop', '正常流以 stop 收口')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
