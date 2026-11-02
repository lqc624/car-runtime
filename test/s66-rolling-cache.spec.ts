/**
 * 1.20-K1 · D-48 P2 滚动断点白名单（S66）
 *
 * 覆盖（1.20 设计 §5 AC-1~12）：
 *  - AC-1 白名单空 = 1.19.0 逐字节一致（消息级零 cache_control，content 仍字符串）
 *  - AC-2 白名单命中 → 尾部 user 块化 + 末块 ephemeral 断点（P1 system 断点并存）
 *  - AC-3 白名单不含该身份 → 不挂断点（门控负例）
 *  - AC-4 CAR_LLM_PROMPT_CACHE=off 连坐 → system 回字符串 + 消息零断点
 *  - AC-5 尾部 tool_result 多块 → 断点挂末块，tool_use_id/is_error 语义不变
 *  - AC-6 尾部 assistant tool_use → 断点挂该块
 *  - AC-7 空串 content 跳过前移（不造空块）
 *  - AC-8 breakpoints=5 钳制 3（provider 硬限 4 − system 1）
 *  - AC-9 池身份专项锁：白名单含 ep-1 不含 ep-2 → 仅 ep-1 请求带断点
 *    （池成员适配器 id 恒 'anthropic'，禁按其求值——1.20 设计 §3.1）
 *  - AC-10 N1 零影响：开/关滚动两会话链事件（去 seq/ts/hash）逐字节相同，cache_control 不进链
 *  - AC-11 openai-compat 任何配置零 cache_control
 *  - AC-12 CLI 生产路径：--prompt-cache-rolling anthropic → flag→env→适配器全链接线
 *  - 附：config schema——adapters 空表 / breakpoints>3 显式拒绝；合法形态经 mergeLlmConfig 透传
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnthropicAdapter, createOpenAICompatAdapter, RuntimeCore, rollingCacheAllowed } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'
import { SessionLog } from '../src/session/log.ts'
import { Context } from '../src/kernel/context.ts'
import { assembleModelPool } from '../src/load/pool.ts'
import { loadCarConfig, mergeLlmConfig } from '../src/load/config.ts'
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

function anthropicAdapter(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createAnthropicAdapter({ baseUrl: 'https://api.test', fetchImpl, ...extra })
}

/** 出站体 messages 里携带 cache_control 的块（消息级断点观测口径） */
function messageBreakpoints(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of (body.messages ?? []) as Array<{ content: unknown }>) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b === 'object' && !Array.isArray(b) && 'cache_control' in (b as object)) {
          out.push(b as Record<string, unknown>)
        }
      }
    }
  }
  return out
}

/** 环境变量受控执行（用后即复——禁测试间 env 残留假绿/假红，S59 同款） */
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

test('S66: 白名单门控——空表零差异 / 命中挂尾 / 未命中不挂 / off 连坐（AC-1~4）', async () => {
  const seen: Array<Record<string, unknown>> = []
  const capture = (async (_u: string | URL, init?: RequestInit) => {
    seen.push(JSON.parse(init!.body as string))
    return sseResponse(anthropicSse(TEXT_EVENTS('ok')))
  }) as typeof fetch

  // AC-1：白名单缺省空 → 请求体与 1.19.0 一致（消息级零断点，content 仍字符串）
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: undefined, CAR_LLM_PROMPT_CACHE_ROLLING_BREAKPOINTS: undefined }, async () => {
    await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [...SYSTEMS], tools: [] }))
    const b = seen[0] as { messages: Array<{ role: string; content: unknown }>; system: unknown }
    assert.equal(messageBreakpoints(b).length, 0, '白名单空 = 消息级零断点（AC-1）')
    assert.equal(b.messages[0]!.content, 'hi', 'content 仍字符串（AC-1 逐字节一致）')
    assert.deepEqual(b.system, [{ type: 'text', text: '规则一\n\n规则二', cache_control: { type: 'ephemeral' } }], 'P1 system 断点不受影响')
  })

  // AC-2：白名单命中（单端点身份 = adapter id 'anthropic'）→ 尾部 user 块化 + 末块断点
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic' }, async () => {
    await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [...SYSTEMS], tools: [] }))
    const b = seen[1] as { messages: Array<{ role: string; content: unknown }> }
    assert.deepEqual(
      b.messages[0]!.content,
      [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      '尾部 user 块化 + ephemeral 断点（AC-2）',
    )
  })

  // AC-3：白名单不含该身份 → 不挂（负例；大小写敏感同判）
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'gateway-a, ep-9' }, async () => {
    await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [...SYSTEMS], tools: [] }))
    assert.equal(messageBreakpoints(seen[2] as Record<string, unknown>).length, 0, '未命中身份不挂断点（AC-3）')
  })

  // AC-4：P1 kill switch 连坐 → system 回字符串 + 消息零断点
  await withEnv({ CAR_LLM_PROMPT_CACHE: 'off', CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic' }, async () => {
    await drain(anthropicAdapter(capture).chat({ model: 'claude-x', messages: [...SYSTEMS], tools: [] }))
    const b = seen[3] as { messages: Array<{ role: string; content: unknown }>; system: unknown }
    assert.equal(b.system, '规则一\n\n规则二', 'off 连坐：system 回字符串（AC-4）')
    assert.equal(messageBreakpoints(b).length, 0, 'off 连坐：消息级零断点（AC-4）')
  })
})

test('S66: rollingCacheAllowed 口径——off 连坐 / off 清单 / 无通配 / 大小写敏感 / 非法值', async () => {
  await withEnv({ CAR_LLM_PROMPT_CACHE: undefined, CAR_LLM_PROMPT_CACHE_ROLLING: undefined }, async () => {
    assert.equal(rollingCacheAllowed('anthropic'), false, '缺省关闭')
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE: 'off', CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic' }, async () => {
    assert.equal(rollingCacheAllowed('anthropic'), false, 'P1 kill switch 连坐最高优先')
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'off' }, async () => {
    assert.equal(rollingCacheAllowed('anthropic'), false, "清单值 'off' = 显式清空")
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: '*' }, async () => {
    assert.equal(rollingCacheAllowed('anthropic'), false, '无通配（通配废掉逐条确证）')
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'Anthropic' }, async () => {
    assert.equal(rollingCacheAllowed('anthropic'), false, '大小写敏感（归一化会掩盖登记错误）')
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: ' gateway-a ,anthropic,' }, async () => {
    assert.equal(rollingCacheAllowed('anthropic'), true, '逗号清单 trim 后精确匹配')
  })
})

test('S66: 块形态路径——tool_result 末块 / tool_use 块 / 空串跳过 / 断点数钳制（AC-5~8）', async () => {
  const seen: Array<Record<string, unknown>> = []
  const capture = (async (_u: string | URL, init?: RequestInit) => {
    seen.push(JSON.parse(init!.body as string))
    return sseResponse(anthropicSse(TEXT_EVENTS('ok')))
  }) as typeof fetch
  const adapter = anthropicAdapter(capture)

  // AC-5：尾部 tool_result（CAR 请求尾块常态）→ 断点挂末块，语义字段不变
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic' }, async () => {
    await drain(adapter.chat({
      model: 'claude-x',
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: { toolCall: { id: 'tu-1', tool: 'fs_read', args: { path: 'a.txt' } } } },
        { role: 'toolResult', content: { id: 'tu-1', result: '内容' } },
      ],
      tools: [],
    }))
    const msgs = (seen[0] as { messages: Array<{ role: string; content: unknown }> }).messages
    const tail = msgs[msgs.length - 1]!.content as Array<Record<string, unknown>>
    assert.equal(tail.length, 1, 'toolResult 收敛单 user 单块（合并不受影响）')
    assert.equal(tail[0]!.type, 'tool_result')
    assert.equal(tail[0]!.tool_use_id, 'tu-1', 'tool_use_id 语义不变（AC-5）')
    assert.deepEqual(tail[0]!.cache_control, { type: 'ephemeral' }, '断点挂末块（AC-5）')
    assert.deepEqual(msgs[1]!.content, [{ type: 'tool_use', id: 'tu-1', name: 'fs_read', input: { path: 'a.txt' } }], 'tool_use 块不重组')
  })

  // AC-6：尾部 assistant tool_use（无 toolResult 请求形态）→ 断点挂该块
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic' }, async () => {
    await drain(adapter.chat({
      model: 'claude-x',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: { toolCall: { id: 'tu-2', tool: 'fs_read', args: {} } } },
      ],
      tools: [],
    }))
    const msgs = (seen[1] as { messages: Array<{ role: string; content: unknown }> }).messages
    const tail = msgs[msgs.length - 1]!.content as Array<Record<string, unknown>>
    assert.equal(tail[0]!.type, 'tool_use')
    assert.deepEqual(tail[0]!.cache_control, { type: 'ephemeral' }, 'tool_use 块挂断点（AC-6）')
  })

  // AC-7：空串 content 跳过前移——断点落在前一条非空消息，不造空块
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic' }, async () => {
    await drain(adapter.chat({
      model: 'claude-x',
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '答' },
        { role: 'user', content: '' },
      ],
      tools: [],
    }))
    const msgs = (seen[2] as { messages: Array<{ role: string; content: unknown }> }).messages
    assert.equal(msgs[msgs.length - 1]!.content, '', '空串保持字符串（不造空块，AC-7）')
    const bps = messageBreakpoints(seen[2] as Record<string, unknown>)
    assert.equal(bps.length, 1)
    assert.deepEqual(bps[0], { type: 'text', text: '答', cache_control: { type: 'ephemeral' } }, '断点前移到上一条非空消息（AC-7）')
  })

  // AC-8：breakpoints=5 → 钳制 3（provider 硬限 4 − system 1）
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic', CAR_LLM_PROMPT_CACHE_ROLLING_BREAKPOINTS: '5' }, async () => {
    await drain(adapter.chat({
      model: 'claude-x',
      messages: [
        { role: 'user', content: '一' },
        { role: 'assistant', content: '二' },
        { role: 'user', content: '三' },
        { role: 'assistant', content: '四' },
        { role: 'user', content: '五' },
      ],
      tools: [],
    }))
    const bps = messageBreakpoints(seen[3] as Record<string, unknown>)
    assert.equal(bps.length, 3, '钳制 3 = provider 硬限 4 − system 1（AC-8）')
    // 非法值回落缺省 1
    await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING_BREAKPOINTS: 'abc' }, async () => {
      await drain(adapter.chat({ model: 'claude-x', messages: [...SYSTEMS], tools: [] }))
      assert.equal(messageBreakpoints(seen[4] as Record<string, unknown>).length, 1, '非法 breakpoints 回落缺省 1')
    })
  })
})

test('S66: 池身份专项锁——白名单含 ep-1 不含 ep-2，仅 ep-1 请求带断点（AC-9）', async () => {
  const bodies1: Array<Record<string, unknown>> = []
  const bodies2: Array<Record<string, unknown>> = []
  // 服务器只承接 health 探测（probePoolMember 走真实 http GET /v1/models，不吃注入 fetch）；
  // chat 出站体在 fetchImpl 内捕获（池成员适配器吃注入 fetch）
  const mkServer = () => new Promise<{ server: ReturnType<typeof createServer>; base: string }>(resolve => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
    })
    s.listen(0, '127.0.0.1', () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` }))
  })
  const s1 = await mkServer()
  const s2 = await mkServer()
  try {
    const mkPool = (ep1Base: string) => assembleModelPool({
      pool: {
        endpoints: [
          { id: 'ep-1', baseUrl: ep1Base, model: 'm-1', adapterId: 'anthropic' },
          { id: 'ep-2', baseUrl: s2.base, model: 'm-2', adapterId: 'anthropic' },
        ],
      },
      fetchImpl: (async (u: string | URL, init?: RequestInit) => {
        const url = String(u)
        if (url.startsWith(s2.base)) bodies2.push(JSON.parse(init!.body as string))
        else bodies1.push(JSON.parse(init!.body as string))
        return sseResponse(anthropicSse(TEXT_EVENTS('ok')))
      }) as typeof fetch,
    })

    await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'ep-1' }, async () => {
      // ① ep-1 健康（探测 200）→ 路由 ep-1 → 断点在位
      const a1 = mkPool(s1.base)
      await drain(a1.adapter.chat({ model: 'm-1', messages: [...SYSTEMS], tools: [] }))
      assert.equal(bodies1.length, 1, 'ep-1 被选中并出站')
      assert.equal(messageBreakpoints(bodies1[0]!).length, 1, '白名单命中 ep-1 → 断点在位（AC-9）')
      assert.equal(bodies2.length, 0, 'ep-2 未被路由')

      // ② ep-1 探测不可达（关闭端口 → 真实连接拒绝）→ 路由 ep-2 → 无断点（池成员 id 求值锁：
      //    若误按 adapter.id='anthropic' 求值，ep-2 也会挂——本断言即 1.20 设计 §3.1 陷阱的回归锚）
      const a2 = mkPool('http://127.0.0.1:9')
      await drain(a2.adapter.chat({ model: 'm-1', messages: [...SYSTEMS], tools: [] }))
      assert.equal(bodies2.length, 1, 'ep-2 被选中并出站')
      assert.equal(messageBreakpoints(bodies2[0]!).length, 0, '白名单不含 ep-2 → 不挂断点（AC-9 专项锁）')
    })
  } finally {
    s1.server.close()
    s2.server.close()
  }
})

test('S66: N1 零影响——开/关滚动两会话链事件（去 seq/ts/hash）逐字节相同（AC-10）', async () => {
  const adapter = anthropicAdapter((async (_u: string | URL, _i?: RequestInit) =>
    sseResponse(anthropicSse(TEXT_EVENTS('ok')))) as typeof fetch)
  const run = async () => {
    const core = new RuntimeCore(new CredentialService({ keychainReader: () => null }))
    core.bindContext(new Context())
    core.registerLlmAdapter(adapter, { default: true })
    const log = new SessionLog('s66-n1')
    log.append('runtime', 'system', 'T0', '规则')
    log.append('user', 'user', 'T0', 'hi')
    const res = await chatStep({ core, log, turnId: 'T0', model: 'claude-x', tools: [] })
    const strip = JSON.stringify(log.events.map(e => ({ actor: e.actor, kind: e.kind, turnId: e.turnId, payload: e.payload, meta: e.meta ?? null })))
    return { stop: res.stopReason, strip }
  }
  const off = await withEnvR({ CAR_LLM_PROMPT_CACHE_ROLLING: undefined }, run)
  const on = await withEnvR({ CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic' }, run)
  assert.equal(on.stop, 'stop')
  assert.equal(off.strip, on.strip, '开/关滚动链事件逐字节相同（N1：断点为传输层注解，AC-10）')
  assert.ok(!off.strip.includes('cache_control') && !on.strip.includes('cache_control'), 'cache_control 不进 SessionLog（红线）')
})

/** withEnv 带返回值变体（AC-10 用） */
async function withEnvR<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  let out!: T
  await withEnv(env, async () => { out = await fn() })
  return out
}

test('S66: openai-compat 任何配置零 cache_control（AC-11）', async () => {
  const bodies: string[] = []
  const openai = createOpenAICompatAdapter({
    baseUrl: 'https://api.test',
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
      bodies.push(init!.body as string)
      return sseResponse(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
    }) as typeof fetch,
  })
  await withEnv({ CAR_LLM_PROMPT_CACHE_ROLLING: 'anthropic', CAR_LLM_PROMPT_CACHE_ROLLING_BREAKPOINTS: '3' }, async () => {
    await drain(openai.chat({ model: 'gpt-x', messages: [...SYSTEMS], tools: [] }))
  })
  assert.ok(!bodies[0]!.includes('cache_control'), 'openai-compat 断点不出境（自动缓存，AC-11）')
})

test('S66: config schema——空表 / 超限显式拒绝，合法形态经 mergeLlmConfig 透传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-s66-cfg-'))
  try {
    const load = (content: string) => {
      const p = join(dir, 'car.config.json')
      writeFileSync(p, content)
      return loadCarConfig({ explicitPath: p })
    }
    const empty = load('{"llm":{"promptCache":{"rolling":{"adapters":[]}}}}')
    assert.match(empty.error ?? '', /至少登记一个路由身份/, 'adapters 空表显式拒绝（禁静默 no-op）')
    const over = load('{"llm":{"promptCache":{"rolling":{"adapters":["anthropic"],"breakpoints":5}}}}')
    assert.match(over.error ?? '', /必须为 1\.\.3/, 'breakpoints>3 显式拒绝（provider 硬限）')
    const ok = load('{"llm":{"promptCache":{"rolling":{"adapters":["anthropic","ep-1"],"breakpoints":2}}}}')
    assert.equal(ok.error, undefined, ok.error)
    const merged = mergeLlmConfig({}, ok.config)
    assert.deepEqual(merged.promptCache?.rolling, { adapters: ['anthropic', 'ep-1'], breakpoints: 2 }, 'mergeLlmConfig 透传声明层')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
  }
})

test('S66: CLI 生产路径——--prompt-cache-rolling → flag→env→适配器全链接线（AC-12）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-s66-cli-'))
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
      '--system', '你是滚动断点测试助手', '--prompt-cache-rolling', 'anthropic'], {
      cwd: dir,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'test-key-1',
        CAR_ALLOW_ENV_CREDENTIALS: '1',
        CAR_LLM_PROMPT_CACHE: undefined,
        CAR_LLM_PROMPT_CACHE_ROLLING: undefined,
      },
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
    const b = bodies[0] as { system: unknown; messages: Array<{ role: string; content: unknown }> }
    assert.deepEqual(
      b.messages[0]!.content,
      [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      'flag→env→适配器：尾部 user 块化 + 断点（AC-12）',
    )
    assert.deepEqual(b.system, [{ type: 'text', text: '你是滚动断点测试助手', cache_control: { type: 'ephemeral' } }], 'P1 system 断点并存')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
  }
})
