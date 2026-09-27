/**
 * 1.4-S6 · Turn 级 trace 面（W1 遥测未入链收尾）：turn span 包全程、step span 挂每次 model() 调用
 *
 * 口径（1.4 规划 W1 遥测块 / telemetry.ts 头注释）：
 *  - 层级：turn（根 span，traceId 在此生成）→ step（parentSpanId = turn.spanId）——同一 turn 共享 trace；
 *  - **挂点在装配层**（car run 的 model 回调闭包），loop 层零改动——遥测治理属调用方（telemetry.ts
 *    「内容治理属调用方」口径）；设计微调登记：规划原文「runTurn opts.telemetry 注入面」改为装配层
 *    闭包挂点，语义等价（turn/step 层级与出站面不变），loop 层保持纯停止语义；
 *  - attributes 零内容面：turn_id/step 序号/outcome 枚举——无会话内容/提示词/路径。
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
      return { traceId: '', spanId: '', end() {}, stepSpan: () => ({ end() {}, recordException() {} }) }
    }
    const tracer = this.#facade.getTracer()
    const traceId = randomBytes(16).toString('hex')
    const turn = tracer.startSpan('car.turn', { attributes: { 'car.turn_id': turnId }, trace: { traceId } })
    return {
      traceId,
      spanId: turn.spanId,
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
