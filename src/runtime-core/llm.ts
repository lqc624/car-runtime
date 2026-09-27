/**
 * M8 · LLM 适配面（chat / registerLlmAdapter ——《系统设计》§3.2.M8.2 模型与适配行 / SQ-07 / O-11）
 *
 * 口径：
 *  - 适配器为 ACL（C-02）：统一 LlmAdapter 签名消解 Provider 差异；注册经 ctx.effect 可逆
 *    （disposeRuntime 回卷后可重注册——注册即逆变换，POC-2 红线同源）；重复 id 显式报错禁静默覆盖；
 *  - finishReason 不可变透传（ADR-001 / SR-17）：SDK 边界流包装做防御性断言——首个
 *    finishReason 定格，冲突 = 适配器契约违规显式抛错（改写/吞没均禁止，缺失触发 AL-05 口径）；
 *  - 重试基线（§3.5.4）：仅网络错误/429/5xx、≤2 次、指数退避 1s/2s；**首块前失败才可重试**
 *    （已消费的 chunk 不可重放——重试不产生额外副作用）；重试耗尽 = CarM8Error B080001
 *    （BD-04 error 收口由消费方 runTurn 落 turnEnd）；流中途失败 = finishReason 'error' chunk；
 *  - 超时基线：总 120s / 首字节 30s（均可注入缩短供测试）；TLS 强制（https-only）；
 *  - declaredSideEffect 不出站（权限面只进权限门，不进模型请求体）。
 */
import { CarM8Error, providerUnreachable } from './errors.ts'
import { CredentialService } from './credentials.ts'
import type { Disposable, LlmAdapter, LlmChunk, LlmRequest, ToolCallDelta } from './types.ts'
import type { PluginContext } from '../kernel/context.ts'

// ==================== 适配器注册表（registerLlmAdapter） ====================

export class AdapterRegistry {
  #adapters = new Map<string, LlmAdapter>()
  #defaultId: string | null = null

  /** 注册（幂等语义：同 id 重复注册显式报错——冲突链定位风格） */
  register(adapter: LlmAdapter, opts: { default?: boolean } = {}): Disposable {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`CAR-E-LLM-DUP: LLM adapter "${adapter.id}" already registered (duplicate registration is blocked)`)
    }
    this.#adapters.set(adapter.id, adapter)
    if (opts.default || this.#defaultId === null) this.#defaultId = adapter.id
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return // 幂等回卷（二次 dispose 静默收敛，登记口径）
        disposed = true
        this.#adapters.delete(adapter.id)
        if (this.#defaultId === adapter.id) this.#defaultId = this.#adapters.keys().next().value ?? null
      },
    }
  }

  /** 解析：显式 id > 默认适配器；无可用适配器显式报错（禁静默降级） */
  get(id?: string): LlmAdapter {
    const target = id ?? this.#defaultId
    if (!target || !this.#adapters.has(target)) {
      const available = [...this.#adapters.keys()].join(', ') || '无'
      throw new Error(`CAR-E-LLM-NOADAPTER: LLM adapter "${target ?? '<default>'}" not registered（在册：${available}）`)
    }
    return this.#adapters.get(target)!
  }

  list(): Array<{ id: string; isDefault: boolean }> {
    return [...this.#adapters.keys()].map(id => ({ id, isDefault: id === this.#defaultId }))
  }
}

// ==================== finishReason 不可变守卫（SDK 边界） ====================

/** 首个 finishReason 定格；适配器后续给出不同值 = 契约违规显式抛错（不改写不吞没） */
export async function* withFinishReasonGuard(stream: AsyncIterable<LlmChunk>): AsyncIterable<LlmChunk> {
  let settled: LlmChunk['finishReason'] | undefined
  for await (const chunk of stream) {
    if (chunk.finishReason !== undefined) {
      if (settled === undefined) settled = chunk.finishReason
      else if (settled !== chunk.finishReason) {
        throw new Error(`CAR-E-LLM-FINISH: finishReason 已定格为 "${settled}"，适配器试图给出 "${chunk.finishReason}"（不可变透传契约违规）`)
      }
    }
    yield chunk
  }
}

// ==================== RuntimeCore（M8 SDK 面） ====================

export class RuntimeCore {
  readonly registry = new AdapterRegistry()
  readonly credentials: CredentialService
  #ctx: Pick<PluginContext, 'provide' | 'effect'> | null = null

  constructor(credentials: CredentialService = new CredentialService()) {
    this.credentials = credentials
  }

  /** 绑定插件作用域：服务注册 + 适配器注册进入 Effect 可逆通道（宿主传 Context——根作用域 effect 同纪律） */
  bindContext(ctx: Pick<PluginContext, 'provide' | 'effect'>): void {
    this.#ctx = ctx
    ctx.provide('runtime-core', this)
  }

  /** §3.2.M8.2：registerLlmAdapter(adapter): Disposable——Effect 可逆（卸载回卷后可重注册） */
  registerLlmAdapter(adapter: LlmAdapter, opts: { default?: boolean } = {}): Disposable {
    if (!this.#ctx) return this.registry.register(adapter, opts)
    let handle: Disposable | null = null
    this.#ctx.effect(() => {
      handle = this.registry.register(adapter, opts)
      return () => handle?.dispose()
    }, `llm-adapter:${adapter.id}`)
    return { dispose: () => handle?.dispose() }
  }

  /** §3.2.M8.2：chat(req): AsyncIterable<LlmChunk>——统一入口 + finishReason 守卫 */
  chat(req: LlmRequest): AsyncIterable<LlmChunk> {
    const adapter = this.registry.get(req.adapterId)
    return withFinishReasonGuard(adapter.chat(req))
  }
}

// ==================== 内置 openai-compat 适配器（流式 SSE） ====================

export interface OpenAICompatOptions {
  id?: string
  baseUrl: string
  /** 凭据服务与 provider 名（Bearer token 来源） */
  credentials?: CredentialService
  provider?: string
  fetchImpl?: typeof fetch
  /** §3.5.4 基线：总 120s / 首字节 30s / 2 次退避 1s-2s（测试可注入缩短） */
  timeoutMs?: number
  firstByteMs?: number
  retries?: number
  backoffMs?: number[]
  /** 测试注入睡眠（退避可观测；缺省真实定时器） */
  sleep?: (ms: number) => Promise<void>
}

const FINISH_MAP: Record<string, LlmChunk['finishReason']> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'toolUse',
  function_call: 'toolUse',
  content_filter: 'aborted',
}

class Retryable extends Error {}

/** 明文 SSE → LlmChunk 流解析（增量容错：半行驻留到下一 chunk） */
async function* parseSseStream(body: AsyncIterable<Uint8Array>): AsyncIterable<LlmChunk> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const bytes of body) {
    buf += decoder.decode(bytes, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      if (!data) continue
      let evt: any
      try { evt = JSON.parse(data) } catch { continue } // 心跳/注释行容错（显式跳过非 JSON data）
      const choice = evt.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      const raw = choice.finish_reason
      const finish: LlmChunk['finishReason'] | undefined = raw == null ? undefined : (() => {
        const mapped = FINISH_MAP[String(raw)]
        return mapped
          ? mapped
          : 'error' // 未映射信号 fail-visible（禁静默改写），raw 附在 error.message
      })()
      const toolCallDeltas: ToolCallDelta[] = Array.isArray(delta.tool_calls)
        ? delta.tool_calls.map((tc: any) => ({
            index: tc.index,
            id: tc.id,
            name: tc.function?.name ?? tc.name,
            argumentsDelta: tc.function?.arguments,
          }))
        : []
      const text = typeof delta.content === 'string' && delta.content.length ? delta.content : undefined
      // LlmChunk 单 toolCallDelta 口径：同事件多条 tool_calls 顺序展开为多 chunk
      if (!text && !toolCallDeltas.length && finish === undefined) continue
      if (toolCallDeltas.length === 0) {
        yield {
          ...(text !== undefined ? { delta: text } : {}),
          ...(finish !== undefined
            ? { finishReason: finish, ...(finish === 'error' ? { error: { code: 'B080001', message: `未映射的 finish_reason "${raw}"` } } : {}) }
            : {}),
        }
      } else {
        for (let i = 0; i < toolCallDeltas.length; i++) {
          const last = i === toolCallDeltas.length - 1
          yield {
            ...(i === 0 && text !== undefined ? { delta: text } : {}),
            toolCallDelta: toolCallDeltas[i],
            ...(last && finish !== undefined
              ? { finishReason: finish, ...(finish === 'error' ? { error: { code: 'B080001', message: `未映射的 finish_reason "${raw}"` } } : {}) }
              : {}),
          }
        }
      }
    }
  }
}

export function createOpenAICompatAdapter(opts: OpenAICompatOptions): LlmAdapter & { id: string } {
  const id = opts.id ?? 'openai-compat'
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  if (!baseUrl.startsWith('https://')) {
    // 1.4-S4（D-12a，1.2 规划期裁决）：http 仅豁免 loopback——本地模型服务（Ollama 等）与
    // 本地 E2E；非回环地址维持 TLS 强制（§3.2.M8.4）。豁免集显式列举，不扩大到局域网。
    let loopback = false
    try { const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''); loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' } catch { /* 解析失败 = 非法 URL，按非回环拒绝 */ }
    if (!loopback) {
      throw new Error(`CAR-E-LLM-TLS: baseUrl 必须 https（TLS 强制，§3.2.M8.4）；http 仅豁免 loopback（127.0.0.1/[::1]/localhost，D-12a）——远程明文部署请经 TLS 代理或自建适配器`)
    }
  }
  const url = `${baseUrl}/chat/completions`
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const timeoutMs = opts.timeoutMs ?? 120_000
  const firstByteMs = opts.firstByteMs ?? 30_000
  const retries = opts.retries ?? 2
  const backoffMs = opts.backoffMs ?? [1_000, 2_000]

  const toOpenAI = (req: LlmRequest, apiKey: string) => ({
    // 1.4-BUG-1：method: 'POST' 缺失——M8 最小实现潜伏缺陷（注入式 fetch 的单测忽略 method，
    // 真 undici 对 GET+body 直接拒绝）；car run 真路径接线时暴露（生产调用点核查产出）
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      stream: true,
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
      messages: req.messages.map(m => {
        if (m.role === 'toolResult') {
          const p = m.content as { id?: string; result?: unknown; error?: string }
          return { role: 'tool', tool_call_id: p?.id, content: p?.error ?? JSON.stringify(p?.result ?? null) }
        }
        if (m.role === 'assistant' && m.content != null && typeof m.content === 'object' && 'toolCall' in (m.content as object)) {
          const tc = (m.content as { toolCall: { id: string; tool: string; args: unknown } }).toolCall
          return {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.tool, arguments: JSON.stringify(tc.args ?? {}) } }],
          }
        }
        return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
      }),
      // declaredSideEffect 不出站：权限面只进权限门（§3.2.M8.3 字段表约束方向）
      ...(req.tools.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    }),
  })

  return {
    id,
    async *chat(req: LlmRequest): AsyncIterable<LlmChunk> {
      // 凭据门：resolve → reveal（SQ-07 凭据解析；A080001 在此抛出——首块前，runTurn 可 error 收口）
      let apiKey = ''
      if (opts.credentials) {
        const ref = opts.credentials.resolve(opts.provider ?? id, {})
        apiKey = opts.credentials.reveal(ref, {})
      }
      const payload = toOpenAI(req, apiKey)

      for (let attempt = 0; ; attempt++) {
        // 1.4-S4（D-19）：外部取消 ≠ 失败——attempt 前检查，静默收口（无 chunk、无 retry）
        if (req.signal?.aborted) return
        const controller = new AbortController()
        const started = Date.now()
        let firstByteSeen = false
        const firstByteTimer = setTimeout(() => controller.abort(), firstByteMs)
        const overallTimer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const res = await fetchImpl(url, { ...payload, signal: controller.signal })
          if (res.status === 429 || res.status >= 500) throw new Retryable(`HTTP ${res.status}`)
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            // 4xx 业务错不重试（§3.5.4）；错误信息不含凭据（Bearer 值不进错误路径）
            yield { finishReason: 'error', error: { code: 'B080001', message: `provider HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}` } }
            return
          }
          if (!res.body) throw new Retryable('响应无 body 流')
          let sawFinish = false
          for await (const chunk of parseSseStream(res.body)) {
            // 1.4-S4（D-19）：chunk 间隙检查取消——abort 连接并静默收口（不产 error chunk，
            // 不违反 finishReason 不可变；上层 chatStep 以自身 signal 检查抛 TurnAborted）
            if (req.signal?.aborted) { controller.abort(); return }
            if (!firstByteSeen) { firstByteSeen = true; clearTimeout(firstByteTimer) }
            if (chunk.finishReason !== undefined) sawFinish = true
            yield chunk
          }
          // 流自然结束但未给 finishReason = 异常终止（AL-05 口径：缺失显式化，禁吞没）；
          // 已携带 finishReason 的流原样收口——兜底不得追加（M8-BUG-1：无条件 error chunk
          // 会污染成功流并触发 finishReason 守卫冲突；成功流零 error chunk 由 s25 断言钉死）
          if (!sawFinish) {
            yield { finishReason: 'error', error: { code: 'B080001', message: '流结束未携带 finish_reason（AL-05）' } }
          }
          return
        } catch (e) {
          // 1.4-S4（D-19）：外部取消（abort 连锁的 fetch 异常）≠ 失败——静默收口，不走 retry
          if (req.signal?.aborted) return
          const beforeFirstByte = !firstByteSeen
          clearTimeout(firstByteTimer)
          // 首块前失败 = 网络错误/429/5xx/首字节超时（§3.5.4 重试条件全集）——未消费任何
          // chunk，请求体可重放，重试不产生额外副作用；流中途失败不可重放（chunk 已消费）
          if (beforeFirstByte && attempt < retries) {
            await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]!)
            continue
          }
          if (beforeFirstByte) {
            // 重试耗尽 → B080001（BD-04：消费方 runTurn 以 error 收口）
            throw providerUnreachable(`${(e as Error).name}: ${(e as Error).message}（尝试 ${attempt + 1}/${retries + 1}，${Date.now() - started}ms）`)
          }
          // 流中途失败：已消费 chunk 不可重放 → error chunk 收口
          yield { finishReason: 'error', error: { code: 'B080001', message: `流中途失败：${(e as Error).message}` } }
          return
        } finally {
          clearTimeout(firstByteTimer)
          clearTimeout(overallTimer)
        }
      }
    },
  }
}
