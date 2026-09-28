/**
 * 1.1-S3 签名配置文件通道 → 1.5-S3 完整形态（car.config.ts + zod，D-22）→ 1.6-S3 jiti 载体（D-24）
 *
 * 口径：
 *  - 载体（D-22 + D-24 修订）：发现序 **car.config.ts > car.config.json**（同目录两者并存 = ts 胜出，
 *    json 忽略——禁静默合并）；显式 --config 按扩展名分派（.ts 走 TS 载体，其余 JSON 解析）；
 *    TS 载体 = **jiti 自包含转译**（1.6-S3——零传递依赖 bundled 形态，第二个常规运行时依赖；
 *    D-22「jiti 继续登记不引入」到期出清）：Node 22.19+ 加载 car.config.ts 不再依赖
 *    --experimental-transform-types，非可擦除语法（enum 等 transform-only 形态）可用——
 *    erasable-only 预检登记项随之出清（被取代）；插件加载的原生类型剥离纪律不动。
 *    形态 = `export default {…}`（非对象/缺 default 显式报错）。
 *  - **预热协议**：loadCarConfig 保持同步签名（doctor/resolveSigGate 等既有调用面不动）；
 *    car.config.ts 须先经 warmCarConfig 异步预热入缓存（CLI 入口统一预热），未预热显式报错
 *    （fail-visible，禁静默回退 json——「配置写了但不生效」的漂移面必须显式化）。
 *  - 校验层 zod 化（D-11a ① 修订）：zod ^3 为首个常规运行时依赖（用户点名登记项）；
 *    fail-visible 语义与 CAR-E-CONFIG 错误码保持，zod issues 渲染为 `路径 原因`（首个 issue）；
 *    键位空间与 1.1/1.4 完全一致（sandbox.* / llm.* / mcp.*；mcp.servers 本迭代加 url/headers）。
 *    未登记键 / 类型错 / 坏 JSON / 坏 TS 一律 CAR-E-CONFIG 显式拒绝（禁静默忽略）。
 *  - 优先级（1.1 规划 §3 S3）：flag > env > 配置文件 > 缺省。env 已定义即为显式意见。
 *    无配置文件 + 无 env 时行为与 1.0 完全一致（warn / 无信任根 / 不豁免）。
 *  - 本模块只读配置与合并优先级；门禁判定在 sigGate/verifier。发现序：显式路径 > cwd。
 *  - 代码求值面（D-22 登记）：car.config.ts 为本机文件信任边界（与插件同域；配置无签名机制）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { SignatureGateOptions } from './sigGate.ts'

export const CONFIG_FILENAME = 'car.config.json'
export const CONFIG_TS_FILENAME = 'car.config.ts'

export interface SandboxSigConfig {
  unsignedAllow?: boolean
  sigEnforce?: boolean
  sigTrustRoot?: string
}

export interface LlmConfig {
  baseUrl?: string
  model?: string
  adapterId?: string
  maxTokens?: number
  allowEnvFallback?: boolean
}

export interface McpServerSpec {
  /** stdio 通道启动命令（与 url 互斥——1.5-S2 起二选一显式登记） */
  command?: string
  args?: string[]
  /** 启动环境变量（禁明文凭据——gateway.containsPlaintextCredential 注册时强制检查；仅 command 通道适用） */
  env?: Record<string, string>
  /** 1.5-S2（D-21）：远程 Streamable HTTP 通道（与 command 互斥） */
  url?: string
  /** 1.5-S2（D-21）：远程请求头；值支持 ${ENV_VAR} 引用（凭据禁令 CR-05；仅 url 通道适用） */
  headers?: Record<string, string>
}

export interface CarConfig {
  sandbox?: SandboxSigConfig
  /** 1.4-S3（D-16）：模型接入配置键位空间；凭据禁入（CR-05）——只放端点/模型名/开关 */
  llm?: LlmConfig
  /** 1.4-S7（D-18）：MCP server 登记面（--mcp <id> 显式启用） */
  mcp?: { servers: Record<string, McpServerSpec> }
}

export interface ConfigLoadResult {
  /** 实际读取的配置文件路径（cwd 未发现时缺省——未发现是正常态非错误） */
  path?: string
  config: CarConfig
  /** fail-visible：显式路径不存在 / 坏 JSON / 坏 TS / 未登记键 / 类型错的原因（非空 = 调用方必须中止） */
  error?: string
}

// ==================== zod 校验层（1.5-S3 迁移；错误消息含 s31/s34 回归锚点） ====================

// 叶子消息不含路径——渲染层统一拼 `${path} ${message}`（s31 锚点：'llm.maxTokens 必须为正整数'）
const nonEmptyTrimmed = () =>
  z.string({ invalid_type_error: '必须为非空字符串', required_error: '必须为非空字符串' })
    .trim()
    .refine(v => v.length > 0, { message: '必须为非空字符串' })

const stringMap = () =>
  z.record(z.string(), z.string({ invalid_type_error: '必须为字符串' }), { invalid_type_error: '必须为字符串映射', required_error: '必须为字符串映射' })

const mcpServerSchema = z.object({
  command: nonEmptyTrimmed().optional(),
  url: nonEmptyTrimmed().refine(v => /^https?:\/\//.test(v), { message: '必须为 http(s) URL' }).optional(),
  args: z.array(z.string({ invalid_type_error: '必须为字符串' }), { invalid_type_error: '必须为字符串数组' }).optional(),
  env: stringMap().optional(),
  headers: stringMap().optional(),
}).strict().superRefine((obj, ctx) => {
  const hasCommand = typeof obj.command === 'string' && !!obj.command
  const hasUrl = typeof obj.url === 'string' && !!obj.url
  if (hasCommand === hasUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: '需要 command（stdio）或 url（远程 Streamable HTTP）恰好其一（互斥）' })
    return
  }
  if (obj.args !== undefined && !hasCommand) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['args'], message: '仅 stdio 通道（command）适用' })
  if (obj.env !== undefined && !hasCommand) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['env'], message: '仅 stdio 通道（command）适用' })
  if (obj.headers !== undefined && !hasUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headers'], message: '仅远程通道（url）适用' })
})

const rawSchema = z.object({
  sandbox: z.object({
    unsigned: z.object({
      allow: z.boolean({ invalid_type_error: '必须为布尔', required_error: '必须为布尔' }).optional(),
    }).strict().optional(),
    sig: z.object({
      enforce: z.boolean({ invalid_type_error: '必须为布尔', required_error: '必须为布尔' }).optional(),
      trustRoot: nonEmptyTrimmed().optional(),
    }).strict().optional(),
  }).strict().optional(),
  llm: z.object({
    baseUrl: nonEmptyTrimmed().optional(),
    model: nonEmptyTrimmed().optional(),
    adapterId: nonEmptyTrimmed().optional(),
    maxTokens: z.number({ invalid_type_error: '必须为正整数', required_error: '必须为正整数' })
      .refine(v => Number.isFinite(v) && Number.isInteger(v) && v > 0, { message: '必须为正整数' })
      .optional(),
    allowEnvFallback: z.boolean({ invalid_type_error: '必须为布尔', required_error: '必须为布尔' }).optional(),
  }).strict().optional(),
  mcp: z.object({
    servers: z.record(z.string(), mcpServerSchema, { invalid_type_error: '必须为对象（serverId → 启动规格）' }),
  }).strict().optional(),
}, { invalid_type_error: '配置顶层必须为 JSON 对象' }).strict()

/** 未登记键提示（渲染层拼 path）——与系统设计键位空间同步 */
const KEY_SPACES = '登记键位：sandbox.* / llm.* / mcp.servers.*'

/** zod issue → CAR-E-CONFIG 渲染（首个 issue；unrecognized_keys 按键路径展开） */
function renderIssue(error: z.ZodError): string {
  const iss = error.issues[0]!
  if (iss.code === 'unrecognized_keys') {
    const keys = (iss as unknown as { keys?: string[] }).keys ?? []
    const keyPath = [...iss.path, keys[0] ?? '?'].join('.')
    return iss.path.length
      ? `CAR-E-CONFIG: 未知键 ${keyPath}（${KEY_SPACES}）`
      : `CAR-E-CONFIG: 未知顶层键 "${keys[0] ?? '?'}"（${KEY_SPACES}）`
  }
  const p = iss.path.join('.')
  return p ? `CAR-E-CONFIG: ${p} ${iss.message}` : `CAR-E-CONFIG: ${iss.message}`
}

/** zod 解析 → CarConfig（扁平渲染：sandbox 嵌套键拍平——mergeSignatureGate 消费形态不变） */
function parseCarConfig(raw: unknown): { config: CarConfig; error?: string } {
  const parsed = rawSchema.safeParse(raw)
  if (!parsed.success) return { config: {}, error: renderIssue(parsed.error) }
  const d = parsed.data
  const out: CarConfig = {}
  if (d.sandbox) {
    const sb: SandboxSigConfig = {}
    if (d.sandbox.unsigned?.allow !== undefined) sb.unsignedAllow = d.sandbox.unsigned.allow
    if (d.sandbox.sig?.enforce !== undefined) sb.sigEnforce = d.sandbox.sig.enforce
    if (d.sandbox.sig?.trustRoot !== undefined) sb.sigTrustRoot = d.sandbox.sig.trustRoot
    out.sandbox = sb
  }
  if (d.llm) {
    const llm: LlmConfig = {}
    if (d.llm.baseUrl !== undefined) llm.baseUrl = d.llm.baseUrl
    if (d.llm.model !== undefined) llm.model = d.llm.model
    if (d.llm.adapterId !== undefined) llm.adapterId = d.llm.adapterId
    if (d.llm.maxTokens !== undefined) llm.maxTokens = d.llm.maxTokens
    if (d.llm.allowEnvFallback !== undefined) llm.allowEnvFallback = d.llm.allowEnvFallback
    out.llm = llm
  }
  if (d.mcp) {
    const servers: Record<string, McpServerSpec> = {}
    for (const [sid, sv] of Object.entries(d.mcp.servers)) {
      const spec: McpServerSpec = {}
      if (sv.command !== undefined) spec.command = sv.command
      if (sv.url !== undefined) spec.url = sv.url
      if (sv.args !== undefined) spec.args = sv.args
      if (sv.env !== undefined) spec.env = sv.env
      if (sv.headers !== undefined) spec.headers = sv.headers
      servers[sid] = spec
    }
    out.mcp = { servers }
  }
  return { config: out }
}

// ==================== 载体装载（JSON 同步 / TS 预热缓存） ====================

/** car.config.ts 预热缓存（path → 装载结果；warmCarConfig 每次以新 epoch 查询串击穿模块缓存） */
const tsCache = new Map<string, ConfigLoadResult>()
let tsEpoch = 0

/**
 * 1.5-S3（D-22）→ 1.6-S3（D-24）：car.config.ts 载体预热。
 * jiti 自包含转译（每 epoch 新实例 + moduleCache 关 = 击穿语义与 1.5 等价）——
 * Node 22.19+ 无需 --experimental-transform-types；直接调用 loadCarConfig 的库方
 * 在存在 car.config.ts 时须先 await 本函数（CLI 入口统一预热，协议不变）。
 */
export async function warmCarConfig(opts: { explicitPath?: string; cwd?: string } = {}): Promise<void> {
  let path: string | undefined
  if (opts.explicitPath) {
    if (!opts.explicitPath.endsWith('.ts')) return // JSON 显式路径走同步通道，无需预热
    path = isAbsolute(opts.explicitPath) ? opts.explicitPath : join(opts.cwd ?? process.cwd(), opts.explicitPath)
  } else {
    const candidate = join(opts.cwd ?? process.cwd(), CONFIG_TS_FILENAME)
    if (!existsSync(candidate)) return // cwd 发现序：无 ts 载体 = 无需预热（json 同步可读）
    path = candidate
  }
  tsEpoch++
  const result = await loadTsConfigFile(path, tsEpoch)
  tsCache.set(path, result)
}

async function loadTsConfigFile(path: string, _epoch: number): Promise<ConfigLoadResult> {
  try {
    // D-24：jiti 转译（零传递依赖 bundled）；每 epoch 新实例 + moduleCache 关——击穿语义保持；
    // interopDefault 显式关（jiti 缺省 true 会把无 default 模块的 exports 整体当 default 返回，
    // 「缺 default export」fail-visible 校验即失效）
    const { createJiti } = await import('jiti')
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, interopDefault: false })
    const mod = await jiti.import(path) as { default?: unknown }
    const raw = mod.default
    if (raw === undefined) {
      return { path, config: {}, error: `CAR-E-CONFIG: ${path} 缺 default export（car.config.ts 形态 = export default {…}）` }
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { path, config: {}, error: `CAR-E-CONFIG: ${path} default export 必须为对象（配置顶层）` }
    }
    const v = parseCarConfig(raw)
    return v.error ? { path, config: {}, error: v.error } : { path, config: v.config }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { path, config: {}, error: `CAR-E-CONFIG: car.config.ts 载入失败（${err.message ?? String(e)}）——jiti 转译失败显式拒绝，不静默忽略` }
  }
}

/** 加载配置：显式路径（必须存在，否则报错）或 cwd 发现（未发现 = 正常态返回空配置） */
export function loadCarConfig(opts: { explicitPath?: string; cwd?: string } = {}): ConfigLoadResult {
  if (opts.explicitPath) {
    const path = isAbsolute(opts.explicitPath) ? opts.explicitPath : join(opts.cwd ?? process.cwd(), opts.explicitPath)
    if (path.endsWith('.ts')) {
      const hit = tsCache.get(path)
      if (hit) return hit
      return { path, config: {}, error: `CAR-E-CONFIG: car.config.ts 未预热（CLI 入口自动 warmCarConfig；直接调用方须先 await warmCarConfig({ explicitPath })）` }
    }
    if (!existsSync(path)) {
      return { path, config: {}, error: `CAR-E-CONFIG: 配置文件不存在：${path}（--config 显式指定的路径必须存在）` }
    }
    return loadJsonConfigFile(path)
  }
  // cwd 发现序（D-22）：car.config.ts > car.config.json（并存 = ts 胜出，json 忽略）
  const tsPath = join(opts.cwd ?? process.cwd(), CONFIG_TS_FILENAME)
  if (existsSync(tsPath)) {
    const hit = tsCache.get(tsPath)
    if (hit) return hit
    return { path: tsPath, config: {}, error: `CAR-E-CONFIG: car.config.ts 未预热（CLI 入口自动 warmCarConfig；直接调用方须先 await warmCarConfig({ cwd })）` }
  }
  const jsonPath = join(opts.cwd ?? process.cwd(), CONFIG_FILENAME)
  if (!existsSync(jsonPath)) return { config: {} }
  return loadJsonConfigFile(jsonPath)
}

function loadJsonConfigFile(path: string): ConfigLoadResult {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    return { path, config: {}, error: `CAR-E-CONFIG: 配置文件解析失败（${(e as Error).message}）——坏 JSON 显式拒绝，不静默忽略` }
  }
  const v = parseCarConfig(raw)
  return v.error ? { path, config: {}, error: v.error } : { path, config: v.config }
}

/** 合并产出（mode/unsignedAllow 恒有值——比 SignatureGateOptions 的可选字段更窄，doctor 等消费方免缺省分支） */
export interface ResolvedSignatureGate {
  mode: 'warn' | 'enforce'
  trustRootPublicKey?: string
  unsignedAllow: boolean
}

/**
 * 1.4-S3（D-16）：模型接入配置合并（flag > env > 配置 > 缺省）。
 * env 已定义为显式意见（压过配置），未定义落配置层——与 mergeSignatureGate 同纪律。
 * 凭据不在此层（CR-05）：走 CredentialService（keychain → env OPENAI_API_KEY/ANTHROPIC_API_KEY/
 * CAR_LLM_API_KEY，env fallback 需显式开启 = CAR_ALLOW_ENV_CREDENTIALS=1 或 llm.allowEnvFallback）。
 */
export function mergeLlmConfig(env: NodeJS.ProcessEnv, cfg: CarConfig, flags: { baseUrl?: string; model?: string; adapterId?: string; maxTokens?: number } = {}): LlmConfig {
  let baseUrl = cfg.llm?.baseUrl
  if (env.CAR_LLM_BASE_URL) baseUrl = env.CAR_LLM_BASE_URL
  if (flags.baseUrl) baseUrl = flags.baseUrl
  let model = cfg.llm?.model
  if (env.CAR_LLM_MODEL) model = env.CAR_LLM_MODEL
  if (flags.model) model = flags.model
  let adapterId = cfg.llm?.adapterId
  if (flags.adapterId) adapterId = flags.adapterId
  let maxTokens = cfg.llm?.maxTokens
  if (flags.maxTokens !== undefined) maxTokens = flags.maxTokens
  let allowEnvFallback = cfg.llm?.allowEnvFallback === true
  if (env.CAR_ALLOW_ENV_CREDENTIALS !== undefined) allowEnvFallback = env.CAR_ALLOW_ENV_CREDENTIALS === '1'
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(adapterId ? { adapterId } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    allowEnvFallback,
  }
}

/**
 * 优先级合并（flag > env > 配置 > 缺省）：产出装载签名门选项。
 * flagEnforce = CLI --sig-enforce；env 已定义即为显式意见（压过配置），未定义落配置层。
 */
export function mergeSignatureGate(env: NodeJS.ProcessEnv, cfg: CarConfig, flagEnforce?: boolean): ResolvedSignatureGate {
  // cfg 为校验器产出的扁平形状（sandbox.{unsignedAllow,sigEnforce,sigTrustRoot}，JSON 嵌套键已拍平）
  let mode: 'warn' | 'enforce' = cfg.sandbox?.sigEnforce === true ? 'enforce' : 'warn'
  if (env.CAR_SIG_ENFORCE !== undefined) mode = env.CAR_SIG_ENFORCE === '1' ? 'enforce' : 'warn'
  if (flagEnforce) mode = 'enforce'
  let trustRootPublicKey = cfg.sandbox?.sigTrustRoot
  if (env.CAR_TRUST_ROOT) trustRootPublicKey = env.CAR_TRUST_ROOT
  let unsignedAllow = cfg.sandbox?.unsignedAllow === true
  if (env.CAR_UNSIGNED_ALLOW !== undefined) unsignedAllow = env.CAR_UNSIGNED_ALLOW === '1'
  return { mode, trustRootPublicKey: trustRootPublicKey || undefined, unsignedAllow }
}
