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
 */
import { randomBytes } from 'node:crypto'
import type { TelemetryFacade } from './telemetry.ts'

export interface StepSpanHandle {
  end(outcome: string): void
  recordException(e: unknown): void
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
}

export class TurnTracer {
  readonly #facade: TelemetryFacade | null

  constructor(facade: TelemetryFacade | null | undefined) {
    // 默认关（无端点）= noop 句柄（零出站零积累——telemetry 三原则）
    this.#facade = facade?.enabled ? facade : null
  }

  startTurn(turnId: string): TurnSpanHandle {
    if (!this.#facade) {
      return { traceId: '', spanId: '', setTurnId() {}, recordException() {}, end() {}, stepSpan: () => ({ end() {}, recordException() {} }) }
    }
    const tracer = this.#facade.getTracer()
    const traceId = randomBytes(16).toString('hex')
    const turn = tracer.startSpan('car.turn', { attributes: turnId ? { 'car.turn_id': turnId } : {}, trace: { traceId } })
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
    }
  }
}
