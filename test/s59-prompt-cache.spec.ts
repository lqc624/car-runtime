/**
 * 1.17-K4 · 提示缓存断点 P1（S59）：D-48 稳定前缀 cache_control（V1-A 形态）
 *
 * 覆盖（设计 §3.2 / §7 AC-1~3）：
 *  - 缺省断点在位：system 单块数组 + cache_control ephemeral（多条 system 连接进块文本）
 *  - 关断通道：CAR_LLM_PROMPT_CACHE=off → 顶层字符串（1.16.x 前形态，A/B 与回退）
 *  - 无 system 消息 = 无 system 键（零断点载荷）
 *  - openai-compat 零影响：请求体任何处无 cache_control（自动缓存，无需断点；off 两态同判）
 *  - AC-3 短 system：适配器不报错不静默改写（断点照挂——生效与否是 provider 侧最小长度
 *    门槛 ~1024 tokens 的事，以 usage.cacheCreationTokens 观测，禁「配了就该生效」推断）
 *  - CLI 生产路径：car run --no-prompt-cache → 出站体回字符串（flag→env→适配器 全链接线实证）
 *  - N1 零影响：断点为传输层注解——chatStep 落链投影不变（既有 N1 断言内嵌，此处回归锚）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnthropicAdapter, createOpenAICompatAdapter } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'
import { SessionLog } from '../src/session/log.ts'
import { Context } from '../src/kernel/context.ts'
import { RuntimeCore } from '../src/runtime-core/llm.ts'
import type { LlmChunk } from '../src/runtime-core/types.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

async function drain(gen: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text)); c.close() } })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (events: object[]) => events.map(dataLine).join('')
const TEXT_EVENTS = (text: string): object[] => [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]

const SYSTEMS = [
  { role: 'system', content: '规则一' },
  { role: 'system', content: '规则二' },
  { role: 'user', content: 'hi' },
] as const

function anthropicAdapter(fetchImpl: typeof fetch) {
  return createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl })
}

/** 环境变量受控执行（用后即复——禁测试间 env 残留假绿/假红） */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('S59: 缺省断点在位——system 单块数组 + cache_control ephemeral；off = 顶层字符串；无 system = 无键', async () => {
  const seen: Array<Record<string, unknown>> = []
  const capture = (async (_u: string | URL, init?: RequestInit) => {
    seen.push(JSON.parse((init!.body as string)))
    return sseResponse(anthropicSse(TEXT_EVENTS('ok')))
  }) as typeof fetch
  // 缺省：断点在位
  await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [...SYSTEMS], tools: [] }))
  assert.deepEqual(
    (seen[0]! as { system: unknown }).system,
    [{ type: 'text', text: '规则一\n\n规则二', cache_control: { type: 'ephemeral' } }],
    '缺省 = 单块数组 + ephemeral 断点（D-48 P1）',
  )
  // AC-3 短 system：不报错不静默改写（断点照挂——1024 tokens 门槛是 provider 侧事实）
  await withEnv({ CAR_LLM_PROMPT_CACHE: undefined }, async () => {
    await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [{ role: 'system', content: '短' }, { role: 'user', content: 'q' }], tools: [] }))
    assert.deepEqual(
      (seen[1]! as { system: unknown }).system,
      [{ type: 'text', text: '短', cache_control: { type: 'ephemeral' } }],
      '短 system 断点照挂（生效与否经 usage 观测——AC-3 不误判）',
    )
  })
  // 关断：回 1.16.x 前字符串形态
  await withEnv({ CAR_LLM_PROMPT_CACHE: 'off' }, async () => {
    await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [...SYSTEMS], tools: [] }))
    assert.equal((seen[2]! as { system: unknown }).system, '规则一\n\n规则二', 'off = 顶层字符串（A/B 与回退通道）')
  })
  // 无 system 消息：无 system 键
  await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], tools: [] }))
  assert.ok(!('system' in (seen[3]! as Record<string, unknown>)), '无 system 消息 = 无 system 键')
})

test('S59: openai-compat 零影响——请求体任何处无 cache_control（off 两态同判）', async () => {
  const bodies: string[] = []
  const openai = createOpenAICompatAdapter({
    baseUrl: 'https://api.test',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
      bodies.push(init!.body as string)
      return sseResponse(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
    }) as typeof fetch,
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE: undefined }, async () => {
    await drain(openai.chat({ model: 'gpt-x', messages: [...SYSTEMS], tools: [] }))
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE: 'off' }, async () => {
    await drain(openai.chat({ model: 'gpt-x', messages: [...SYSTEMS], tools: [] }))
  })
  for (const b of bodies) {
    assert.ok(!b.includes('cache_control'), 'openai-compat 通路零 cache_control（自动缓存，断点不出境）')
  }
  const parsed = JSON.parse(bodies[0]!) as { messages: Array<{ role: string }> }
  assert.equal(parsed.messages[0]!.role, 'system', 'openai system 仍在 messages 序列（形态不变）')
})

test('S59: N1 零影响——断点不进链/投影/快照比对（chatStep 落链回归锚）', async () => {
  const adapter = anthropicAdapter((async (_u: string | URL, _i?: RequestInit) =>
    sseResponse(anthropicSse(TEXT_EVENTS('ok')))) as typeof fetch)
  const core = new RuntimeCore(new CredentialService({ keychainReader: () => null }))
  core.bindContext(new Context())
  core.registerLlmAdapter(adapter, { default: true })
  const log = new SessionLog('s59-n1')
  log.append('runtime', 'system', 'T0', '规则')
  log.append('user', 'user', 'T0', 'hi')
  const result = await chatStep({ core, log, turnId: 'T0', model: 'claude-x', tools: [] })
  assert.equal(result.stopReason, 'stop', 'chatStep 正常收口（N1 内嵌断言无红——断点未进投影比对面）')
  const modelEvents = JSON.stringify(log.events)
  assert.ok(!modelEvents.includes('cache_control'), 'cache_control 不进 SessionLog（传输层注解红线）')
})

test('S59: CLI 生产路径——car run --no-prompt-cache → 出站体回字符串（flag→env→适配器接线实证）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-s59-cli-'))
  try {
    const plugin = `export const manifest = { name: 'p', version: '1.0.0' }\n` +
      `export default function apply(api) {}\n`
    writeFileSync(join(dir, 'p.ts'), plugin)
    const bodies: any[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        bodies.push(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(anthropicSse(TEXT_EVENTS('ok')))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', 'p.ts',
      '--adapter-id', 'anthropic',
      '--prompt', 'hi', '--base-url', `http://127.0.0.1:${port}`, '--model', 'claude-cli',
      '--system', '你是缓存关断测试助手', '--no-prompt-cache'], {
      cwd: dir,
      env: { ...process.env, ANTHROPIC_API_KEY: 'test-key-1', CAR_ALLOW_ENV_CREDENTIALS: '1', CAR_LLM_PROMPT_CACHE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const code = await new Promise<number>(resolve => child.on('exit', c => resolve(c ?? -1)))
    server.close()
    assert.equal(code, 0, err)
    assert.match(out, /turnEnd=completed/)
    assert.equal(typeof bodies[0].system, 'string', '--no-prompt-cache → 顶层字符串（flag 压过缺省断点）')
    assert.equal(bodies[0].system, '你是缓存关断测试助手')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
  }
})
