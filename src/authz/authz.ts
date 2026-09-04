/**
 * F4 · 授权服务：幂等决策 + 超时默认拒绝 + 能力标签 deny-by-default + 审计留痕
 *
 * 口径（《系统设计》§7.2.5 / 安全设计 §2.2 / US-3）：
 *  - 授权对象 = 「能力 × 资源」；能力标签五枚举，未声明即无该能力（deny-by-default）
 *  - 幂等键 authorizationId：重复请求返回同一决策（防决策重放不一致，T-10）
 *  - 审批等待 120s 超时默认拒绝（timeout-default-deny；测试可注入短超时）
 *  - 决策 100% 写审计日志（US6「凭什么」的凭据）；降级态决策带 degraded=true
 */
import type { SessionLog } from '../session/log.ts'
import type { Capability } from '../sandbox/sandbox.ts'

export type Decision = 'APPROVED' | 'DENIED' | 'EXPIRED'
export interface AuthzRequest {
  authorizationId: string
  actor: string
  capability: Capability
  resource: string
  reason?: string
}
export interface AuthzDecision {
  authorizationId: string
  decision: Decision
  decidedBy: 'user' | 'policy' | 'timeout'
  reason: string
  degraded: boolean
  ts: number
}

export interface DeclaredCapabilities { capabilities?: Capability[] }

/** 能力标签检查：manifest 未声明的能力 = deny（T-22：未声明按最高约束） */
export function checkCapability(declared: DeclaredCapabilities, needed: Capability): boolean {
  return declared.capabilities?.includes(needed) === true
}

export class AuthzService {
  #decisions = new Map<string, AuthzDecision>()
  #log: SessionLog
  #timeoutMs: number
  #degraded: boolean

  constructor(opts: { log: SessionLog; timeoutMs?: number; degraded?: boolean }) {
    this.#log = opts.log
    this.#timeoutMs = opts.timeoutMs ?? 120_000
    this.#degraded = opts.degraded ?? false
  }

  /** 声明式放行（policy）：readonly 模式下写类一律 DENIED，无需人审 */
  decideByPolicy(req: AuthzRequest, mode: 'readonly' | 'confirm' | 'full'): AuthzDecision {
    const writeish = req.capability !== 'env-read' && req.capability !== 'mcp'
    const decision: AuthzDecision = {
      authorizationId: req.authorizationId,
      decision: mode === 'full' ? 'APPROVED' : 'DENIED',
      decidedBy: 'policy',
      reason: mode === 'full' ? 'auto-allowed (full mode)' : `write-class capability "${req.capability}" denied in ${mode} mode`,
      degraded: this.#degraded,
      ts: Date.now(),
    }
    void writeish
    return this.#commit(decision)
  }

  /** 人审（confirm 模式）：120s 超时默认拒绝（timeout-default-deny） */
  async decideByUser(req: AuthzRequest, approve: (req: AuthzRequest) => Promise<boolean>): Promise<AuthzDecision> {
    const cached = this.#decisions.get(req.authorizationId)
    if (cached) return cached // 幂等：同 id 返回同一决策（防重放不一致）
    let approved: boolean
    try {
      approved = await Promise.race([
        approve(req),
        new Promise<false>(resolve => setTimeout(() => resolve(false), this.#timeoutMs)),
      ])
    } catch { approved = false }
    const decision: AuthzDecision = {
      authorizationId: req.authorizationId,
      decision: approved ? 'APPROVED' : 'EXPIRED',
      decidedBy: approved ? 'user' : 'timeout',
      reason: approved ? 'user approved within timeout' : `approval timeout after ${this.#timeoutMs}ms (default-deny)`,
      degraded: this.#degraded,
      ts: Date.now(),
    }
    return this.#commit(decision)
  }

  #commit(d: AuthzDecision): AuthzDecision {
    const existing = this.#decisions.get(d.authorizationId)
    if (existing) return existing
    this.#decisions.set(d.authorizationId, d)
    // 授权留痕：authorization/* 事件（写会话日志先于执行——先落日志后放行由调用方保证顺序）
    this.#log.append('runtime', 'turnEnd', `authz:${d.authorizationId}`, {
      authorizationId: d.authorizationId, decision: d.decision, decidedBy: d.decidedBy, degraded: d.degraded,
    }, { reason: d.reason })
    return d
  }
}
