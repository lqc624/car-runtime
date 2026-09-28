/**
 * M8 · 遥测门面（getTracer/getMeter ——《系统设计》§3.2.M8.2 遥测行 / §3.2.M8.5 隐私三原则）
 *
 * 口径（§3.2.M8.5 关键约束，逐条落地）：
 *  - 默认关：无端点配置时不初始化任何 exporter——无配置 = noop 句柄 + 零出站（可机器断言）；
 *  - 显式开：用户配置端点即视为开启（CAR_OTEL_ENDPOINT 或显式 config 传入）；
 *  - 端点归用户：数据只发往用户自配 E-05；OTLP/HTTP JSON（node:http(s) 出站——1.4-BUG-2：全局
 *    fetch/undici 在 win32 进程退出时触发 libuv 断言崩溃），导出超时 5s；
 *    1.2-S3 生产级策略（D-12b 口径修订，2026-09-27）：**0 重试 → 有界重试 ≤2**（仅 429/5xx/
 *    网络错误，退避 1s/2s；4xx 业务错不重试）——重试耗尽静默丢弃 + droppedExports 计数，
 *    永不抛错（BD-05「不抛错、不落审计」收紧保持）；隐私三原则不变（数据仍只发用户自配端点）；
 *  - 采样（1.2-S3 加法）：head 采样于 span.end() 决策——always_on（缺省，全量，1.1 行为不变）/
 *    always_off / { ratio }（概率）；被采出计入 spansSampledOut；采样只减少出站数据（隐私正向）；
 *  - 批处理上限（1.2-S3 加法）：maxBatchSize 单请求分批（512）+ maxQueueSize buffer 上限
 *    （2048，溢出丢最旧 + queueOverflows 计数）——内存有界；
 *  - env 通道（1.2-S3 加法）：telemetryConfigFromEnv——CAR_OTEL_ENDPOINT（唯一开关）/
 *    CAR_OTEL_SAMPLING（always_on|always_off|0..1，非法值保持缺省——遥测面禁 fail-hard）/
 *    CAR_OTEL_INTERVAL_MS / CAR_OTEL_SERVICE_NAME；
 *  - 严格解耦：本文件零 import 自 session/*（遥测与审计日志禁止混流）——测试做静态断言；
 *  - S17 零内容计数器（telemetry/metrics.ts）是登记表兜底通道，与本门面并存互补：
 *    本面是 OTel 形态的出站通道，不承接 S17 的零内容红线语义（内容治理属调用方）；
 *  - 零依赖：OTel「标准句柄形态」自研（startSpan/attributes/end、createCounter/add），
 *    不引入 @opentelemetry/* 依赖（项目零依赖红线，README engines 纪律）。
 *
 * 1.7（D-26 span 语义标准化 / D-27 metrics 时序修正）：
 *  - recordException → OTel 规范形态：span event（name='exception'，exception.type/exception.message
 *    于事件属性）+ span status → STATUS_CODE_ERROR；stacktrace 缺省不出站（防路径/源码面外泄——
 *    隐私三原则正向收紧；可选开关不随本迭代引入）；正常 span 恒 STATUS_CODE_UNSET（行为不变面）；
 *  - addEvent → 标准 events 数组编码（name + attributes 原形态 + 事件时刻 timeUnixNano——
 *    替换 1.1 起的 `event.<name>` JSON 属性串非标准形态）；
 *  - 出站体 spans[] 加法字段 events/status（空形态合法——无事件 span 不出 events 键）；
 *  - metrics 累计基数保持：flush 不再清空 counters——每次导出全量累计快照（真 CUMULATIVE）。
 *    1.2-S3 起 clear() 与 AGGREGATION_TEMPORALITY_CUMULATIVE 标注矛盾：intervalMs>0 自动导出时
 *    下游把增量解读为总量回落；内存有界由 label 基数保证（零内容枚举红线——AllowedLabels 3 计数器）。
 */
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export type SamplingSpec = 'always_on' | 'always_off' | { ratio: number }

export interface TelemetryConfig {
  /** 用户自配 OTLP/HTTP 端点（如 https://otel.example.internal）——无值 = 默认关 */
  endpoint?: string
  serviceName?: string
  headers?: Record<string, string>
  /** 导出超时（§3.5.4 基线 5s） */
  exportTimeoutMs?: number
  /** 自动导出间隔 ms；0（缺省）= 仅手动 flush（测试/收口时点调用） */
  intervalMs?: number
  // —— 1.2-S3 生产级策略（加法；缺省值保持 1.1 行为）——
  /** 有界重试上限（仅 429/5xx/网络错误；§3.5.4 基线 ≤2；D-12b 口径修订） */
  retryLimit?: number
  /** 重试退避序列 ms（缺省 [1000, 2000]；测试可注入） */
  retryBackoffMs?: number[]
  /** 采样（缺省 always_on = 全量）；head 决策于 span.end() */
  sampling?: SamplingSpec
  /** 单请求 spans 上限（超限分批；缺省 512） */
  maxBatchSize?: number
  /** span buffer 上限（溢出丢最旧 + queueOverflows 计数；缺省 2048） */
  maxQueueSize?: number
  /** 测试注入睡眠（退避可观测；缺省真实定时器） */
  sleep?: (ms: number) => Promise<void>
}

export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): this
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): this
  recordException(err: unknown): this
  end(): void
  readonly traceId: string
  /** 1.4-S6：子 span 挂链需要父 spanId（TurnTracer turn→step 层级） */
  readonly spanId: string
}

export interface TelemetryTracer {
  startSpan(name: string, opts?: {
    attributes?: Record<string, string | number | boolean>
    /** 1.4-S6：trace 透传（traceId 复用 + parentSpanId 挂链）；缺省 = 新独立 trace */
    trace?: { traceId: string; parentSpanId?: string }
  }): TelemetrySpan
}

export interface TelemetryCounter {
  add(value: number, labels?: Record<string, string>): void
}

export interface TelemetryMeter {
  createCounter(name: string): TelemetryCounter
}

export interface TelemetryStats {
  spansEnded: number
  /** 1.2-S3 加法：head 采样被采出的 span 数（缺省 always_on 下恒 0） */
  spansSampledOut: number
  /** 成功出站的 OTLP 请求计数（traces/metrics 分批后按请求计） */
  tracesExported: number
  metricsExported: number
  droppedExports: number
  /** 1.2-S3 加法：buffer 溢出丢最旧计数（maxQueueSize 上限） */
  queueOverflows: number
}

export interface TelemetryFacade {
  /** 默认关 = false（无端点配置时） */
  readonly enabled: boolean
  /** 幂等句柄（§3.2.M8.2：天然幂等） */
  getTracer(): TelemetryTracer
  getMeter(): TelemetryMeter
  /** 手动导出（BD-05：端点不可达静默丢弃——resolve 不 reject） */
  flush(): Promise<void>
  shutdown(): Promise<void>
  /** 观察面（测试/收口；不含内容字段） */
  stats(): TelemetryStats
}

// ==================== noop 句柄（默认关路径：零出站、零积累） ====================

const noopSpan = (): TelemetrySpan => ({
  setAttribute() { return noopSpan() },
  addEvent() { return noopSpan() },
  recordException() { return noopSpan() },
  end() {},
  traceId: '',
  spanId: '',
})
const NOOP_TRACER: TelemetryTracer = { startSpan: () => noopSpan() }
const NOOP_METER: TelemetryMeter = { createCounter: () => ({ add() {} }) }
const NOOP_STATS: TelemetryStats = { spansEnded: 0, spansSampledOut: 0, tracesExported: 0, metricsExported: 0, droppedExports: 0, queueOverflows: 0 }

/**
 * 1.2-S3 env 配置通道：CAR_OTEL_ENDPOINT（唯一开关）/ CAR_OTEL_SAMPLING（always_on|always_off|0..1，
 * 非法值保持缺省 always_on——遥测面禁 fail-hard）/ CAR_OTEL_INTERVAL_MS / CAR_OTEL_SERVICE_NAME。
 * 无 endpoint = null（默认关，noop 门面）。
 */
export function telemetryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryConfig | null {
  const endpoint = env.CAR_OTEL_ENDPOINT
  if (!endpoint) return null
  const cfg: TelemetryConfig = { endpoint }
  if (env.CAR_OTEL_SERVICE_NAME) cfg.serviceName = env.CAR_OTEL_SERVICE_NAME
  if (env.CAR_OTEL_INTERVAL_MS) {
    const n = Number(env.CAR_OTEL_INTERVAL_MS)
    if (Number.isFinite(n) && n >= 0) cfg.intervalMs = n
  }
  if (env.CAR_OTEL_SAMPLING) {
    const s = env.CAR_OTEL_SAMPLING
    if (s === 'always_on' || s === 'always_off') cfg.sampling = s
    else {
      const r = Number(s)
      if (Number.isFinite(r) && r >= 0 && r <= 1) cfg.sampling = { ratio: r }
      // 非法采样值：保持缺省 always_on（登记口径，禁 fail-hard）
    }
  }
  return cfg
}

// ==================== 活动门面（显式开路径） ====================

interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startMs: number
  endMs: number
  attributes: Record<string, string | number | boolean>
  /** 1.7-S1（D-26）：标准 span events（name + 原形态属性 + 事件时刻） */
  events: Array<{ name: string; atMs: number; attributes: Record<string, string | number | boolean> }>
  /** 1.7-S1（D-26）：'STATUS_CODE_UNSET'（缺省）| 'STATUS_CODE_ERROR'（recordException） */
  status: 'STATUS_CODE_UNSET' | 'STATUS_CODE_ERROR'
}

const attrValue = (v: string | number | boolean) =>
  typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : { doubleValue: v }

export function createTelemetryFacade(
  config: TelemetryConfig | null | undefined,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): TelemetryFacade {
  const endpoint = config?.endpoint?.replace(/\/+$/, '')
  if (!endpoint) {
    return {
      enabled: false,
      getTracer: () => NOOP_TRACER,
      getMeter: () => NOOP_METER,
      flush: async () => {},
      shutdown: async () => {},
      stats: () => ({ ...NOOP_STATS }),
    }
  }

  // 1.4-BUG-2：出站默认走 node:http(s)（非全局 fetch/undici）——win32 上 undici socket +
  // 进程退出触发 libuv 断言崩溃（UV_HANDLE_CLOSING, 0xC0000409，Node 23.5 实测、22 不复现）；
  // 测试仍可注入 fetchImpl（缝保留）。res.resume() 排空响应体（连接干净归还）。
  const fetchImpl = opts.fetchImpl ?? ((url: string | URL, init?: RequestInit): Promise<{ ok: boolean; status: number }> => new Promise(resolve => {
    try {
      const u = String(url)
      const mod = u.startsWith('https:') ? httpsRequest : httpRequest
      const req = mod(u, { method: init?.method ?? 'GET', headers: init?.headers as Record<string, string> | undefined }, res => {
        res.resume()
        res.on('end', () => {
          const st = res.statusCode ?? 0
          resolve({ ok: st >= 200 && st < 300, status: st })
        })
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
      req.on('error', () => resolve({ ok: false, status: 599 })) // 网络/超时错误 → 599 可重试类
      req.end(init?.body ?? null)
    } catch { resolve({ ok: false, status: 599 }) }
  }))
  const now = opts.now ?? Date.now
  const sleep = config?.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const timeoutMs = config?.exportTimeoutMs ?? 5_000
  const retryLimit = config?.retryLimit ?? 2
  const backoff = config?.retryBackoffMs ?? [1_000, 2_000]
  const sampling = config?.sampling ?? 'always_on'
  const maxBatchSize = config?.maxBatchSize ?? 512
  const maxQueueSize = config?.maxQueueSize ?? 2_048
  const baseHeaders = { 'content-type': 'application/json', ...(config?.headers ?? {}) }
  const serviceName = config?.serviceName ?? 'car-runtime'

  const spans: SpanRecord[] = []
  // 计数器键 = name+labels JSON（聚合去重）；记录体分离保存 name/labels——
  // OTLP metric 名必须是纯 name（1.2-BUG-3：键直当名会把 labels JSON 拼进 metric 名，
  // M8 最小实现即存在，meter 零生产调用点掩盖至今，1.2-S3 meter 桥接入时暴露）
  const counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>()
  const stats: TelemetryStats = { spansEnded: 0, spansSampledOut: 0, tracesExported: 0, metricsExported: 0, droppedExports: 0, queueOverflows: 0 }
  let tracer: TelemetryTracer | null = null
  let meter: TelemetryMeter | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let flushing = false

  /**
   * OTLP 出站（D-12b 口径：有界重试）——ok / 429/5xx/网络错误退避重试 ≤retryLimit /
   * 4xx 业务错不重试（端点配置类问题，重试无益）；重试耗尽返回 false 由调用方计入
   * droppedExports（静默丢弃，永不抛错——BD-05「不抛错」收紧保持）。
   */
  const exportOtlp = async (path: string, body: unknown): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      // 1.4-BUG-2：AbortSignal.timeout 的内部定时器在进程退出时触发 libuv win32 断言崩溃
      // （UV_HANDLE_CLOSING, 0xC0000409）——改手动 AbortController + clearTimeout 确定性清理
      const controller = new AbortController()
      const abortTimer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(endpoint + path, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (res.ok) return true
        if ((res.status === 429 || res.status >= 500) && attempt < retryLimit) {
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]!)
          continue
        }
        return false
      } catch {
        // 网络错误/超时：可重试类
        if (attempt < retryLimit) {
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]!)
          continue
        }
        return false
      } finally {
        clearTimeout(abortTimer)
      }
    }
  }

  const flush = async (): Promise<void> => {
    if (flushing) return
    flushing = true
    try {
      const spanQueue = spans.splice(0, spans.length)
      // maxBatchSize 分批（1.2-S3）：tracesExported 按成功出站请求计数
      for (let i = 0; i < spanQueue.length; i += maxBatchSize) {
        const batch = spanQueue.slice(i, i + maxBatchSize)
        const body = {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeSpans: [{
            scope: { name: 'car-runtime' },
            spans: batch.map(s => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 'SPAN_KIND_INTERNAL',
              startTimeUnixNano: String(s.startMs * 1e6),
              endTimeUnixNano: String(s.endMs * 1e6),
              attributes: Object.entries(s.attributes).map(([key, v]) => ({ key, value: attrValue(v) })),
              // 1.7-S1（D-26）：标准 events/status 加法字段（无事件 span 不出 events 键——空形态合法）
              ...(s.events.length ? {
                events: s.events.map(e => ({
                  timeUnixNano: String(e.atMs * 1e6),
                  name: e.name,
                  attributes: Object.entries(e.attributes).map(([key, v]) => ({ key, value: attrValue(v) })),
                })),
              } : {}),
              status: { code: s.status },
            })),
          }],
        }
        if (await exportOtlp('/v1/traces', body)) stats.tracesExported++
        else stats.droppedExports++
      }
      if (counters.size) {
        const batch = [...counters.entries()]
        // 1.7-S2（D-27）：累计基数保持——不清空，每次导出全量累计快照（真 CUMULATIVE）。
        // 1.2-S3 起 clear() 使后续导出仅含增量却标 CUMULATIVE——intervalMs>0 时下游解读为总量回落；
        // 内存有界由 label 基数保证（零内容枚举红线：AllowedLabels 3 计数器）
        const body = {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeMetrics: [{
            scope: { name: 'car-runtime' },
            metrics: batch.map(([, c]) => ({
              name: c.name,
              sum: {
                aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
                dataPoints: Object.entries(c.labels).length
                  ? Object.entries(c.labels).map(([k, v]) => ({ asInt: c.value, attributes: [{ key: k, value: { stringValue: v } }] }))
                  : [{ asInt: c.value }],
              },
            })),
          }],
        }
        if (await exportOtlp('/v1/metrics', body)) stats.metricsExported++
        else stats.droppedExports++
      }
    } finally {
      flushing = false
    }
  }

  if ((config?.intervalMs ?? 0) > 0) timer = setInterval(() => { void flush() }, config!.intervalMs!)

  const activeTracer: TelemetryTracer = {
    startSpan(name, startOpts) {
      const record: SpanRecord = {
        // 1.4-S6：trace 透传（traceId 复用 + parentSpanId 挂链）——缺省仍为独立随机 trace（1.1 行为不变）
        traceId: startOpts?.trace?.traceId ?? randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
        parentSpanId: startOpts?.trace?.parentSpanId ?? null,
        name,
        startMs: now(),
        endMs: 0,
        attributes: { ...startOpts?.attributes },
        events: [],
        status: 'STATUS_CODE_UNSET',
      }
      return {
        get traceId() { return record.traceId },
        get spanId() { return record.spanId },
        setAttribute(key, value) { record.attributes[key] = value; return this },
        // 1.7-S1（D-26）：标准 events 编码——原形态属性 + 事件时刻（替换 event.<name> JSON 串）
        addEvent(evtName, attrs) { record.events.push({ name: evtName, atMs: now(), attributes: attrs ? { ...attrs } : {} }); return this },
        // 1.7-S1（D-26）：OTel 规范 exception 形态——exception.type/exception.message 事件属性
        // + status ERROR；stacktrace 缺省不出站（D-26 口径：防路径/源码面外泄）
        recordException(err) {
          record.events.push({
            name: 'exception',
            atMs: now(),
            attributes: {
              'exception.type': String((err as Error)?.name ?? 'Error'),
              'exception.message': String((err as Error)?.message ?? err),
            },
          })
          record.status = 'STATUS_CODE_ERROR'
          return this
        },
        end() {
          record.endMs = now()
          stats.spansEnded++
          // head 采样于 end() 决策（1.2-S3）：缺省 always_on 全量（1.1 行为不变）；采样只减少出站
          const keep = sampling === 'always_on' ? true
            : sampling === 'always_off' ? false
            : Math.random() < sampling.ratio
          if (!keep) { stats.spansSampledOut++; return }
          // buffer 上限：溢出丢最旧 + 计数（内存有界）
          if (spans.length >= maxQueueSize) { spans.shift(); stats.queueOverflows++ }
          spans.push(record)
        },
      }
    },
  }

  const activeMeter: TelemetryMeter = {
    createCounter(name) {
      return {
        add(value, labels = {}) {
          const key = name + JSON.stringify(labels)
          const cur = counters.get(key) ?? { name, labels, value: 0 }
          cur.value += value
          counters.set(key, cur)
        },
      }
    },
  }

  return {
    enabled: true,
    getTracer() { tracer ??= activeTracer; return tracer },
    getMeter() { meter ??= activeMeter; return meter },
    flush,
    async shutdown() {
      if (timer) { clearInterval(timer); timer = null }
      await flush()
    },
    stats: () => ({ ...stats }),
  }
}
