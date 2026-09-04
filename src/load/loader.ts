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
