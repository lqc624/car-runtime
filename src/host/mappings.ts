/**
 * T-1 · 多宿主归一化 schema（host-mappings-v1，M3-S11）
 *
 * 口径（M3系统设计增补 T-1 / 决议⑤）：
 *  - session id 归一化：确定性派生 SH- + sha256(hostId|hostSessionId)——幂等免映射表存储；
 *    首次映射落哈希链登记事件（调用方职责）；显式拒绝解析宿主 id 语义（对闭源漂移免疫）；
 *  - 事件归一化：版本化映射表数据驱动（HOST_MAPPINGS），pattern 命中 → CAR EventKind + actor；
 *    **未命中一律降级 hostRaw 留痕（零静默，机器可断言）**；
 *  - 宿主标识字符串只允许出现在本数据文件（静态架构断言红线，测试强制）。
 */
import { createHash } from 'node:crypto'
import type { EventKind } from '../session/log.ts'

/** 跨宿主会话 id：SH- 前缀 + 24 hex（sha256 前 12 字节） */
export function deriveSessionId(hostId: string, hostSessionId: string): string {
  return 'SH-' + createHash('sha256').update(`${hostId}|${hostSessionId}`).digest('hex').slice(0, 24)
}

export interface HostEventMapping {
  /** 宿主事件名（精确匹配 v1；glob/regex v2 评估） */
  hostEvent: string
  kind: EventKind
  actor: 'user' | 'model' | 'plugin' | 'runtime'
  /** 宿主 payload 字段 → CAR payload 字段（浅拷贝重命名） */
  payloadMap?: Record<string, string>
}

export interface HostProfile {
  hostId: string
  /** 映射表版本（契约变更须升版本 + 双轨过渡一个迭代） */
  schemaVersion: 'host-mappings-v1'
  mappings: HostEventMapping[]
}

/** host-mappings-v1：Claude Code / Codex 等价映射（同一接入面，两份纯数据 profile） */
export const HOST_MAPPINGS: HostProfile[] = [
  {
    hostId: 'claude-code',
    schemaVersion: 'host-mappings-v1',
    mappings: [
      { hostEvent: 'user_message', kind: 'user', actor: 'user', payloadMap: { content: 'text' } },
      { hostEvent: 'assistant_message', kind: 'assistant', actor: 'model', payloadMap: { content: 'text' } },
      { hostEvent: 'tool_use', kind: 'toolCall', actor: 'model', payloadMap: { tool_name: 'tool', tool_call_id: 'id' } },
      { hostEvent: 'tool_result', kind: 'toolResult', actor: 'model', payloadMap: { tool_call_id: 'id' } },
      { hostEvent: 'turn_complete', kind: 'turnEnd', actor: 'runtime' },
    ],
  },
  {
    hostId: 'codex',
    schemaVersion: 'host-mappings-v1',
    mappings: [
      { hostEvent: 'input_item', kind: 'user', actor: 'user', payloadMap: { text: 'text' } },
      { hostEvent: 'agent_message', kind: 'assistant', actor: 'model', payloadMap: { message: 'text' } },
      { hostEvent: 'function_call', kind: 'toolCall', actor: 'model', payloadMap: { name: 'tool', call_id: 'id' } },
      { hostEvent: 'function_call_output', kind: 'toolResult', actor: 'model', payloadMap: { call_id: 'id' } },
      { hostEvent: 'task_complete', kind: 'turnEnd', actor: 'runtime' },
    ],
  },
]

export interface NormalizedEvent { kind: EventKind; actor: string; payload: Record<string, unknown>; degraded: boolean }

/** 事件归一化：命中映射 → 转写；未命中 → hostRaw 降级（payload 原样保留，零静默） */
export function normalizeHostEvent(profile: HostProfile, hostEvent: string, payload: Record<string, unknown> = {}): NormalizedEvent {
  const m = profile.mappings.find(x => x.hostEvent === hostEvent)
  if (!m) {
    return { kind: 'hostRaw', actor: 'runtime', payload: { hostId: profile.hostId, hostEvent, raw: payload }, degraded: true }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    out[m.payloadMap?.[k] ?? k] = v
  }
  return { kind: m.kind, actor: m.actor, payload: out, degraded: false }
}
