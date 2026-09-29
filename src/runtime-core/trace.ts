/**
 * 1.4-S6 · Turn 级 trace 面（W1 遥测未入链收尾）：turn span 包全程、step span 挂每次 model() 调用
 *
 * 口径（1.4 规划 W1 遥测块 / telemetry.ts 头注释）：
 *  - 层级：turn（根 span，traceId 在此生成）→ step（parentSpanId = turn.spanId）——同一 turn 共享 trace；
 *  - **挂点在装配层**（car run 的 model 回调闭包），loop 层零改动——遥测治理属调用方（telemetry.ts
 *    「内容治理属调用方」口径）；设计微调登记：规划原文「runTurn opts.telemetry 注入面」改为装配层
 *    闭包挂点，语义等价（turn/step 层级与出站面不变），loop 层保持纯停止语义；
 *  - attributes 零内容面：turn_id/step 序号/outcome 枚举——无会话内容/提示词/路径。
 *
 * 1.7-S3（D-28）：mcp-serve turn span 面——sessionTurn 挂 turn 级 span（无 step span：mcp-serve
 * 无 model() 循环，step span 面外推登记为不适用）。facade 内部自增派生 turnId（T{n}），装配层
 * 调用前不可知——TurnSpanHandle 加法 `setTurnId` 回填面（car run 直传 turnId 路径不受影响）；
 * startTurn('') 空值不设 car.turn_id 属性（回填前出站形态无占位内容）。
 *
 * 1.8（D-29/D-30/D-31 · W3C traceparent 跨进程传播）：自研 traceId（16B hex）与 spanId（8B hex）
 * 格式天然满足 W3C Trace Context（trace-id 32hex / span-id 16hex），1.8 补齐编解码与三边界载体：
 *  - formatTraceparent/parseTraceparent（D-29）：纯字符串编解码，零依赖；parse 严格校验
 *    （version 00 / 32hex / 16hex / 全零拒绝），畸形返回 null——**协议面 fail-open**（挂链放弃、
 *    新 trace，遥测面禁 fail-hard——BD-05 同源）；flags 出站恒 '01'（本端记录中——采样为端点
 *    本地决策，不跨端传播语义）；
 *  - mcpToolSpan（D-29）：car run 外呼 MCP 工具的 client span（parent = turn span——step span 已于
 *    model() 返回时收口，工具执行在 step 外）；attributes car.mcp_server/car.tool 为**登记标识符面**
 *    （零内容口径扩展：注册表枚举标识，非会话内容）；traceparent 供 gateway.callTool 注入
 *    params._meta（otel 关 = '' 不注入，线上 JSON-RPC 字节面不变）；
 *  - startTurn 加法 opts.trace（D-30）：mcp-serve 服务端挂链远端宿主——traceId 复用远端 +
 *    parentSpanId = 远端 spanId，car.turn span 加入宿主 trace（fail-open：畸形 traceparent 由
 *    调用方 parse 为 null 后不传，新 trace）；
 *  - ptcRelay（D-31）：PTC worker 桥挂链——workerTrace 载荷（traceId/parentSpanId）经 workerData
 *    进隔离体，worker 计时经 done 消息回传后 complete() 主线程单点收口 car.ptc span（facade
 *    time.startMs/end(atMs) 时刻覆盖；单 exporter 纪律——worker 零独立出站通道）。
 */
import { randomBytes } from 'node:crypto'
import type { TelemetryFacade } from './telemetry.ts'

export interface StepSpanHandle {
  end(outcome: string): void
  recordException(e: unknown): void
}

/** 1.8-D29：MCP 外呼 client span 句柄——traceparent = '' 表示无遥测（不注入 _meta） */
export interface McpClientSpanHandle {
  readonly traceparent: string
  end(outcome: string): void
  recordException(e: unknown): void
}

/** 1.8-D31：PTC worker 桥挂链句柄——workerTrace=null 表示无遥测（worker 零感知零改动） */
export interface PtcRelayHandle {
  readonly workerTrace: { traceId: string; parentSpanId: string } | null
  /** worker 计时回传收口（主线程单点出站；error 路径 recordException D-26 形态） */
  complete(startMs: number, endMs: number, outcome: string, error?: unknown): void
}

export interface TurnSpanHandle {
  traceId: string
  spanId: string
  /** 1.7-D28：turnId 事后回填（mcp-serve——facade 内部自增派生，调用前不可知；car run 直传不受影响） */
  setTurnId(turnId: string): void
  /** 1.7-D28：turn 级异常留痕（D-26 exception 形态在 turn span 同样成立） */
  recordException(e: unknown): void
  end(outcome: string): void
  stepSpan(step: number): StepSpanHandle
  /** 1.8-D29：MCP 外呼 client span（parent = turn span；noop 门面 traceparent='' 零注入） */
  mcpToolSpan(serverId: string, tool: string): McpClientSpanHandle
  /** 1.8-D31：PTC worker 桥挂链面（noop 门面 workerTrace=null 零载荷） */
  ptcRelay(): PtcRelayHandle
}

/** 1.8-D29：W3C traceparent 出站形态（flags '01' = 本端记录中；采样为端点本地决策不跨端传播） */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`
}

const W3C_TP_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/**
 * 1.8-D29：W3C traceparent 解析——严格校验（version 00 / trace-id 32hex 非 / span-id 16hex 非 / 全零拒绝）。
 * 畸形返回 null = 挂链放弃（调用方走新 trace——协议面 fail-open，禁 fail-hard）。
 */
export function parseTraceparent(tp: string): { traceId: string; parentSpanId: string } | null {
  const m = W3C_TP_RE.exec(tp.trim())
  if (!m) return null
  const traceId = m[1]!
  const parentSpanId = m[2]!
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null
  return { traceId, parentSpanId }
}

export class TurnTracer {
  readonly #facade: TelemetryFacade | null

  constructor(facade: TelemetryFacade | null | undefined) {
    // 默认关（无端点）= noop 句柄（零出站零积累——telemetry 三原则）
    this.#facade = facade?.enabled ? facade : null
  }

  /** 1.8-D30：opts.trace = 远端挂链（mcp-serve session_turn `_meta.traceparent` 提取后传入；缺省新 trace 不变） */
  startTurn(turnId: string, opts?: { trace?: { traceId: string; parentSpanId: string } }): TurnSpanHandle {
    if (!this.#facade) {
      return {
        traceId: '', spanId: '', setTurnId() {}, recordException() {}, end() {},
        stepSpan: () => ({ end() {}, recordException() {} }),
        mcpToolSpan: () => ({ traceparent: '', end() {}, recordException() {} }),
        ptcRelay: () => ({ workerTrace: null, complete() {} }),
      }
    }
    const tracer = this.#facade.getTracer()
    const traceId = opts?.trace?.traceId ?? randomBytes(16).toString('hex')
    const turn = tracer.startSpan('car.turn', {
      attributes: turnId ? { 'car.turn_id': turnId } : {},
      trace: { traceId, ...(opts?.trace?.parentSpanId ? { parentSpanId: opts.trace.parentSpanId } : {}) },
    })
    return {
      traceId,
      spanId: turn.spanId,
      setTurnId(id) { turn.setAttribute('car.turn_id', id) },
      recordException(e) { turn.recordException(e) },
      end(outcome) {
        turn.setAttribute('car.outcome', outcome)
        turn.end()
      },
      stepSpan(step: number): StepSpanHandle {
        const s = tracer.startSpan('car.step', {
          attributes: { 'car.turn_id': turnId, 'car.step': step },
          trace: { traceId, parentSpanId: turn.spanId },
        })
        return {
          end(outcome) {
            s.setAttribute('car.outcome', outcome)
            s.end()
          },
          recordException(e) { s.recordException(e) },
        }
      },
      // 1.8-D29：client span 挂 turn（工具执行在 step span 收口后——turn 为最近存活父）
      mcpToolSpan(serverId, tool) {
        const s = tracer.startSpan('car.mcp.tool', {
          attributes: { 'car.mcp_server': serverId, 'car.tool': tool },
          trace: { traceId, parentSpanId: turn.spanId },
        })
        return {
          traceparent: formatTraceparent(traceId, s.spanId),
          end(outcome) {
            s.setAttribute('car.outcome', outcome)
            s.end()
          },
          recordException(e) { s.recordException(e) },
        }
      },
      // 1.8-D31：worker 侧计时 relay——span 生成收口在主线程（单 exporter 纪律）
      ptcRelay(): PtcRelayHandle {
        return {
          workerTrace: { traceId, parentSpanId: turn.spanId },
          complete(startMs, endMs, outcome, error) {
            // 负时长防线（同时钟域不应出现——防御下游转换器语义错乱）
            const s = tracer.startSpan('car.ptc', {
              attributes: { 'car.turn_id': turnId },
              trace: { traceId, parentSpanId: turn.spanId },
              time: { startMs },
            })
            if (error !== undefined) s.recordException(error instanceof Error ? error : new Error(String(error)))
            s.setAttribute('car.outcome', outcome)
            s.end(Math.max(endMs, startMs))
          },
        }
      },
    }
  }
}
