/**
 * T-3/T-4 · registry 对接（M3-S13 落位 + M4-S17 T-5 终局对齐增补）
 *
 * 口径（M3部署设计增补 §3 + M3安全设计增补 T-4 + 决议⑦ + M4安全增补registry对齐 定稿）：
 *  - **registries 清单即白名单本身**：白名单外默认拒绝 + 审计落盘（不做静默 fallback）；
 *  - resolution 四级顺序：①显式源绑定（校验级失败**硬失败不换源**——换源重试已拒内容 = 降级攻击面）
 *    → ②白名单 priority 升序（网络级失败可按 priority 继续——exclude 通道，类型上仅允许 reason='network'）
 *    → ③公共 npm 兜底（缺省 false——**候选耗尽**或白名单为空时生效，企业内网安全默认）
 *    → ④全不可用 = 离线拒绝（显式错误，非静默）；
 *  - **signed 字段语义（T-5 定稿①）**：签名物承载方式（true=源直供 / false=镜像透传），**永不产生免验/降档/直信**——验签义务恒在 verifier 层（ADR-003）；
 *  - 本模块纯判定（零网络 I/O），CI 可全量测试。
 */
import { createHash } from 'node:crypto'

export interface RegistryEntry { url: string; priority: number; /** 签名物承载方式（T-5 定稿①：不参与信任分级，验签义务恒在 verifier） */ signed: boolean }

export interface RegistryConfig {
  registries: RegistryEntry[]
  /** 公共 npm 兜底（缺省必须显式声明——企业内网 false 为试点准入判据，T-5 定稿③） */
  allowNpmFallback: boolean
  /** 离线模式：全部拒绝（显式错误） */
  offline: boolean
}

export interface PackageSpec { name: string; version: string; /** 显式源绑定（manifest registry 字段）——校验级失败硬失败不换源 */ pinnedRegistry?: string }

export type ResolutionSource = 'registry' | 'npm-fallback' | 'rejected'

export interface Resolution {
  source: ResolutionSource
  url?: string
  /** 判定摘要（审计落盘 payload；含拒绝原因/解析路径） */
  detail: string
  /** 解析决策指纹（可落审计哈希链） */
  decisionId: string
}

/**
 * 单源失败排除记录（T-5 定稿②）：reason 类型层仅允许 'network'——
 * 「校验级失败换源」在本签名上不可表达（校验失败由调用方硬拒，不经本层换源）。
 */
export type ExcludedSource = { url: string; reason: 'network' }

export function resolvePackage(spec: PackageSpec, config: RegistryConfig, audit?: (detail: Record<string, unknown>) => void, opts: { exclude?: ExcludedSource[] } = {}): Resolution {
  const finish = (r: Omit<Resolution, 'decisionId'>): Resolution => {
    const decisionId = 'RD-' + createHash('sha256').update(JSON.stringify({ spec, r })).digest('hex').slice(0, 16)
    audit?.({ kind: 'registry-resolution', spec: spec.name, ...r, decisionId })
    return { ...r, decisionId }
  }
  // ④ 离线：全拒（最高优先级——离线声明不可被任何源覆盖）
  if (config.offline) return finish({ source: 'rejected', detail: 'offline mode: all sources rejected（显式拒绝，非静默）' })
  const excluded = new Set((opts.exclude ?? []).map(e => e.url))
  // ① 显式源绑定：校验级失败硬失败不换源（pinned 不在白名单）；
  //   pinned 命中但被 exclude（网络失败）→ 语义同「按 priority 继续」（T-5 定稿②网络路径）
  if (spec.pinnedRegistry) {
    const pinned = config.registries.find(r => r.url === spec.pinnedRegistry)
    if (!pinned) return finish({ source: 'rejected', detail: `pinned registry "${spec.pinnedRegistry}" not in whitelist——显式绑定不在白名单，硬失败不换源（fail-closed）` })
    if (!excluded.has(pinned.url)) {
      return finish({ source: 'registry', url: pinned.url, detail: `pinned to ${pinned.url}（priority=${pinned.priority}）` })
    }
    // pinned 网络失败：落审计后按 priority 继续剩余白名单（不含 pinned）
  }
  // ② 白名单 priority 升序（排除网络失败源）
  const sorted = [...config.registries].sort((a, b) => a.priority - b.priority).filter(r => !excluded.has(r.url))
  if (sorted.length) {
    const first = sorted[0]
    return finish({ source: 'registry', url: first.url, detail: `whitelist priority order → ${first.url}（candidates=${sorted.length}${excluded.size ? `, excluded=${excluded.size}` : ''}）` })
  }
  // ③ 公共 npm 兜底（**候选耗尽**或白名单为空时生效——T-5 定稿②③修正语义）
  if (config.allowNpmFallback) {
    const why = config.registries.length ? 'candidates exhausted（网络级失败耗尽）' : 'whitelist empty'
    return finish({ source: 'npm-fallback', url: 'https://registry.npmjs.org', detail: `${why} → npm fallback（显式开启；兜底命中包强制过 verifier 不降级）` })
  }
  return finish({ source: 'rejected', detail: config.registries.length
    ? 'candidates exhausted and npm fallback disabled——候选耗尽且兜底关闭（fail-closed）'
    : 'no whitelist entries and npm fallback disabled——白名单为空且兜底关闭（企业内网安全默认）' })
}

/** 只读预览（T-5 定稿②新增）：返回按优先级的候选链（不含 pinned 语义，供装载面展示与演练） */
export function resolveCandidateChain(config: RegistryConfig): { chain: string[]; fallback: boolean } {
  const chain = [...config.registries].sort((a, b) => a.priority - b.priority).map(r => r.url)
  return { chain, fallback: config.allowNpmFallback }
}

/** 白名单校验（插件安装面调用：来源不在清单 = 拒绝并审计） */
export function isWhitelisted(url: string, config: RegistryConfig): boolean {
  return !config.offline && config.registries.some(r => r.url === url)
}
