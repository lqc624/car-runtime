/**
 * 1.4-S1~S5 · 真实模型接线（S31）：声明面统一 / system 落链 / llm.* 配置 / loopback 豁免 /
 * 取消透传 / CarM8Error 保形 / car run 装配重做（D-13）+ 多步真 E2E
 *
 * 覆盖（1.4-迭代规划 W1-1~W1-7）：
 *  - toToolDefinitions：schema 透传 / T-22 缺省 write 收口
 *  - 'system' 事件：投影 role:'system'（§3.5.5 新可见输入 = 新事件类型）
 *  - llm.* 配置：校验 fail-visible / 优先级 flag > env > config / CAR_LLM_* env
 *  - D-12a：http loopback 豁免（127.0.0.1/localhost/[::1]）+ 非 loopback http 拒绝
 *  - 取消（D-19）：TurnAborted 首次实抛（finish 检查前序）+ runTurn 收口 aborted
 *  - CarM8Error 保形：A080001 userHint/retryable 到 turnEnd
 *  - 多步真 E2E：本地 loopback 假 SSE 服务——system 出站 / 工具 schema 出站 / Bearer 凭据 /
 *    第二请求含 toolResult / 声明面=授权面；car run spawn 全链 + 无配置 exit 2
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toToolDefinitions } from '../src/runtime-core/tools.ts'
import { createOpenAICompatAdapter, RuntimeCore } from '../src/runtime-core/llm.ts'
import { chatStep } from '../src/runtime-core/chatStep.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'
import { runTurn } from '../src/loop/stop.ts'
import { Context } from '../src/kernel/context.ts'
import { SessionLog } from '../src/session/log.ts'
import { mergeLlmConfig, loadCarConfig } from '../src/load/config.ts'
import { doctorModelReadiness } from '../src/dx/doctor.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s31-${name}-`))
  try {
    const r = fn(dir)
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } }
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
    return Promise.resolve()
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
    throw e
  }
}

/** SSE 流响应（openai-compat 形态） */
function sse(chunks: object[]): string {
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const TOOL_CALL_SSE = (name: string, argsJson: string, id: string) => sse([
  { choices: [{ delta: { role: 'assistant', content: '' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: argsJson.slice(0, 3) } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(3) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
])
const TEXT_SSE = (text: string) => sse([
  { choices: [{ delta: { role: 'assistant', content: '' } }] },
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
])

/** 本地假 OpenAI 兼容服务：捕获请求体，按脚本回放 SSE */
function fakeOpenAI(script: Array<(body: any) => string>): Promise<{ server: Server; url: string; bodies: any[]; headers: any[]; done: Promise<void> }> {
  const bodies: any[] = []
  const headers: any[] = []
  let idx = 0
  let finish: (v: void) => void = () => {}
  const done = new Promise<void>(r => { finish = r })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      headers.push(req.headers)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const step = script[Math.min(idx, script.length - 1)]
      idx++
      res.end(step(bodies[bodies.length - 1]))
      if (idx >= script.length) finish()
    })
  })
  const url = new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)))
  return url.then(u => ({ server, url: u, bodies, headers, done }))
}

// ==================== S1：声明面统一 ====================

test('S31: toToolDefinitions——description/parameters 透传 + T-22 缺省 write 收口 + 声明面=授权面', () => {
  const map = new Map<string, any>([
    ['full', { declaredSideEffect: 'readonly' as const, run: async () => 1, description: '读工具', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    ['bare', { declaredSideEffect: 'write' as const, run: async () => 2 }],
  ])
  const defs = toToolDefinitions(map)
  assert.deepEqual(defs, [
    { name: 'full', description: '读工具', parameters: { type: 'object', properties: { q: { type: 'string' } } }, declaredSideEffect: 'readonly' },
    { name: 'bare', declaredSideEffect: 'write' },
  ])
  // declaredSideEffect 不出站的口径由 llm.ts 出站映射承载（llm.ts:237 只带 name/description/parameters）
})

// ==================== S2：system 落链 ====================

test('S31: system 事件——落链 → deriveMessages 投影 role:system（§3.5.5 新可见输入 = 新事件类型）', () => {
  const log = new SessionLog('S-sys-1')
  log.append('runtime', 'system', 'system', '你是测试助手')
  log.append('user', 'user', 'T0', 'hi')
  const msgs = log.deriveMessages()
  assert.deepEqual(msgs[0], { role: 'system', content: '你是测试助手' })
  assert.equal(log.verifyChain(), null, '哈希链含 system 事件仍完整')
  assert.equal(log.assertModelVisibleLogged().ok, true, 'N1 含 system 事件成立')
})

// ==================== S3：llm.* 配置通道 ====================

test('S31: llm.* 配置——校验 fail-visible / 优先级 flag > env > config / CAR_LLM_* env 通道', () => {
  withTempDir('llm-config', dir => {
    // 未知键 / 类型错 fail-visible
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ llm: { temperature: 0.7 } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'bad.json') }).error!, /未知键 llm\.temperature/)
    writeFileSync(join(dir, 'bad2.json'), JSON.stringify({ llm: { maxTokens: 1.5 } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'bad2.json') }).error!, /llm\.maxTokens 必须为正整数/)
    // 有效配置
    const good = join(dir, 'good.json')
    writeFileSync(good, JSON.stringify({ llm: { baseUrl: 'https://cfg.example/v1', model: 'cfg-model', maxTokens: 100, allowEnvFallback: true } }))
    const cfg = loadCarConfig({ explicitPath: good }).config
    // 优先级：config < env < flag
    const c = mergeLlmConfig({}, cfg)
    assert.equal(c.baseUrl, 'https://cfg.example/v1')
    assert.equal(c.model, 'cfg-model')
    assert.equal(c.allowEnvFallback, true)
    const e = mergeLlmConfig({ CAR_LLM_BASE_URL: 'https://env.example/v1', CAR_LLM_MODEL: 'env-model' }, cfg)
    assert.equal(e.baseUrl, 'https://env.example/v1')
    assert.equal(e.model, 'env-model')
    const f = mergeLlmConfig({ CAR_LLM_MODEL: 'env-model' }, cfg, { baseUrl: 'https://flag.example/v1', model: 'flag-model', maxTokens: 7 })
    assert.equal(f.baseUrl, 'https://flag.example/v1')
    assert.equal(f.model, 'flag-model')
    assert.equal(f.maxTokens, 7)
    // CAR_ALLOW_ENV_CREDENTIALS 显式意见压过配置（=0 关）
    assert.equal(mergeLlmConfig({ CAR_ALLOW_ENV_CREDENTIALS: '0' }, cfg).allowEnvFallback, false)
  })
})

test('S31: doctorModelReadiness——configured/not-found/env 三态（值不打印红线）', () => {
  withTempDir('doctor-model', dir => {
    const d1 = doctorModelReadiness({ env: {}, cwd: dir })
    assert.equal(d1.configured, false)
    assert.equal(d1.credential, 'not-found')
    assert.match(d1.detail, /未配置/)
    const d2 = doctorModelReadiness({
      env: { CAR_LLM_BASE_URL: 'https://x/v1', CAR_LLM_MODEL: 'm', OPENAI_API_KEY: 'sk-test-only-not-a-real-key-123456', CAR_ALLOW_ENV_CREDENTIALS: '1' },
      cwd: dir,
    })
    assert.equal(d2.configured, true)
    assert.equal(d2.credential, 'env')
    assert.equal(d2.envFallback, 'on')
    assert.equal(d2.detail.includes('sk-test-only-not-a-real-key'), false, '凭据值永不打印')
  })
})

// ==================== S4：D-12a + 取消 + CarM8Error ====================

test('S31: D-12a loopback 豁免——http 仅 127.0.0.1/localhost/[::1]；非 loopback http 拒绝', () => {
  assert.ok(createOpenAICompatAdapter({ baseUrl: 'http://127.0.0.1:1234/v1' }), 'loopback http 允许')
  assert.ok(createOpenAICompatAdapter({ baseUrl: 'http://localhost:1234/v1' }), 'localhost http 允许')
  assert.ok(createOpenAICompatAdapter({ baseUrl: 'http://[::1]:1234/v1' }), 'IPv6 loopback http 允许')
  assert.throws(() => createOpenAICompatAdapter({ baseUrl: 'http://10.0.0.1:8080/v1' }), /CAR-E-LLM-TLS/, '非 loopback http 拒绝')
  assert.throws(() => createOpenAICompatAdapter({ baseUrl: 'http://example.com/v1' }), /CAR-E-LLM-TLS/)
  assert.ok(createOpenAICompatAdapter({ baseUrl: 'https://api.example.com/v1' }), 'https 任意域允许')
})

test('S31: 取消（D-19）——TurnAborted 首次实抛：pre-aborted 走 finish 前检查；runTurn 收口 aborted', async () => {
  await withTempDir('cancel', async dir => {
    const log = new SessionLog('S-cancel')
    log.append('runtime', 'system', 'system', 'sys')
    log.append('user', 'user', 'T0', 'hi')
    const core = new RuntimeCore()
    const signal = { aborted: true }  // pre-aborted：适配器 attempt 前静默收口（零 chunk）
    const tools = new Map<string, any>([['t', { declaredSideEffect: 'readonly', run: async () => 'ok' }]])
    // pre-aborted：适配器 attempt 前静默收口（零 chunk）→ chatStep finish 检查前抛 TurnAborted
    const adapter = createOpenAICompatAdapter({ baseUrl: 'http://127.0.0.1:1/v1', fetchImpl: (async () => { throw new Error('不应发起请求') }) as typeof fetch })
    core.registerLlmAdapter(adapter)
    const r = await runTurn({
      log, turnId: 'T0', tools, signal,
      model: () => chatStep({ core, log, turnId: 'T0', model: 'm', tools: toToolDefinitions(tools), signal }),
    })
    assert.equal(r.reason, 'aborted', 'runTurn 既有 catch 收口 aborted')
    const turnEnd = log.events.find(e => e.kind === 'turnEnd')!
    assert.equal((turnEnd.meta as any)?.reason, 'aborted')
    assert.equal(log.events.some(e => e.kind === 'assistant'), false, '无半截 assistant 落链')
  })
})

test('S31: CarM8Error 保形——A080001 code/userHint/retryable 进 turnEnd（引导文案可达用户）', async () => {
  await withTempDir('m8-error', async dir => {
    const log = new SessionLog('S-m8err')
    log.append('user', 'user', 'T0', 'hi')
    const cred = new CredentialService()
    const core = new RuntimeCore(cred)
    core.registerLlmAdapter(createOpenAICompatAdapter({ baseUrl: 'http://127.0.0.1:1/v1', credentials: cred, provider: 'openai-compat' }))
    const r = await runTurn({
      log, turnId: 'T0',
      tools: new Map<string, any>(),
      model: () => chatStep({ core, log, turnId: 'T0', model: 'm', tools: [] }),
    })
    assert.equal(r.reason, 'error')
    const turnEnd = log.events.find(e => e.kind === 'turnEnd')!
    const meta = turnEnd.meta as any
    assert.equal(meta.code, 'A080001')
    assert.match(meta.userHint, /car doctor/, '引导文案进 turnEnd（1.4 前被 String(e) 拍平）')
    assert.equal(meta.retryable, false)
  })
})

// ==================== S5：多步真 E2E（真 HTTP + 真装配） ====================

test('S31: 多步真 E2E——system 出站 / 工具 schema 出站 / Bearer 凭据 / 第二请求含 toolResult / 声明面=授权面', async () => {
  await withTempDir('multistep', async dir => {
    const { server, url, bodies, headers, done } = await fakeOpenAI([
      () => TOOL_CALL_SSE('echo_tool', '{"text":"hi"}', 'call_1'),
      () => TEXT_SSE('完成了'),
    ])
    try {
      const log = new SessionLog('S-e2e')
      log.append('runtime', 'system', 'system', '你是集成测试助手')
      log.append('user', 'user', 'T0', '请调用 echo_tool')
      const cred = new CredentialService({ keychainReader: s => (s === 'car-runtime/openai-compat' ? 'test-key-123' : null) })
      const core = new RuntimeCore(cred)
      const ctx = new Context()
      core.bindContext(ctx)
      core.registerLlmAdapter(createOpenAICompatAdapter({
        baseUrl: url, credentials: cred, provider: 'openai-compat',
      }), { default: true })
      const tools = new Map<string, any>([[
        'echo_tool',
        { declaredSideEffect: 'readonly', description: '回声工具', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, run: async (a: any) => 'echo:' + a.text },
      ]])
      const r = await runTurn({
        log, turnId: 'T0', tools,
        model: () => chatStep({ core, log, turnId: 'T0', model: 'test-model', tools: toToolDefinitions(tools) }),
      })
      assert.equal(r.reason, 'completed')
      assert.equal(r.steps, 2, '两步：toolUse → 工具执行 → stop')
      await done
      // 请求 1：system 消息出站（§3.5.5）+ 工具 schema 出站 + Bearer 凭据
      assert.equal(bodies[0].messages[0].role, 'system')
      assert.equal(bodies[0].messages[0].content, '你是集成测试助手')
      assert.equal(bodies[0].tools.length, 1)
      assert.equal(bodies[0].tools[0].function.name, 'echo_tool')
      assert.deepEqual(bodies[0].tools[0].function.parameters, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
      assert.equal(bodies[0].tools[0].function.description, '回声工具')
      assert.equal(headers[0].authorization, 'Bearer test-key-123', '凭据经 CredentialService→Bearer')
      assert.equal(JSON.stringify(bodies[0]).includes('test-key-123'), false, '凭据值不出站到消息体')
      // 请求 2：第二请求含 toolResult 消息（executeBatch 落链 → 投影 → 出站）
      const toolMsg = bodies[1].messages.find((m: any) => m.role === 'tool')
      assert.ok(toolMsg, '第二请求含 tool 消息')
      assert.equal(toolMsg.tool_call_id, 'call_1')
      assert.equal(toolMsg.content, '"echo:hi"')
      // 落链面：assistant/toolCall/toolResult 齐备（N1）
      assert.equal(log.assertModelVisibleLogged().ok, true)
      const final = log.deriveMessages().at(-1)!
      assert.equal(final.role, 'assistant')
      assert.equal(final.content, '完成了')
      void server
    } finally {
      server.close()
      await done
    }
  })
})
test('S31: spawn CLI 全链——car run 真路径（--prompt/--base-url/--model + env 凭据）+ 无配置 exit 2', async () => {
  await withTempDir('cli-real', async dir => {
    const plugin = `export const manifest = { name: 'p', version: '1.0.0' }\n` +
      `export default function apply(api) {\n` +
      `  api.registerTool({ name: 'echo_tool', description: '回声工具', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, declaredSideEffect: 'readonly', run: async (a) => 'echo:' + a.text })\n` +
      `}\n`
    writeFileSync(join(dir, 'p.ts'), plugin)
    const bodies: any[] = []
    let n = 0
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        bodies.push(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(n++ === 0 ? TOOL_CALL_SSE('echo_tool', '{"text":"hi"}', 'call_1') : TEXT_SSE('完成了'))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', 'p.ts',
      '--prompt', 'call echo_tool with text hi', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'cli-model',
      '--system', '你是 CLI 集成测试助手'], {
      cwd: dir,
      env: { ...process.env, OPENAI_API_KEY: 'test-key-123', CAR_ALLOW_ENV_CREDENTIALS: '1' },
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
    // system 出站（--system flag > 插件 setSystemPrompt）
    assert.equal(bodies[0].messages[0].role, 'system')
    assert.equal(bodies[0].messages[0].content, '你是 CLI 集成测试助手')
    assert.equal(bodies[0].tools[0].function.name, 'echo_tool')
    assert.match(out, /回放|投影/)

    // 无模型配置 → exit 2 显式引导（D-13）
    const noCfg = await new Promise<{ code: number; stderr: string }>(resolve => {
      const c2 = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', 'p.ts'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      let e2 = ''
      c2.stderr.on('data', d => { e2 += d })
      c2.on('exit', c => resolve({ code: c ?? -1, stderr: e2 }))
    })
    assert.equal(noCfg.code, 2)
    assert.match(noCfg.stderr, /CAR-E-LLM-CONFIG/)
    assert.match(noCfg.stderr, /--demo/, '引导至演示流')
  })
})
