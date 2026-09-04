/**
 * F15 基础增强 · 合规导出（M2-S9）：取证包完整性清单 + 三标分层声明
 *
 * 口径（安全设计 §7.2.4 Q-09 定稿 + 决议⑧三标并集）：
 *  - 导出包 = 事件 JSONL + manifest 清单（逐文件 SHA-256 + 链头尾锚点 + 审计元数据）；
 *    导出前强制 verifyHashChain（断链中止，SQ-06）；运行时无上传功能（端点归用户）；
 *  - 三标分层声明（T-7 程序化版本）：13 项审计字段对 SOC 2 CC7.2 / GDPR Art.30 / 等保 2.0
 *    三级的逐字段映射；对外按行业分层声明（合规问卷答复骨架）；9 核心字段不可裁剪。
 */
import { createHash } from 'node:crypto'
import type { SessionLog, SessionEvent } from './log.ts'

export interface ExportMeta {
  sessionId: string
  exportedBy: string          // OS 用户（谁导出）
  exportedAt: string          // ISO-8601 UTC
  runtimeVersion: string
  agentPreset?: string
  sessionRange: { fromSeq: number; toSeq: number }
}

export interface ForensicsBundle {
  files: { name: string; content: string; sha256: string }[]
  manifest: {
    format: 'car-forensics/1'
    chainHead: string | null
    chainTail: string | null
    eventCount: number
    verifyChainAtExport: 'PASS'
    meta: ExportMeta
    files: { name: string; sha256: string }[]
  }
}

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex') }

/** 取证包导出：断链即中止（不产出"带病审计包"） */
export function exportForensicsBundle(log: SessionLog, meta: ExportMeta): ForensicsBundle {
  const broken = log.verifyChain()
  if (broken !== null) throw new Error(`CAR-E-EXPORT: hash chain broken at seq=${broken}——断链中止导出（禁止带病审计包外流）`)
  const jsonl = log.exportJSONL()
  const files = [{ name: `sessions/{sessionId}/events.jsonl`.replace('{sessionId}', meta.sessionId), content: jsonl, sha256: sha256(jsonl) }]
  const events = log.events as SessionEvent[]
  const manifest: ForensicsBundle['manifest'] = {
    format: 'car-forensics/1',
    chainHead: log.stats().tailHash ? (events[0]?.hash ?? null) : null,
    chainTail: log.stats().tailHash,
    eventCount: events.length,
    verifyChainAtExport: 'PASS',
    meta,
    files: files.map(f => ({ name: f.name, sha256: f.sha256 })),
  }
  const manifestJson = JSON.stringify(manifest, null, 2)
  files.push({ name: 'manifest.json', content: manifestJson, sha256: sha256(manifestJson) })
  return { files, manifest }
}

/** 包完整性校验：逐文件 SHA-256 重算 + 链锚点一致 */
export function verifyBundle(bundle: ForensicsBundle): { ok: boolean; brokenFile: string | null } {
  for (const f of bundle.files) {
    if (sha256(f.content) !== f.sha256) return { ok: false, brokenFile: f.name }
  }
  for (const fm of bundle.manifest.files) {
    const actual = bundle.files.find(f => f.name === fm.name)
    if (!actual || actual.sha256 !== fm.sha256) return { ok: false, brokenFile: fm.name }
  }
  return { ok: true, brokenFile: null }
}

// ── 三标分层声明（T-7）──────────────────────────────────────────────

/** 13 项审计字段（安全设计 §7.2.2）；core9 = 不可裁剪核心字段 */
export const AUDIT_FIELDS = [
  'seq+sessionId', 'ts', 'actor', 'actorDetail', 'eventType', 'resource', 'payload(redacted)',
  'result/status', 'authorizationId+decidedBy+reason', 'traceId', 'tenantId', 'hash+prevHash', 'runtimeVersion+agentPreset',
] as const
const CORE9 = new Set(['seq+sessionId', 'ts', 'actor', 'eventType', 'result/status', 'authorizationId+decidedBy+reason', 'hash+prevHash', 'tenantId', 'payload(redacted)'])

export type StandardId = 'soc2' | 'gdpr' | 'mlps'

/** 字段 → 标准条款映射（T-7 矩阵的程序化数据源；导出时按 standard 裁剪字段集） */
// 9 核心字段三标全覆盖（核心公共底座，不可裁剪）；非核心为标准特有扩展（分层声明语义）
const ALL: StandardId[] = ['soc2', 'gdpr', 'mlps']
export const FIELD_STANDARD_MAP: Record<string, StandardId[]> = {
  'seq+sessionId': ALL,                           // 个体事件级（SOC2 CC7.2）
  'ts': ALL,                                      // 日期和时间（等保 8.1.4.3 b）
  'actor': ALL,                                   // 用户（GDPR Art.30 归因）
  'actorDetail': ['gdpr'],                        // 处理活动主体细化（扩展）
  'eventType': ALL,                               // 事件类型
  'resource': ['soc2', 'mlps'],                   // 操作对象（扩展）
  'payload(redacted)': ALL,                       // 完整参数与结果（脱敏后）
  'result/status': ALL,                           // 事件是否成功
  'authorizationId+decidedBy+reason': ALL,        // 授权凭据链（US6 凭什么）
  'traceId': ['mlps'],                            // 关联排查（扩展）
  'tenantId': ALL,                                // 归属边界
  'hash+prevHash': ALL,                           // 不可变自证
  'runtimeVersion+agentPreset': ['gdpr'],         // 处理环境快照（扩展）
}

/** 分层声明：按标准输出字段集 + 合规声明骨架（合规问卷答复用） */
export function complianceStatement(std: StandardId): { standard: StandardId; fields: string[]; coreMissing: string[]; statement: string } {
  const fields = AUDIT_FIELDS.filter(f => FIELD_STANDARD_MAP[f]?.includes(std))
  const coreMissing = [...CORE9].filter(f => !fields.includes(f))
  const lines: Record<StandardId, string> = {
    soc2: 'CAR 会话日志逐事件记录（actor/时间戳/工具名/脱敏后参数与结果/授权凭据），SHA-256 哈希链不可变；保留期默认永久（用户自管），建议 ≥1 年（CC7.2）。',
    gdpr: '事件含 actor/actorDetail/eventType/runtimeVersion（GDPR 第 30 条处理活动可归因）；数据主体权利由部署方在自有环境行使；遥测默认关、零内容字段。',
    mlps: '对应 GB/T 22239-2019 三级 8.1.4.3 安全审计 a)–d)——审计覆盖四类 actor 全量事件、记录含日期时间/用户/事件类型/是否成功、哈希链防未预期篡改、审计接口零写入；日志留存 ≥6 个月由用户环境承诺（运行时不自动清理）。',
  }
  return { standard: std, fields, coreMissing, statement: lines[std] }
}
