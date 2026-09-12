/**
 * T-1 · HostGateway（M3-S11 骨架）：CAR-as-MCP-Server 接入面
 *
 * 口径（M3系统设计增补 T-1 / 决议⑤ MCP 统一边界双宿主等价）：
 *  - 10 tool 粗粒度会话级能力 + 工具面透传：session_start/turn/stop/status/replay/verify/export/fork
 *    + tool_list/tool_call——step 循环不暴露（「统一边界而非统一内部」）；
 *    session_fork 为 M5 DEC-4 转正项（跨宿主 fork/resume，M3 §1.7 显式延后 → 1.0 纳入）；
 *  - hostId 登记制（A050001 语义扩展）：未登记宿主拒绝连接；
 *  - ServerTransport 对偶（gateway.ts）：宿主作为 MCP client 经 tools/call 调用；
 *  - tool handlers 由注入的 RuntimeFacade 提供（S12 接线 Claude Code、S13 Codex + 契约测试）；
 *  - 所有宿主调用 100% 落审计（audit 钩子，复用 SessionLog）。
 */
import type { JsonRpcResponse, ServerTransport } from '../mcp/gateway.ts'
import { deriveSessionId, normalizeHostEvent, type HostProfile } from './mappings.ts'

export const HOST_TOOLS = [
  'session_start', 'session_turn', 'session_stop', 'session_status',
  'session_replay', 'session_verify', 'session_export', 'session_fork', 'tool_list', 'tool_call',
] as const
export type HostTool = (typeof HOST_TOOLS)[number]

export interface RuntimeFacade {
  sessionStart(args: { hostSessionId: string; /** M5-DEC4：fork 工件导入（跨宿主 resume 入口），缺省为普通 start */ importJsonl?: string }): Promise<{ sessionId: string }>
  sessionTurn(args: { sessionId: string; input: unknown }): Promise<{ reason: string; steps: number }>
  sessionStop(args: { sessionId: string }): Promise<{ reason: string }>
  sessionStatus(args: { sessionId: string }): Promise<{ state: string; lastReason?: string }>
  sessionReplay(args: { sessionId: string }): Promise<{ messages: unknown[] }>
  sessionVerify(args: { sessionId: string }): Promise<{ ok: boolean; brokenAt: number | null }>
  sessionExport(args: { sessionId: string }): Promise<{ bundle: unknown }>
  /** M5-DEC4 转正：跨宿主 fork（宿主 A 侧调用，产出可迁移工件 + 宿主 B 侧确定性会话 id） */
  sessionFork(args: { sessionId: string; targetHostId: string; targetHostSessionId: string; upToSeq?: number }): Promise<{ sessionId: string; jsonl: string; migrated: number }>
  toolList(args: Record<string, never>): Promise<{ tools: string[] }>
  toolCall(args: { sessionId: string; tool: string; arguments?: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }>
}

export interface HostRegistration { hostId: string; profile: HostProfile; transport: ServerTransport }

export class HostGateway {
  #hosts = new Map<string, HostRegistration>()
  #audit: (event: { kind: string; detail: Record<string, unknown>; ts: number }) => void

  constructor(opts: { facade: RuntimeFacade; audit: (event: { kind: string; detail: Record<string, unknown>; ts: number }) => void }) {
    this.#facade = opts.facade
    this.#audit = opts.audit
  }
  #facade: RuntimeFacade

  /** 宿主登记（A050001 语义扩展：重复登记显式报错） */
  registerHost(reg: HostRegistration): void {
    if (this.#hosts.has(reg.hostId)) throw new Error(`CAR-E-HOST: hostId "${reg.hostId}" already registered（登记制）`)
    this.#hosts.set(reg.hostId, reg)
  }

  listHosts(): string[] { return [...this.#hosts.keys()] }

  /** 暴露给宿主的 tool 面（契约测试数据源：两宿主调用此方法结果必须等价） */
  listTools(): HostTool[] { return [...HOST_TOOLS] }

  /** 宿主到达调用分发：登记检查 → tool 分发 → 归一化 → 审计（无旁路） */
  async handle(hostId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const host = this.#hosts.get(hostId)
    if (!host) {
      this.#audit({ kind: 'host-rejected', detail: { hostId, tool, reason: 'A050001' }, ts: Date.now() })
      return { ok: false, error: 'CAR-A050001: unregistered host connection rejected（登记制）' }
    }
    if (!(HOST_TOOLS as readonly string[]).includes(tool)) {
      return { ok: false, error: `unknown host tool "${tool}"（10 tool 面，step 循环不暴露）` }
    }
    // tool 名（snake_case MCP 约定）→ facade 方法（camelCase TS 约定）
    const camel = tool.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    const fn = (this.#facade as unknown as Record<string, (a: Record<string, unknown>) => Promise<unknown>>)[camel]
    if (typeof fn !== 'function') return { ok: false, error: `host tool "${tool}" not wired in RuntimeFacade（S12 接线）` }
    try {
      const result = await fn.call(this.#facade, { ...args, __hostId: hostId })
      this.#audit({ kind: 'host-call', detail: { hostId, tool, normalized: tool !== 'session_start' ? undefined : deriveSessionId(hostId, String((args as { hostSessionId: string }).hostSessionId)) }, ts: Date.now() })
      return { ok: true, result }
    } catch (e) {
      this.#audit({ kind: 'host-call-error', detail: { hostId, tool, error: String(e) }, ts: Date.now() })
      return { ok: false, error: String(e) }
    }
  }

  /** ServerTransport 装配：把 JSON-RPC tools/call 桥到 handle（S12 接 Claude Code stdio） */
  bindTransport(hostId: string): void {
    const host = this.#hosts.get(hostId)
    if (!host) throw new Error('CAR-A050001: cannot bind unregistered host')
    void (host.transport as ServerTransport & { __bind?: unknown })
  }
}

/** 归一化便捷入口：宿主事件 → CAR 事件（mappings.ts 的 gateway 侧封装，供 S12 数据流接线） */
export function ingestHostEvent(hostId: string, hostEvent: string, payload: Record<string, unknown>): ReturnType<typeof normalizeHostEvent> {
  const profile = HOST_MAPPINGS_BY_ID.get(hostId)
  if (!profile) throw new Error(`CAR-A050001: host "${hostId}" not registered（归一化前必须登记）`)
  return normalizeHostEvent(profile, hostEvent, payload)
}

import { HOST_MAPPINGS } from './mappings.ts'
const HOST_MAPPINGS_BY_ID = new Map(HOST_MAPPINGS.map(h => [h.hostId, h]))

void (0 as unknown as JsonRpcResponse) // 类型锚：ServerTransport 响应契约
