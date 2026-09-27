/**
 * M8 · 运行时底座共享 DTO（《系统设计》§3.2.M8.3 / §3.3.1 O-10/O-11/O-13/O-14）
 *
 * 口径：
 *  - LlmChunk.finishReason 为不可变透传（readonly 语义，ADR-001；vLLM #53269 教训 SR-17）——
 *    唯一信号源，禁止中间层改写/吞没；llm.ts 的流包装层对此做防御性断言；
 *  - LlmRequest.tools 含 declaredSideEffect（权限门依据；readonly 是 ADR-001 补错重试白名单前置）；
 *  - ToolDefinition 为 M8 共享 DTO（O-10）：M3 授权门/M5 MCP 网关/M8 模型请求三方复用；
 *    与 loop/stop.ts 的 ToolDef 分工——ToolDefinition 是声明面（进模型 schema），ToolDef 是执行面；
 *  - CredentialRef 不落明文（O-13）：ref 只含来源定位，值经 credentials.reveal 按需取用；
 *  - 规格外扩展字段（adapterId / error）以加法演进登记——与 hostRaw 同纪律，不改动规格最小集语义。
 */

/** 模型请求（Provider 无关） */
export interface LlmRequest {
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'toolResult'; content: unknown }>
  /** 工具 schema（缓存失效因素：工具集合/模型切换/compaction，D3 §14.6） */
  tools: ToolDefinition[]
  maxTokens?: number
  metadata?: { sessionId: string; turnId: string; traceId: string }
  // —— 规格外加法扩展（登记：M8 收口文档 §4 / 1.4-S4）——
  /** 多适配器在册时显式路由；缺省用默认适配器 */
  adapterId?: string
  /** 1.4-S4（D-19）：turn 取消信号（runTurn 的 {aborted} 形态透传）——适配器在 attempt 前 /
   *  chunk 间隙检查；外部取消 ≠ 失败（不 retry、不产 error chunk，静默收口由 chatStep 抛 TurnAborted） */
  signal?: { aborted: boolean }
}

/** 工具调用流式增量（跨 chunk 聚合出完整 ToolCall） */
export interface ToolCallDelta {
  index?: number
  id?: string
  name?: string
  /** JSON 增量片段，聚合后整体 JSON.parse（半截 JSON 不解析——ADR-001 同纪律） */
  argumentsDelta?: string
}

/** 流式块（finishReason 一经产生不可被任何中间层改写） */
export interface LlmChunk {
  delta?: string
  toolCallDelta?: ToolCallDelta
  finishReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  // —— 规格外加法扩展（登记：M8 收口文档 §4）——
  /** finishReason='error' 时的结构化原因（消费方落 turnEnd meta，不进模型消息流） */
  error?: { code: string; message: string }
}

/** Provider 适配器（ACL，C-02）：统一签名，消解 Provider 差异 */
export interface LlmAdapter {
  /** 如 openai-compat / anthropic */
  id: string
  chat(req: LlmRequest): AsyncIterable<LlmChunk>
}

/** 可逆注册句柄（dispose = Effect 回卷） */
export interface Disposable {
  dispose(): void
}

/** 共享工具声明 DTO（O-10；注册时构造，进模型请求 schema） */
export interface ToolDefinition {
  name: string
  description?: string
  /** JSON Schema 形态参数声明 */
  parameters?: unknown
  /** 副作用声明（必填——M5 网关 T-22 强制点同一口径：缺声明即 write） */
  declaredSideEffect: 'readonly' | 'write'
}

/** 凭据来源（§3.2.M8.3 字段表：env 需用户显式开启 fallback） */
export type CredentialSource = 'keychain' | 'env'

/** 凭据引用（O-13）：只含来源定位与掩码提示，值永不入此结构 */
export interface CredentialRef {
  provider: string
  source: CredentialSource
  /** 来源标识：keychain 服务名 / env 变量名 */
  origin: string
  /** keychain 通道不可用等降级留痕（降级必须显式，禁静默） */
  degraded?: string
}
