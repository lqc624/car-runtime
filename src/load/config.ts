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

export interface CompactionConfig {
  /** 缺省 false = 行为零变化（1.13 兼容线） */
  enabled?: boolean
  /** 距上次压缩以来的新增事件数阈值（事实计数非估算）；缺省 200 */
  thresholdEvents?: number
  /** 1.18-K5（D-51）：token 维度阈值（provider 报告事实，非估算）；与事件阈值 OR；缺省缺席不生效 */
  thresholdTokens?: number
  /** 保护最近 N 个 turn 不折叠；缺省 4 */
  protectLastTurns?: number
}

export interface LlmConfig {
  baseUrl?: string
  model?: string
  adapterId?: string
  maxTokens?: number
  allowEnvFallback?: boolean
  /** 1.14-S2（K-MP-2 / D-40）：历史压缩策略（阈值自动触发判定入参；立即压缩 API 独立可用） */
  compaction?: CompactionConfig
  /** 1.16-K3（D-K2-2）：子 Agent 配置（缺省 = 继承父会话模型锚点 Q-A2 + 宿主护栏常量 Q-A3） */
  subagent?: SubagentConfig
}

/** 1.16-K3（D-K2-2）：子 Agent 配置面——宿主编排消费（内核自身不装配编排；schema 只登记键位） */
export interface SubagentConfig {
  /** 独立子模型锚点（缺省 = 继承父会话现值；modelPool 激活时被池压过——与 llm.model 同口径） */
  model?: string
  /** 并发子 Agent 上限（正整数；缺省 = 宿主常量 3，Q-A3） */
  maxConcurrent?: number
  /** 单父会话累计派生上限（正整数；缺省 = 宿主常量 10，Q-A3） */
  maxCumulative?: number
}

/** 1.14-S4（K-POOL-1 / D-42）：模型池端点登记（多端点 fallback 候选；凭据仅收 keyEnv 引用） */
export interface ModelPoolEndpointSpec {
  /** 端点标识（routing/decide 落链定位；缺省 ep-1..N 派生；重复显式拒绝） */
  id?: string
  baseUrl: string
  model: string
  /** 适配器家族（config 可装配集 = 内置两族；缺省 openai-compat） */
  adapterId?: 'openai-compat' | 'anthropic'
  /** 凭据 env 变量名引用（明文 key 显式拒绝——CR-05；缺省按 adapterId 缺省表 + CAR_LLM_API_KEY） */
  keyEnv?: string
  /** 优先级：数值越小越优先（缺省 0） */
  priority?: number
  /** 同优先级内次序：越大越先（缺省 0——D-42：登记生效为排序 tie-break，不做负载均衡调度） */
  weight?: number
  /** 成员级 maxTokens（缺省回落 llm.maxTokens） */
  maxTokens?: number
}

/** 1.14-S4（K-POOL-1 / D-42）：health 预检策略（doctor 面同款口径——值不打印） */
export interface ModelPoolProbeConfig {
  /** 缺省开；不可达端点按序跳过（fail-visible 落 routing/decide attempts） */
  enabled?: boolean
  /** 单端点探测超时（缺省 4000ms） */
  timeoutMs?: number
  /** 探测结果缓存 TTL（缺省 30000ms；0 = 每请求重探） */
  ttlMs?: number
}

/** 1.14-S4（K-POOL-1 / D-42）：模型池登记。与 llm.baseUrl/model/adapterId 并存时池装配压过（每次路由决策落链可解释）；llm.maxTokens/allowEnvFallback/compaction 仍生效。无 modelPool 配置 = 行为与 1.13 逐字节一致（兼容验收线） */
export interface ModelPoolConfig {
  endpoints: ModelPoolEndpointSpec[]
  probe?: ModelPoolProbeConfig
  /** 候选请求尝试上限（含首选；缺省 = 端点数） */
  maxAttempts?: number
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
  /** 1.14-S4（K-POOL-1 / D-42）：模型池登记（多端点 fallback；与 llm.* 并存时池压过，路由决策落链） */
  modelPool?: ModelPoolConfig
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

// 1.14-S4（K-POOL-1）辅助：正整数 / 非负整数
const positiveInt = () =>
  z.number({ invalid_type_error: '必须为正整数', required_error: '必须为正整数' })
    .refine(v => Number.isFinite(v) && Number.isInteger(v) && v > 0, { message: '必须为正整数' })
const nonNegativeInt = () =>
  z.number({ invalid_type_error: '必须为非负整数', required_error: '必须为非负整数' })
    .refine(v => Number.isFinite(v) && Number.isInteger(v) && v >= 0, { message: '必须为非负整数' })

// 明文凭据键黑名单（1.14-S4 / CR-05）：专用文案先于未知键检查（首个 issue 渲染）
const PLAINTEXT_CRED_KEYS = ['key', 'apiKey', 'api_key', 'apikey', 'token', 'password']
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const POOL_ENDPOINT_KEYS = new Set(['id', 'baseUrl', 'model', 'adapterId', 'keyEnv', 'priority', 'weight', 'maxTokens'])

/**
 * 池端点 schema（1.14-S4）：passthrough + superRefine 显式拒绝（等价 strict，但明文凭据键
 * 给专用文案——CR-05 红线「明文 key 显式拒绝」必须可读可引导，不能只报「未知键」）。
 */
const poolEndpointSchema = z.object({
  id: nonEmptyTrimmed().optional(),
  baseUrl: nonEmptyTrimmed().refine(v => /^https?:\/\//.test(v), { message: '必须为 http(s) URL' }),
  model: nonEmptyTrimmed(),
  adapterId: z.enum(['openai-compat', 'anthropic'], { errorMap: () => ({ message: '必须为 openai-compat 或 anthropic（config 可装配集 = 内置两族）' }) }).optional(),
  keyEnv: nonEmptyTrimmed().refine(v => ENV_NAME_RE.test(v), { message: '必须为环境变量名（明文凭据禁入——凭据仅收 keyEnv 引用，CR-05）' }).optional(),
  priority: positiveInt().optional(),
  weight: nonNegativeInt().optional(),
  maxTokens: positiveInt().optional(),
}).passthrough().superRefine((obj, ctx) => {
  for (const k of PLAINTEXT_CRED_KEYS) {
    if (k in obj) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `明文凭据禁入——凭据仅收 keyEnv（环境变量名引用），明文键 "${k}" 一律拒绝` })
      return
    }
  }
  for (const k of Object.keys(obj)) {
    if (!POOL_ENDPOINT_KEYS.has(k)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: '未登记键（登记键位：id/baseUrl/model/adapterId/keyEnv/priority/weight/maxTokens）' })
      return
    }
  }
})

const modelPoolSchema = z.object({
  endpoints: z.array(poolEndpointSchema, { invalid_type_error: '必须为端点数组', required_error: '必须为端点数组' })
    .min(1, { message: '至少登记一个端点（池空 = CAR-E-CONFIG；无池需求请移除 modelPool 键，行为与 1.13 一致）' }),
  probe: z.object({
    enabled: z.boolean({ invalid_type_error: '必须为布尔', required_error: '必须为布尔' }).optional(),
    timeoutMs: positiveInt().optional(),
    ttlMs: nonNegativeInt().optional(),
  }).strict().optional(),
  maxAttempts: positiveInt().optional(),
}).strict().superRefine((obj, ctx) => {
  // 端点 id 唯一（缺省派生同口径）——routing/decide 落链定位歧义禁入
  const ids = new Set<string>()
  for (const [i, ep] of (obj.endpoints ?? []).entries()) {
    const id = ep.id ?? `ep-${i + 1}`
    if (ids.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endpoints', i], message: `端点 id "${id}" 重复（落链定位歧义，禁静默）` })
    ids.add(id)
  }
})

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
    // 1.14-S2（K-MP-2 / D-40）：历史压缩策略（阈值事实计数，非 token 估算）；
    // 1.18-K5（D-51）：thresholdTokens = provider 报告事实维度（最近 usage 全上下文，非估算）
    compaction: z.object({
      enabled: z.boolean({ invalid_type_error: '必须为布尔', required_error: '必须为布尔' }).optional(),
      thresholdEvents: z.number({ invalid_type_error: '必须为正整数', required_error: '必须为正整数' })
        .refine(v => Number.isInteger(v) && v > 0, { message: '必须为正整数' }).optional(),
      thresholdTokens: z.number({ invalid_type_error: '必须为正整数', required_error: '必须为正整数' })
        .refine(v => Number.isInteger(v) && v > 0, { message: '必须为正整数' }).optional(),
      protectLastTurns: z.number({ invalid_type_error: '必须为正整数', required_error: '必须为正整数' })
        .refine(v => Number.isInteger(v) && v > 0, { message: '必须为正整数' }).optional(),
    }).strict().optional(),
    // 1.16-K3（D-K2-2）：子 Agent 配置（model 独立锚点 + 护栏上限；空对象无意义显式拒——禁静默 no-op）
    subagent: z.object({
      model: nonEmptyTrimmed().optional(),
      maxConcurrent: z.number({ invalid_type_error: '必须为正整数', required_error: '必须为正整数' })
        .refine(v => Number.isFinite(v) && Number.isInteger(v) && v > 0, { message: '必须为正整数' })
        .optional(),
      maxCumulative: z.number({ invalid_type_error: '必须为正整数', required_error: '必须为正整数' })
        .refine(v => Number.isFinite(v) && Number.isInteger(v) && v > 0, { message: '必须为正整数' })
        .optional(),
    }).strict()
      .refine(v => Object.keys(v).length > 0, { message: '至少登记一个键（model/maxConcurrent/maxCumulative；无子 Agent 配置需求请移除 llm.subagent 键，行为与 1.15.2 一致）' })
      .optional(),
  }).strict().optional(),
  // 1.14-S4（K-POOL-1 / D-42）：模型池登记（多端点 fallback + health + routing/decide 落链）
  modelPool: modelPoolSchema.optional(),
  mcp: z.object({
    servers: z.record(z.string(), mcpServerSchema, { invalid_type_error: '必须为对象（serverId → 启动规格）' }),
  }).strict().optional(),
}, { invalid_type_error: '配置顶层必须为 JSON 对象' }).strict()

/** 未登记键提示（渲染层拼 path）——与系统设计键位空间同步；D-1 勘误：modelPool 为顶层键（非 llm.modelPool） */
const KEY_SPACES = '登记键位：sandbox.* / llm.* / modelPool.* / llm.subagent.* / mcp.servers.*'

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
    if (d.llm.compaction) {
      const cp: CompactionConfig = {}
      if (d.llm.compaction.enabled !== undefined) cp.enabled = d.llm.compaction.enabled
      if (d.llm.compaction.thresholdEvents !== undefined) cp.thresholdEvents = d.llm.compaction.thresholdEvents
      if (d.llm.compaction.thresholdTokens !== undefined) cp.thresholdTokens = d.llm.compaction.thresholdTokens
      if (d.llm.compaction.protectLastTurns !== undefined) cp.protectLastTurns = d.llm.compaction.protectLastTurns
      llm.compaction = cp
    }
    if (d.llm.subagent) {
      const sg: SubagentConfig = {}
      if (d.llm.subagent.model !== undefined) sg.model = d.llm.subagent.model
      if (d.llm.subagent.maxConcurrent !== undefined) sg.maxConcurrent = d.llm.subagent.maxConcurrent
      if (d.llm.subagent.maxCumulative !== undefined) sg.maxCumulative = d.llm.subagent.maxCumulative
      llm.subagent = sg
    }
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
  if (d.modelPool) {
    const mp = d.modelPool as { endpoints: ModelPoolEndpointSpec[]; probe?: ModelPoolProbeConfig; maxAttempts?: number }
    out.modelPool = {
      endpoints: mp.endpoints.map(ep => ({ ...ep })),
      ...(mp.probe ? { probe: { ...mp.probe } } : {}),
      ...(mp.maxAttempts !== undefined ? { maxAttempts: mp.maxAttempts } : {}),
    }
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
