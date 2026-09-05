/**
 * T-3/T-4 · registry 对接（M3-S13 方案定稿的代码落位）
 *
 * 口径（M3部署设计增补 §3 + M3安全设计增补 T-4 + 决议⑦）：
 *  - **registries 清单即白名单本身**：白名单外默认拒绝 + 审计落盘（不做静默 fallback）；
 *  - resolution 四级顺序：①显式源绑定（插件 manifest 指定 registry——失败**硬失败不降级**）
 *    → ②白名单 priority 升序逐源尝试 → ③公共 npm 兜底（**可关**，企业内网默认关）
 *    → ④全不可用 = 离线拒绝（显式错误，非静默）；
 *  - fail-closed 组合权威 = security（T-4 对齐门 S13 评审）：本模块提供配置面与判定逻辑，
 *    网络拉取与验签（ADR-003 双轨）由调用方衔接——签名校验失败在 verifier 层，与本层白名单判定独立叠加；
 *  - 本模块纯判定（零网络 I/O），CI 可全量测试。
 */
import { createHash } from 'node:crypto'

export interface RegistryEntry { url: string; priority: number; /** 该源是否承载签名（false = 镜像仅透传，验签走 ADR-003） */ signed: boolean }

export interface RegistryConfig {
  registries: RegistryEntry[]
  /** 公共 npm 兜底（企业内网默认 false——安全默认） */
  allowNpmFallback: boolean
  /** 离线模式：全部拒绝（显式错误） */
  offline: boolean
}

export interface PackageSpec { name: string; version: string; /** 显式源绑定（manifest registry 字段）——失败硬失败不降级 */ pinnedRegistry?: string }

export type ResolutionSource = 'registry' | 'npm-fallback' | 'rejected'

export interface Resolution {
  source: ResolutionSource
  url?: string
  /** 判定摘要（审计落盘 payload；含拒绝原因/解析路径） */
  detail: string
  /** 解析决策指纹（可落审计哈希链） */
  decisionId: string
}

export function resolvePackage(spec: PackageSpec, config: RegistryConfig, audit?: (detail: Record<string, unknown>) => void): Resolution {
  const finish = (r: Omit<Resolution, 'decisionId'>): Resolution => {
    const decisionId = 'RD-' + createHash('sha256').update(JSON.stringify({ spec, r })).digest('hex').slice(0, 16)
    audit?.({ kind: 'registry-resolution', spec: spec.name, ...r, decisionId })
    return { ...r, decisionId }
  }
  // ④ 离线：全拒（最高优先级——离线声明不可被任何源覆盖）
  if (config.offline) return finish({ source: 'rejected', detail: 'offline mode: all sources rejected（显式拒绝，非静默）' })
  // ① 显式源绑定：失败硬失败，不降级
  if (spec.pinnedRegistry) {
    const pinned = config.registries.find(r => r.url === spec.pinnedRegistry)
    if (!pinned) return finish({ source: 'rejected', detail: `pinned registry "${spec.pinnedRegistry}" not in whitelist——显式绑定失败不降级（fail-closed）` })
    return finish({ source: 'registry', url: pinned.url, detail: `pinned to ${pinned.url}（priority=${pinned.priority}）` })
  }
  // ② 白名单 priority 升序
  const sorted = [...config.registries].sort((a, b) => a.priority - b.priority)
  if (sorted.length) {
    const first = sorted[0]
    return finish({ source: 'registry', url: first.url, detail: `whitelist priority order → ${first.url}（candidates=${sorted.length}）` })
  }
  // ③ 公共 npm 兜底（可关）
  if (config.allowNpmFallback) {
    return finish({ source: 'npm-fallback', url: 'https://registry.npmjs.org', detail: 'whitelist empty → npm fallback（显式开启）' })
  }
  return finish({ source: 'rejected', detail: 'no whitelist entries and npm fallback disabled——白名单为空且兜底关闭（企业内网安全默认）' })
}

/** 白名单校验（插件安装面调用：来源不在清单 = 拒绝并审计） */
export function isWhitelisted(url: string, config: RegistryConfig): boolean {
  return !config.offline && config.registries.some(r => r.url === url)
}
