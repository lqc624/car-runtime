/**
 * 1.7-S3 · mcp-serve turn span 面（D-28）：sessionTurn 挂 turn 级 span（装配层拦截）
 *
 * 覆盖（1.7-迭代规划 TELE-3；1.2-S3「span 面随 W1」mcp-serve 半边出清）：
 *  - spawn E2E：mcp-serve 真进程 + 本地 http 捕获端点——session_turn 产 car.turn span 出站
 *    （car.turn_id=T1 回填〔facade 内部自增派生，装配层调用前不可知〕/ outcome=归一化 reason /
 *    traceId 生成 / parentSpanId 缺席=根 span）；turn span 落 /v1/traces；
 *  - 非会话工具（session_start）不产 span——拦截面仅 session_turn（D-28 口径）；
 *  - 既有 meter 桥与 S17 快照面不受影响（s29 全量回归保证）；遥测审计禁混流红线（静态断言）s29 保持。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveSessionId } from '../src/host/mappings.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

function withTempDir(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s41-${name}-`))
  return fn(dir).finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } })
}

test('S41: spawn E2E——mcp-serve sessionTurn → car.turn span 出站（turnId 回填 / outcome=reason）', async () => {
  await withTempDir('e2e', async dir => {
    const traceBodies: any[] = []
    let done: (v: void) => void = () => {}
    const closed = new Promise<void>(r => { done = r })
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        if (req.url === '/v1/traces') traceBodies.push(JSON.parse(body))
        res.writeHead(200).end()
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve'], {
        cwd: dir,
        env: { ...process.env, CAR_OTEL_ENDPOINT: `http://127.0.0.1:${port}`, CAR_OTEL_INTERVAL_MS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', d => { err += d })
      // 确定性派生（s36 同款）：session_start 返回的 CAR 会话 id 进程内预计算——双请求可并发下发
      const sid = deriveSessionId('claude-code', 's41-span')
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's41-span' } } }) + '\n')
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'session_turn',
          arguments: { sessionId: sid, input: { events: [{ hostEvent: 'user_message', payload: { content: 'hi' } }, { hostEvent: 'turn_complete' }] } },
        },
      }) + '\n')
      child.stdin.end()
      child.on('exit', () => done())
      // macOS runner 慢启动容差（s29 同款）；落选 race timer 必须 clear
      let raceTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, rej) => { raceTimer = setTimeout(() => rej(new Error(`mcp-serve 超时\n${err}`)), 60_000) }),
        ])
      } finally {
        if (raceTimer) clearTimeout(raceTimer)
      }
      const spans = traceBodies.flatMap(b => b.scopeSpans[0].spans)
      const turnSpan = spans.find(s => s.name === 'car.turn')
      assert.ok(turnSpan, 'session_turn 产 car.turn span 出站（v1/traces 面可达）')
      const attrs = Object.fromEntries(turnSpan.attributes.map((a: any) => [a.key, a.value.stringValue]))
      assert.equal(attrs['car.turn_id'], 'T1', 'turnId 事后回填（facade 内部自增派生）')
      assert.equal(attrs['car.outcome'], 'completed', 'outcome = 归一化 turnEnd reason')
      assert.ok(turnSpan.traceId && turnSpan.spanId, 'traceId/spanId 生成')
      assert.equal('parentSpanId' in turnSpan, false, '根 span 无 parent')
      assert.equal('events' in turnSpan, false, '正常路径无 exception 事件')
      assert.equal(turnSpan.status.code, 'STATUS_CODE_UNSET')
      // 非会话工具（session_start）不产 span——拦截面仅 session_turn（D-28）
      assert.equal(spans.length, 1, '单 session_turn = 单 turn span（session_start 不产 span）')
      // 零内容口径：span 出站体无会话内容（user_message payload 不出站）
      assert.equal(/hi|user_message/.test(JSON.stringify(traceBodies)), false, 'span 出站体零内容（事件批内容不出站）')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})

test('S41: session_turn 未知会话显式报错——span 收口 error + exception 事件出站', async () => {
  await withTempDir('err', async dir => {
    const traceBodies: any[] = []
    let done: (v: void) => void = () => {}
    const closed = new Promise<void>(r => { done = r })
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        if (req.url === '/v1/traces') traceBodies.push(JSON.parse(body))
        res.writeHead(200).end()
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve'], {
        cwd: dir,
        env: { ...process.env, CAR_OTEL_ENDPOINT: `http://127.0.0.1:${port}`, CAR_OTEL_INTERVAL_MS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', d => { err += d })
      child.on('exit', () => done())
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'session_turn', arguments: { sessionId: 'SH-nonexistent', input: { events: [] } } },
      }) + '\n')
      child.stdin.end()
      let raceTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, rej) => { raceTimer = setTimeout(() => rej(new Error(`mcp-serve 超时\n${err}`)), 60_000) }),
        ])
      } finally {
        if (raceTimer) clearTimeout(raceTimer)
      }
      const spans = traceBodies.flatMap(b => b.scopeSpans[0].spans)
      const turnSpan = spans.find(s => s.name === 'car.turn')
      assert.ok(turnSpan, '失败路径 turn span 仍出站')
      assert.equal(turnSpan.status.code, 'STATUS_CODE_ERROR', 'handle 异常 → status ERROR')
      const ev = turnSpan.events?.find((e: any) => e.name === 'exception')
      assert.ok(ev, 'exception 事件出站（D-26 形态在 mcp-serve 路径成立）')
      const evAttrs = Object.fromEntries(ev.attributes.map((a: any) => [a.key, a.value.stringValue]))
      assert.match(evAttrs['exception.message'] ?? '', /CAR-E-HOST/, '异常消息进 exception.message（内容治理属调用方）')
      const attrs = Object.fromEntries(turnSpan.attributes.map((a: any) => [a.key, a.value.stringValue]))
      assert.equal(attrs['car.outcome'], 'error')
      assert.equal('car.turn_id' in attrs, false, '回填前失败：无占位 turnId（startTurn(\'\') 空值不设属性）')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
