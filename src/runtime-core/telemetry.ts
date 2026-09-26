/**
 * M8 · 遥测门面（getTracer/getMeter ——《系统设计》§3.2.M8.2 遥测行 / §3.2.M8.5 隐私三原则）
 *
 * 口径（§3.2.M8.5 关键约束，逐条落地）：
 *  - 默认关：无端点配置时不初始化任何 exporter——无配置 = noop 句柄 + 零出站（可机器断言）；
 *  - 显式开：用户配置端点即视为开启（CAR_OTEL_ENDPOINT 或显式 config 传入）；
 *  - 端点归用户：数据只发往用户自配 E-05；OTLP/HTTP JSON（fetch），导出超时 5s、0 重试、
 *    端点不可达静默丢弃（BD-05——不抛错、不重试、不落审计）；
 *  - 严格解耦：本文件零 import 自 session/*（遥测与审计日志禁止混流）——测试做静态断言；
 *  - S17 零内容计数器（telemetry/metrics.ts）是登记表兜底通道，与本门面并存互补：
 *    本面是 OTel 形态的出站通道，不承接 S17 的零内容红线语义（内容治理属调用方）；
 *  - 零依赖：OTel「标准句柄形态」自研（startSpan/attributes/end、createCounter/add），
 *    不引入 @opentelemetry/* 依赖（项目零依赖红线，README engines 纪律）。
 */
import { randomBytes } from 'node:crypto'

export interface TelemetryConfig {
  /** 用户自配 OTLP/HTTP 端点（如 https://otel.example.internal）——无值 = 默认关 */
  endpoint?: string
  serviceName?: string
  headers?: Record<string, string>
  /** 导出超时（§3.5.4 基线 5s） */
  exportTimeoutMs?: number
  /** 自动导出间隔 ms；0（缺省）= 仅手动 flush（测试/收口时点调用） */
  intervalMs?: number
}

export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): this
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): this
  recordException(err: unknown): this
  end(): void
  readonly traceId: string
}

export interface TelemetryTracer {
  startSpan(name: string, opts?: { attributes?: Record<string, string | number | boolean> }): TelemetrySpan
}

export interface TelemetryCounter {
  add(value: number, labels?: Record<string, string>): void
}

export interface TelemetryMeter {
  createCounter(name: string): TelemetryCounter
}

export interface TelemetryStats {
  spansEnded: number
  tracesExported: number
  metricsExported: number
  droppedExports: number
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
})
const NOOP_TRACER: TelemetryTracer = { startSpan: () => noopSpan() }
const NOOP_METER: TelemetryMeter = { createCounter: () => ({ add() {} }) }

// ==================== 活动门面（显式开路径） ====================

interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startMs: number
  endMs: number
  attributes: Record<string, string | number | boolean>
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
      stats: () => ({ spansEnded: 0, tracesExported: 0, metricsExported: 0, droppedExports: 0 }),
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const timeoutMs = config?.exportTimeoutMs ?? 5_000
  const baseHeaders = { 'content-type': 'application/json', ...(config?.headers ?? {}) }
  const serviceName = config?.serviceName ?? 'car-runtime'

  const spans: SpanRecord[] = []
  const counters = new Map<string, { labels: Record<string, string>; value: number }>()
  const stats: TelemetryStats = { spansEnded: 0, tracesExported: 0, metricsExported: 0, droppedExports: 0 }
  let tracer: TelemetryTracer | null = null
  let meter: TelemetryMeter | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let flushing = false

  const exportOtlp = async (path: string, body: unknown): Promise<boolean> => {
    try {
      // 单次尝试 + 有界超时（§3.5.4：OTel 导出 5s / 0 重试）；失败静默丢弃（BD-05）
      await fetchImpl(endpoint + path, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return true
    } catch {
      return false
    }
  }

  const flush = async (): Promise<void> => {
    if (flushing) return
    flushing = true
    try {
      const spanBatch = spans.splice(0, spans.length)
      if (spanBatch.length) {
        const body = {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeSpans: [{
            scope: { name: 'car-runtime' },
            spans: spanBatch.map(s => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 'SPAN_KIND_INTERNAL',
              startTimeUnixNano: String(s.startMs * 1e6),
              endTimeUnixNano: String(s.endMs * 1e6),
              attributes: Object.entries(s.attributes).map(([key, v]) => ({ key, value: attrValue(v) })),
              status: { code: 'STATUS_CODE_UNSET' },
            })),
          }],
        }
        if (await exportOtlp('/v1/traces', body)) stats.tracesExported++
        else stats.droppedExports++
      }
      if (counters.size) {
        const batch = [...counters.entries()]
        counters.clear()
        const body = {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeMetrics: [{
            scope: { name: 'car-runtime' },
            metrics: batch.map(([name, c]) => ({
              name,
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
        traceId: randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
        parentSpanId: null,
        name,
        startMs: now(),
        endMs: 0,
        attributes: { ...startOpts?.attributes },
      }
      return {
        get traceId() { return record.traceId },
        setAttribute(key, value) { record.attributes[key] = value; return this },
        addEvent(evtName, attrs) { record.attributes[`event.${evtName}`] = attrs ? JSON.stringify(attrs) : evtName; return this },
        recordException(err) { record.attributes['exception.message'] = String((err as Error)?.message ?? err); return this },
        end() {
          record.endMs = now()
          spans.push(record)
          stats.spansEnded++
        },
      }
    },
  }

  const activeMeter: TelemetryMeter = {
    createCounter(name) {
      return {
        add(value, labels = {}) {
          const key = name + JSON.stringify(labels)
          const cur = counters.get(key) ?? { labels, value: 0 }
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
