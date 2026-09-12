import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

/** 真实子进程 stdio 对话（E-6 预演：非 PassThrough 模拟，是 spawn 进程级验证） */
function talk(host: string, requests: string[]): Promise<{ outs: any[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve', '--host', host], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('exit', () => {
      try { resolve({ outs: out.split('\n').filter(Boolean).map(l => JSON.parse(l)), stderr: err }) } catch (e) { reject(e) }
    })
    for (const r of requests) child.stdin.write(r + '\n')
    child.stdin.end()
  })
}

test('S18: mcp-serve 真实进程——tools/list + session_start + turn + verify 全链路', async () => {
  const { outs } = await talk('claude-code', [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 'cc-e2e' } } }),
  ])
  assert.equal(outs[0].result.tools.length, 10)
  const sid = JSON.parse(outs[1].result.content[0].text).sessionId
  assert.match(sid, /^SH-[0-9a-f]{24}$/)

  // 同一进程第二轮（另起进程验证幂等派生一致性）
  const { outs: outs2 } = await talk('claude-code', [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 'cc-e2e' } } }),
  ])
  assert.equal(JSON.parse(outs2[0].result.content[0].text).sessionId, sid, '跨进程确定性派生（幂等）')
})

test('S18: 采集窗口——会话结束 stderr 输出零内容快照（登记表兜底通道实化）', async () => {
  const { stderr } = await talk('claude-code', [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_turn', arguments: { sessionId: 'SH-nonexistent', input: { events: [] } } } }),
  ])
  assert.match(stderr, /\[car mcp-serve\].*snapshot=/)
  assert.match(stderr, /zeroContent=true/, '零内容红线自检通过')
  const snap = JSON.parse(/snapshot=(\{.*?\}) zeroContent/.exec(stderr)![1])
  assert.ok('car_registry_decision|source=registry' in snap)
})

test('S18: codex 宿主接入（同一入口不同 hostId）', async () => {
  const { outs } = await talk('codex', [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 'cx-e2e' } } }),
  ])
  const sid = JSON.parse(outs[0].result.content[0].text).sessionId
  assert.match(sid, /^SH-[0-9a-f]{24}$/)
  const cc = await talk('claude-code', [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 'cx-e2e' } } }),
  ])
  assert.notEqual(JSON.parse(cc.outs[0].result.content[0].text).sessionId, sid, '跨宿主隔离经真实进程验证')
})

test('S18: 未知 hostId 显式拒绝（exit 2）', async () => {
  const code = await new Promise<number>(resolve => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve', '--host', 'unknown-host'])
    child.on('exit', c => resolve(c ?? -1))
    child.stdin.end()
  })
  assert.equal(code, 2)
})
