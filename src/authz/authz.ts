/**
 * F4 · 授权服务：幂等决策 + 超时默认拒绝 + 能力标签 deny-by-default + 审计留痕
 *
 * 口径（《系统设计》§7.2.5 / 安全设计 §2.2 / US-3）：
 *  - 授权对象 = 「能力 × 资源」；能力标签五枚举，未声明即无该能力（deny-by-default）
 *  - 幂等键 authorizationId：重复请求返回同一决策（防决策重放不一致，T-10）
 *  - 审批等待 120s 超时默认拒绝（timeout-default-deny；测试可注入短超时）
 *  - 决策 100% 写审计日志（US6「凭什么」的凭据）；降级态决策带 degraded=true
 *
 * 加法登记：1.25.1 —— Z-11 附注键（D-V12-1，用户批）：decideByUser 人审回调返回形态加法
 *   boolean → boolean | { approve: boolean; note?: string }（对象形态 = 用户实答，附注随决策
 *   事件 payload +note 落链——单事件完整审计面《v0.12-Z7反向感知Z11同意面Z5召回消费-迭代规划.md》
 *   D-V12-3）；批准与拒绝两档皆可带附注；超时（boolean false 竞速失败）无附注（决策=timeout
 *   default-deny，附注未及时提交属预期）；对象形态缺布尔 approve = CAR-E-AUTHZ-NOTE fail-visible
 *   （决策不落链）；boolean 形态与超时路径字节兼容（无 note 事件零变化）。seam 45 零加法。
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
  /** 1.25.1（D-V12-1）：用户实答附注（对象形态回调携带；批准/拒绝两档皆可带；超时无附注） */
  note?: string
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

  /** 会话策略直判（「会话内始终允许」粒度）：decidedBy=policy 幂等落链，不入人审通道（审批回调 scope=session 写入 grants 后走此路） */
  decideBySessionPolicy(req: AuthzRequest): AuthzDecision {
    return this.#commit({
      authorizationId: req.authorizationId,
      decision: 'APPROVED',
      decidedBy: 'policy',
      reason: `session policy grant (always-allow): ${req.resource}`,
      degraded: this.#degraded,
      ts: Date.now(),
    })
  }

  /**
   * 规则直判（1.13.0 K-FS-2）：文件/命令/网络规则轴命中后的 policy 双向直判——宿主规则引擎
   * （允许/拒绝档）在授权门内直决，reason 必须携带规则标识（审计可回答「为什么没问人」）。
   * 幂等键同现行（同 authorizationId 返回同一决策）；EventKind 冻结面零新增（复用 #commit 形态）。
   */
  decideByRule(req: AuthzRequest, rule: { decision: 'APPROVED' | 'DENIED'; reason: string }): AuthzDecision {
    return this.#commit({
      authorizationId: req.authorizationId,
      decision: rule.decision,
      decidedBy: 'policy',
      reason: rule.reason,
      degraded: this.#degraded,
      ts: Date.now(),
    })
  }

  /**
   * 人审（confirm 模式）：120s 超时默认拒绝（timeout-default-deny）。
   * 1.25.1 回调返回形态加法：boolean（既有）| { approve: boolean; note?: string }（用户实答
   * 对象——附注随决策落链；批准/拒绝两档皆可带；归一后空串/非串附注丢弃或 fail-visible）。
   */
  async decideByUser(req: AuthzRequest, approve: (req: AuthzRequest) => Promise<boolean | { approve: boolean; note?: string }>): Promise<AuthzDecision> {
    const cached = this.#decisions.get(req.authorizationId)
    if (cached) return cached // 幂等：同 id 返回同一决策（防重放不一致）
    let raw: boolean | { approve: boolean; note?: string }
    try {
      raw = await Promise.race([
        approve(req),
        new Promise<false>(resolve => setTimeout(() => resolve(false), this.#timeoutMs)),
      ])
    } catch { raw = false }
    // 归一（1.25.1 D-V12-1）：boolean = 既有形态（含超时竞速 false——EXPIRED 无附注）；
    // 对象 = 用户实答（附注可落）；对象缺布尔 approve = fail-visible 决策不落链
    let approved: boolean
    let note: string | undefined
    if (typeof raw === 'boolean') {
      approved = raw
    } else if (raw && typeof raw === 'object' && typeof (raw as { approve?: unknown }).approve === 'boolean') {
      approved = (raw as { approve: boolean }).approve
      const n = (raw as { note?: unknown }).note
      if (n !== undefined) {
        if (typeof n !== 'string' || !n.trim().length) {
          throw new Error(`CAR-E-AUTHZ-NOTE: 决策附注非法（${typeof n}${typeof n === 'string' ? '/空串' : ''}——fail-visible，须非空字符串；决策未落链）`)
        }
        note = n
      }
    } else {
      throw new Error('CAR-E-AUTHZ-NOTE: 人审回调对象形态缺布尔 approve（fail-visible——宿主回调契约违规；决策未落链）')
    }
    const decision: AuthzDecision = {
      authorizationId: req.authorizationId,
      decision: approved ? 'APPROVED' : 'EXPIRED',
      decidedBy: approved ? 'user' : 'timeout',
      reason: approved ? 'user approved within timeout' : `approval timeout after ${this.#timeoutMs}ms (default-deny)`,
      degraded: this.#degraded,
      ts: Date.now(),
      ...(note ? { note } : {}),
    }
    return this.#commit(decision)
  }

  #commit(d: AuthzDecision): AuthzDecision {
    const existing = this.#decisions.get(d.authorizationId)
    if (existing) return existing
    this.#decisions.set(d.authorizationId, d)
    // 授权留痕：authorization/* 事件（写会话日志先于执行——先落日志后放行由调用方保证顺序）；
    // 1.25.1：用户附注随决策事件 payload 落链（单事件完整审计面——Model-visible means logged 同源）
    this.#log.append('runtime', 'turnEnd', `authz:${d.authorizationId}`, {
      authorizationId: d.authorizationId, decision: d.decision, decidedBy: d.decidedBy, degraded: d.degraded,
      ...(d.note ? { note: d.note } : {}),
    }, { reason: d.reason })
    return d
  }
}
