/**
 * F6 · 插件装配层：manifest 校验 + 免编译加载（缓存击穿热重载）+ Stub 占位 + invalidate
 *
 * 口径：
 *  - 载体：jiti 实装受阻（沙箱 npm），以 Node --experimental-transform-types + 动态 import
 *    查询串缓存击空承载（POC-2 同口径）；被测不变量与载体无关
 *  - Stub 占位（Pi 范式，CAR 自研层）：**注册类动作始终可用（收集待注册项）**，
 *    「依赖宿主绑定的能力查询」在 bindCore 前一调用即抛错——用启动期显式失败换运行期时序正确
 *  - invalidate：unload/reload 后旧句柄访问显式报错（CAR-INVALIDATED）
 *  - manifest：name 必填、version 精确 semver（禁区间）；peer 校验挂点预留（O7，M2 启用）
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { checkErasableOnly } from '../ptc/erasable.ts'

/** 简易 semver 区间求解（M2 S5：仅支持 ^x.y.z / x.y.z 两种形态；完整区间求解 M3 扩展） */
function satisfiesRange(version: string, range: string): boolean {
  if (range === version) return true
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  if (!m) return false
  const [M, mnr, P] = version.split('.').map(Number)
  // npm caret 语义：左起第一个非零位锁定（^1.2.3→>=1.2.3 <2；^0.2.3→>=0.2.3 <0.3；^0.0.3→==0.0.3）
  if (M !== Number(m[1])) return false
  if (M > 0) {
    if (mnr !== Number(m[2])) return mnr > Number(m[2])
    return P >= Number(m[3])
  }
  if (mnr !== Number(m[2])) return false // ^0.x：minor 锁定
  return P >= Number(m[3])
}

/**
 * F10 · peer 版本约束校验（严格模式默认 + 显式豁免，经中间确认⑥）
 * 冲突 = 加载期硬报错并输出冲突链；豁免需 manifest.peerPolicyOverride（reason 必填→审计留痕）
 */
export interface PeerViolation { peer: string; range: string; installed: string | null; optional: boolean }

export function validatePeers(manifest: Manifest, installed: Map<string, string>): { exempted: boolean; violations: PeerViolation[] } {
  const violations: PeerViolation[] = []
  for (const p of manifest.peers ?? []) {
    const v = installed.get(p.peer)
    if (v === undefined) {
      if (!p.optional) violations.push({ peer: p.peer, range: p.range, installed: null, optional: false })
      continue
    }
    if (!satisfiesRange(v, p.range)) violations.push({ peer: p.peer, range: p.range, installed: v, optional: !!p.optional })
  }
  const hard = violations.filter(v => !v.optional)
  if (!hard.length) return { exempted: false, violations }
  if (manifest.peerPolicyOverride?.relaxed) {
    // 显式豁免：放宽生效，调用方负责将 manifest.peerPolicy='exempt' 写入审计（留痕）
    return { exempted: true, violations }
  }
  // 严格模式默认：冲突链硬报错（文件/依赖路径/区间/实际版本）
  const chainStr = hard.map(v => `${v.peer}@${v.range} required but ${v.installed ?? '<missing>'} installed`).join('; ')
  throw new Error(`CAR-E-PEER: peer dependency conflict for "${manifest.name}" — ${chainStr}（放宽需 manifest.peerPolicyOverride 显式声明 + reason，审计留痕）`)
}

export interface Manifest {
  name: string
  version: string
  peers?: Array<{ peer: string; range: string; optional?: boolean }>
  peerPolicyOverride?: { relaxed: true; reason: string }
}

const SEMVER_EXACT = /^\d+\.\d+\.\d+$/
const chain = (file: string, detail: string) => `CAR-E-MANIFEST: ${detail} (conflict chain: ${file})`

export function parseManifest(raw: unknown, file = '<manifest>'): Manifest {
  const m = raw as Manifest
  if (!m || typeof m !== 'object') throw new Error(chain(file, 'manifest must be an object'))
  if (!m.name || typeof m.name !== 'string') throw new Error(chain(file, 'field "name" is required and must be a string'))
  if (!m.version || !SEMVER_EXACT.test(m.version)) {
    throw new Error(chain(file, `field "version" must be exact semver (x.y.z), got "${m.version}"（版本区间仅用于 peer 校验）`))
  }
  if (m.peerPolicyOverride && !m.peerPolicyOverride.reason) {
    throw new Error(chain(file, 'field "peerPolicyOverride.reason" is required when豁免声明（审计留痕）'))
  }
  return m
}

export interface ToolReg { name: string; run: (args: any) => Promise<unknown> }
export interface CommandReg { name: string; run: (args: string[]) => Promise<void> }
export interface PluginApi {
  registerTool(tool: ToolReg): void
  registerCommand(cmd: CommandReg): void
  getRegisteredTools(): ToolReg[]
}

interface HostBinding {
  registerTool?(tool: ToolReg): void
  registerCommand?(cmd: CommandReg): void
  getRegisteredTools(): ToolReg[]
}

class ApiImpl {
  #host: HostBinding | undefined
  #pendingTools: ToolReg[] = []
  #pendingCommands: CommandReg[] = []
  registerTool(tool: ToolReg): void {
    if (this.#host?.registerTool) { this.#host.registerTool(tool); return }
    this.#pendingTools.push(tool) // 注册类动作始终可用：Stub 期收集，bind 后冲刷
  }
  registerCommand(cmd: CommandReg): void {
    if (this.#host?.registerCommand) { this.#host.registerCommand(cmd); return }
    this.#pendingCommands.push(cmd)
  }
  getRegisteredTools(): ToolReg[] {
    // 依赖宿主绑定的能力查询：bindCore 前一调用即抛错（Stub 显式失败）
    if (!this.#host) throw new Error('CAR-STUB: "getRegisteredTools" called before bindCore（启动期显式失败换运行期时序正确）')
    return this.#host.getRegisteredTools()
  }
  bindHost(host: HostBinding): void {
    this.#host = host
    for (const t of this.#pendingTools) host.registerTool?.(t)
    for (const c of this.#pendingCommands) host.registerCommand?.(c)
    this.#pendingTools = []
    this.#pendingCommands = []
  }
}

export interface LoadedPlugin {
  manifest: Manifest
  api: PluginApi
  bindCore(host: HostBinding): void
  invalidate(): void
  isInvalidated(): boolean
}

/** 装配插件模块（免编译加载 + Stub 占位 + invalidate 语义） */
export async function mountPlugin(spec: {
  file: string
  manifest: unknown
  /** reload 版本号：每次 +1 变更 import 查询串击穿 ESM 缓存 */
  reloadEpoch?: number
}): Promise<LoadedPlugin> {
  const manifest = parseManifest(spec.manifest, spec.file)
  const epoch = spec.reloadEpoch ?? 0
  // erasable-only 双挂点之二：loader 提交链（挂点一在 run_code 入口——单一事实源 checkErasableOnly）
  const era = checkErasableOnly(readFileSync(spec.file, 'utf-8'))
  if (!era.ok) throw new Error(`CAR-E-PTC: ${era.violation} (file: ${spec.file})`)
  const mod = (await import(pathToFileURL(spec.file).href + (epoch ? `?epoch=${epoch}` : ''))) as {
    default: (api: PluginApi) => void
  }
  if (typeof mod.default !== 'function') {
    throw new Error(chain(spec.file, 'plugin module must default-export a factory (api) => void'))
  }
  let alive = true
  const apiImpl = new ApiImpl()
  const api: PluginApi = new Proxy(apiImpl as unknown as PluginApi, {
    get(target, prop: string) {
      if (!alive) throw new Error(`CAR-INVALIDATED: "${prop}" on stale plugin context（旧上下文已失效，请重新加载）`)
      const v = (target as any)[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  mod.default(api)
  return {
    manifest,
    api,
    bindCore(host: HostBinding) { apiImpl.bindHost(host) },
    invalidate() { alive = false },
    isInvalidated() { return !alive },
  }
}
