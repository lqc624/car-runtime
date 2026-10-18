/**
 * 1.14-S4 · K-POOL-1 模型池网关（D-42：登记 + health 探测 + fallback 链 + retry 策略 + routing/decide 落链）
 *
 * 口径：
 *  - 候选序 = priority 升序（缺省 0）→ weight 降序（缺省 0；D-42：weight 仅作排序 tie-break，
 *    不做负载均衡调度）→ 登记序（稳定排序）；
 *  - health 预检（doctor 面同款口径——值不打印）：GET {baseUrl}/models（openai）/
 *    {baseUrl}/v1/models（anthropic）；**任意 HTTP 状态码 = 传输可达（健康）**——404/401 ≠ 不健康
 *    （真实连通性以发消息为准，doctor 先例）；网络层失败/超时 = 不健康（按序跳过，fail-visible
 *    落 routing/decide attempts）；结果 TTL 缓存（防死主端点每请求烧重试预算）；probeImpl 测试注入缝；
 *  - fallback 链 = **首块前失败才可降级**（已消费 chunk 不可重放——llm.ts §3.5.4 同红线）：
 *    成员请求抛错（网络/429/5xx 重试耗尽/凭据缺失）或首 chunk 即 error chunk（4xx 业务错，零内容
 *    消费）→ 按序降级下一候选；流中途失败 = error chunk 原样收口不降级；
 *  - retry 策略 = 成员级重试（§3.5.4 基线，装配层透传）+ 池级 maxAttempts 候选请求尝试上限
 *    （缺省 = 端点数；耗尽 = providerUnreachable B080001——runTurn 以 error 收口）；
 *  - **routing/decide 审计事件**：每次决策一条（payload.type='decide'：selected/reason/retries/
 *    attempts）——onDecide 回调由宿主接线 SessionLog.append（事件链只追加红线；禁静默换模型）；
 *    retries = 发起请求且失败的候选数（健康跳过不计，attempts 全量在册）；
 *  - 成员请求 req.model/maxTokens 按成员改写（成员适配器消费自身 model——usage 按成员模型落账）；
 *  - 无池配置 = 行为与 1.13 逐字节一致（兼容验收线——池路由零介入）；
 *  - 明文凭据红线：成员凭据仅收 keyEnv env 变量名引用（config schema 明文键显式拒绝，CR-05）。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ModelPoolConfig } from './config.ts'
import { createAnthropicAdapter, createOpenAICompatAdapter } from '../runtime-core/llm.ts'
import { CredentialService } from '../runtime-core/credentials.ts'
import { providerUnreachable } from '../runtime-core/errors.ts'
import type { LlmAdapter, LlmChunk, LlmRequest } from '../runtime-core/types.ts'

/** 池成员（解析后形态——id 缺省已派生；候选序已定） */
export interface PoolMember {
  id: string
  baseUrl: string
  model: string
  adapterId: 'openai-compat' | 'anthropic'
  keyEnv?: string
  maxTokens?: number
  priority?: number
  weight?: number
}

/** 候选序：priority 升序（缺省 0）→ weight 降序（缺省 0，D-42 tie-break）→ 登记序（稳定） */
export function orderPoolMembers(members: PoolMember[]): PoolMember[] {
  return members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.priority ?? 0) - (b.m.priority ?? 0) || (b.m.weight ?? 0) - (a.m.weight ?? 0) || a.i - b.i)
    .map(x => x.m)
}

/** config modelPool → 池成员（id 缺省 ep-1..N 派生；重复 id 显式拒绝；候选序就位） */
export function resolveModelPoolMembers(pool: ModelPoolConfig): { members: PoolMember[]; error?: string } {
  const seen = new Set<string>()
  const members: PoolMember[] = []
  for (const [i, ep] of pool.endpoints.entries()) {
    const id = ep.id ?? `ep-${i + 1}`
    if (seen.has(id)) {
      return { members: [], error: `CAR-E-CONFIG: 模型池端点 id "${id}" 重复（routing/decide 落链定位歧义禁入）` }
    }
    seen.add(id)
    members.push({
      id,
      baseUrl: ep.baseUrl,
      model: ep.model,
      adapterId: ep.adapterId ?? 'openai-compat',
      ...(ep.keyEnv !== undefined ? { keyEnv: ep.keyEnv } : {}),
      ...(ep.maxTokens !== undefined ? { maxTokens: ep.maxTokens } : {}),
      ...(ep.priority !== undefined ? { priority: ep.priority } : {}),
      ...(ep.weight !== undefined ? { weight: ep.weight } : {}),
    })
  }
  return { members: orderPoolMembers(members) }
}

// ==================== health 预检（doctor 面同款口径） ====================

export interface PoolMemberHealth {
  /** 传输可达（任意 HTTP 状态码）= true；网络层失败/超时 = false */
  ok: boolean
  status?: number
  latencyMs: number
  /** 不健康原因类别（值不打印纪律——只出类别） */
  errorCategory?: string
}

/** node:http(s) GET 状态码（1.8-BUG-1 出站通道口径——全局 fetch/undici win32 退出断言预防） */
function httpGetStatus(url: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
      const req = mod(u, { method: 'GET', headers: { accept: 'application/json' } }, res => {
        res.resume() // 排干 body——连接收口
        resolve(res.statusCode ?? 0)
      })
      const onAbort = () => { try { req.destroy(new Error('aborted')) } catch { /* 已完成 */ } }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      req.on('error', reject)
      req.end()
    } catch (e) { reject(e) }
  })
}

/** 单端点 health 探测（doctor/池预检复用；值不打印——只出状态/延迟/类别） */
export async function probePoolMember(
  member: Pick<PoolMember, 'baseUrl' | 'adapterId'>,
  opts: { timeoutMs?: number } = {},
): Promise<PoolMemberHealth> {
  const base = member.baseUrl.replace(/\/+$/, '')
  const url = member.adapterId === 'anthropic' ? `${base}/v1/models` : `${base}/models`
  const t0 = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000)
  try {
    const status = await httpGetStatus(url, controller.signal)
    return { ok: true, status, latencyMs: Date.now() - t0 }
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError' || String((e as Error).message).includes('aborted')
    return { ok: false, latencyMs: Date.now() - t0, errorCategory: aborted ? 'timeout' : 'network-error' }
  } finally {
    clearTimeout(timer)
  }
}

// ==================== 路由引擎（fallback 链 + retry 上限 + routing/decide） ====================

/** 逐候选结果（attempts 全量在册——健康跳过与请求失败都显性化） */
export interface RoutingAttempt {
  id: string
  outcome: 'selected' | 'failed' | 'skipped-unhealthy'
  /** 失败/跳过类别（错误码/名称，值不打印） */
  detail?: string
}

/** 路由决策（routing/decide 事件 payload 源——每次请求一条） */
export interface RoutingDecision {
  /** 选中端点 id（耗尽 = null） */
  selected: string | null
  /** 首位候选选中 = primary；降级选中 = fallback；全部不可用 = exhausted */
  reason: 'primary' | 'fallback' | 'exhausted'
  /** 降级重试次数 = 发起请求且失败的候选数（健康跳过不计——attempts 全量在册） */
  retries: number
  attempts: RoutingAttempt[]
  turnId?: string
  sessionId?: string
}

export interface PoolAdapterOptions {
  id?: string
  /** 成员与适配器（装配层产出的候选序） */
  members: Array<{ member: PoolMember; adapter: LlmAdapter }>
  /** health 预检（enabled 缺省 true；probeImpl 测试注入缝——缺省真实 GET 探测） */
  probe?: { enabled?: boolean; timeoutMs?: number; ttlMs?: number; probeImpl?: typeof probePoolMember }
  /** 候选请求尝试上限（缺省 = 成员数） */
  maxAttempts?: number
  /** routing/decide 审计回调（宿主接线 SessionLog.append——禁静默换模型红线） */
  onDecide?: (d: RoutingDecision) => void
}

const errorCategory = (e: unknown): string => {
  const err = e as { slug?: string; name?: string }
  return err.slug ?? err.name ?? 'unknown'
}

export function createModelPoolAdapter(opts: PoolAdapterOptions): LlmAdapter & { id: string; members: PoolMember[] } {
  const ordered = opts.members
  const maxAttempts = opts.maxAttempts ?? ordered.length
  const probeEnabled = opts.probe?.enabled !== false
  const probeFn = opts.probe?.probeImpl ?? probePoolMember
  const probeTimeoutMs = opts.probe?.timeoutMs ?? 4000
  const ttlMs = opts.probe?.ttlMs ?? 30_000
  const healthCache = new Map<string, { ok: boolean; at: number; category?: string }>()
  const id = opts.id ?? 'model-pool'

  const healthOf = async (m: PoolMember): Promise<{ ok: boolean; category?: string }> => {
    const hit = healthCache.get(m.id)
    if (hit && Date.now() - hit.at < ttlMs) {
      return { ok: hit.ok, ...(hit.category !== undefined ? { category: hit.category } : {}) }
    }
    const h = await probeFn(m, { timeoutMs: probeTimeoutMs })
    const entry = { ok: h.ok, at: Date.now(), ...(h.errorCategory !== undefined ? { category: h.errorCategory } : {}) }
    healthCache.set(m.id, entry)
    return { ok: entry.ok, ...(entry.category !== undefined ? { category: entry.category } : {}) }
  }

  const withMeta = (d: Omit<RoutingDecision, 'turnId' | 'sessionId'>, req: LlmRequest): RoutingDecision => ({
    ...d,
    ...(req.metadata?.turnId !== undefined ? { turnId: req.metadata.turnId } : {}),
    ...(req.metadata?.sessionId !== undefined ? { sessionId: req.metadata.sessionId } : {}),
  })

  return {
    id,
    members: ordered.map(x => x.member),
    chat(req: LlmRequest): AsyncIterable<LlmChunk> {
      return (async function* () {
        const attempts: RoutingAttempt[] = []
        let failedCount = 0
        let requestAttempts = 0
        for (const [pos, entry] of ordered.entries()) {
          if (requestAttempts >= maxAttempts) break
          if (probeEnabled) {
            const h = await healthOf(entry.member)
            if (!h.ok) {
              attempts.push({ id: entry.member.id, outcome: 'skipped-unhealthy', ...(h.category !== undefined ? { detail: h.category } : {}) })
              continue
            }
          }
          requestAttempts++
          // 成员请求：req.model/maxTokens 按成员改写（usage 按成员模型落账）
          let it: AsyncIterator<LlmChunk>
          try {
            it = entry.adapter.chat({
              ...req,
              model: entry.member.model,
              ...(entry.member.maxTokens != null ? { maxTokens: entry.member.maxTokens } : {}),
            })[Symbol.asyncIterator]()
          } catch (e) {
            // 适配器同步抛错（契约违规/装配错误）= 候选不可用，降级下一候选
            attempts.push({ id: entry.member.id, outcome: 'failed', detail: errorCategory(e) })
            failedCount++
            continue
          }
          try {
            let first: IteratorResult<LlmChunk>
            try {
              first = await it.next()
            } catch (e) {
              // 首块前失败（网络/429/5xx 重试耗尽/凭据缺失）→ 降级下一候选
              attempts.push({ id: entry.member.id, outcome: 'failed', detail: errorCategory(e) })
              failedCount++
              continue
            }
            if (first.done || !first.value) {
              attempts.push({ id: entry.member.id, outcome: 'failed', detail: 'empty-stream' })
              failedCount++
              continue
            }
            const fc = first.value
            // 首 chunk 即 error chunk 且零内容消费（4xx 业务错）→ 候选不可用，降级（零 chunk 已出——可重放安全）
            const errorOnly = fc.finishReason === 'error' && fc.delta === undefined && fc.toolCallDelta === undefined
            if (errorOnly) {
              attempts.push({ id: entry.member.id, outcome: 'failed', detail: fc.error ? 'http-4xx' : 'error-chunk' })
              failedCount++
              continue
            }
            // 选中：routing/decide 落链（禁静默换模型——选中端点/原因/重试次数显性化）
            attempts.push({ id: entry.member.id, outcome: 'selected' })
            opts.onDecide?.(withMeta({
              selected: entry.member.id,
              reason: pos === 0 ? 'primary' : 'fallback',
              retries: failedCount,
              attempts,
            }, req))
            yield fc
            while (true) {
              const r = await it.next()
              if (r.done) break
              yield r.value // 流中途失败 = error chunk 原样收口（已消费 chunk 不可重放——不降级）
            }
            return
          } finally {
            // 成员迭代器收口（首 chunk 后未耗尽路径——4xx 降级/取消/异常；自然结束路径 no-op）
            await it.return?.(undefined)
          }
        }
        // 耗尽：决策落链 + B080001（runTurn error 收口——BD-04）
        opts.onDecide?.(withMeta({ selected: null, reason: 'exhausted', retries: failedCount, attempts }, req))
        const summary = attempts.map(a => `${a.id}:${a.outcome}${a.detail ? `(${a.detail})` : ''}`).join(', ') || '无候选'
        throw providerUnreachable(`模型池全部候选不可用（${summary}）`)
      })()
    },
  }
}

// ==================== 池装配层（config → 成员适配器 → 路由适配器） ====================

export interface ModelPoolAssemblyOptions {
  pool: ModelPoolConfig
  /** 共享凭据服务（成员级 keyEnv 经 credentialEnvVars 精确候选） */
  credentials?: CredentialService
  /** 测试注入（成员适配器 fetch/退避——缺省真实通道） */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  firstByteMs?: number
  retries?: number
  backoffMs?: number[]
  sleep?: (ms: number) => Promise<void>
  /** routing/decide 审计回调（透传路由引擎） */
  onDecide?: (d: RoutingDecision) => void
}

/** 池装配：config 解析（候选序/重复拒绝）→ 成员适配器（内置两族 + keyEnv）→ 路由适配器 */
export function assembleModelPool(opts: ModelPoolAssemblyOptions): {
  adapter: LlmAdapter & { id: string; members: PoolMember[] }
  members: PoolMember[]
} {
  const { members, error } = resolveModelPoolMembers(opts.pool)
  if (error) throw new Error(error)
  const entries = members.map(m => ({
    member: m,
    adapter: (m.adapterId === 'anthropic'
      ? createAnthropicAdapter({
          baseUrl: m.baseUrl,
          credentials: opts.credentials,
          ...(m.keyEnv !== undefined ? { credentialEnvVars: [m.keyEnv] } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.firstByteMs !== undefined ? { firstByteMs: opts.firstByteMs } : {}),
          ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
          ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}),
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
        })
      : createOpenAICompatAdapter({
          baseUrl: m.baseUrl,
          credentials: opts.credentials,
          provider: 'openai-compat',
          ...(m.keyEnv !== undefined ? { credentialEnvVars: [m.keyEnv] } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.firstByteMs !== undefined ? { firstByteMs: opts.firstByteMs } : {}),
          ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
          ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}),
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
        })),
  }))
  const adapter = createModelPoolAdapter({
    members: entries,
    probe: {
      ...(opts.pool.probe?.enabled !== undefined ? { enabled: opts.pool.probe.enabled } : {}),
      ...(opts.pool.probe?.timeoutMs !== undefined ? { timeoutMs: opts.pool.probe.timeoutMs } : {}),
      ...(opts.pool.probe?.ttlMs !== undefined ? { ttlMs: opts.pool.probe.ttlMs } : {}),
    },
    ...(opts.pool.maxAttempts !== undefined ? { maxAttempts: opts.pool.maxAttempts } : {}),
    ...(opts.onDecide ? { onDecide: opts.onDecide } : {}),
  })
  return { adapter, members }
}
