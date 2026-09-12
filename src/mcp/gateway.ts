/**
 * F8 · MCP 桥接网关：登记制 + 工具桥接 + 崩溃隔离 + 凭据门
 *
 * 口径（《系统设计》M5 / 冻结决策① / 安全设计 T3 域）：
 *  - serverId 登记制：运行期不接受未登记连接（A050001）；Python 侧仅工具供给方，无 ctx 级 API
 *  - 工具桥接为一等 ToolDefinition：declaredSideEffect 未声明按 write 最高约束（T-22）
 *  - 调用过三权限审批门（与其他工具同一审批门，无旁路——US-6 AC3）
 *  - Server 崩溃/超时 → BD-02 整体标记不可用，不传导进内核主链路（US-6 AC4）
 *  - McpServerConfig.env 禁明文密钥（疑似凭据模式即拒绝，sk- 前缀等——§3.2.5 传参禁忌）
 *  - 传输抽象：stdio 真实通道（JSON-RPC over 换行分隔 JSON）/ in-process 测试通道
 */
export interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }

/**
 * 客户端传输（CAR → MCP Server 方向）。M3-S11 双向分层：本接口为 client 侧对偶；
 * server 侧（宿主 → CAR）见 src/host/hostGateway.ts 的 ServerTransport。
 */
export interface ClientTransport {
  send(req: JsonRpcRequest): Promise<JsonRpcResponse>
  /** 进程/通道存活状态 */
  alive(): boolean
  /** 主动终止 */
  close(): void
}

/** M1 兼容别名（M2 代码零改动；M4 评估移除） */
export type McpTransport = ClientTransport

/**
 * 服务端传输对偶（宿主 → CAR 方向，M3 多宿主）：宿主作为 MCP client 调用 CAR 暴露的 tool 面。
 * 与 ClientTransport 语义对偶：CAR 不主动 send，仅响应 method 调用。
 */
export interface ServerTransport {
  /** 宿主到达的 JSON-RPC 方法调用（由 HostGateway 分发到 10 tool 注册表） */
  onRequest(method: string, params: unknown): Promise<JsonRpcResponse>
  alive(): boolean
  close(): void
}

/** 疑似明文凭据检测（§3.2.5：env 值出现 sk- 等前缀即拒绝） */
export function containsPlaintextCredential(env: Record<string, string>): string | null {
  const patterns = [/^sk-/, /^ghp_/, /^xox[bap]-/, /^AKIA/]
  for (const [k, v] of Object.entries(env)) {
    if (patterns.some(p => p.test(v))) return `env "${k}" looks like a plaintext credential（经 M8 凭据门注入，禁止明文透传）`
  }
  return null
}

export interface McpServerConfig {
  serverId: string
  transport: ClientTransport
  /** 启动环境变量（禁明文凭据，凭据经 M8 凭据门运行时注入） */
  env?: Record<string, string>
}

export interface McpToolDefinition {
  serverId: string
  name: string
  description?: string
  /** 未声明按 write 最高约束（T-22：安全默认） */
  declaredSideEffect?: 'readonly' | 'write'
  /** 工具入参 JSON Schema（MCP tools/list 原样捕获，M5 DEC-4 深度参数渲染消费源） */
  inputSchema?: unknown
}

export class McpGateway {
  #servers = new Map<string, McpServerConfig>()
  #tools = new Map<string, McpToolDefinition & { serverId: string }>()
  #unavailable = new Set<string>()
  #nextId = 1

  /** 登记并连接：拉起后发现工具并注册进能力矩阵（加载报告可见） */
  async register(cfg: McpServerConfig): Promise<McpToolDefinition[]> {
    if (this.#servers.has(cfg.serverId)) {
      throw new Error(`CAR-E-MCP: serverId "${cfg.serverId}" already registered（登记制：重复注册显式报错）`)
    }
    const cred = cfg.env ? containsPlaintextCredential(cfg.env) : null
    if (cred) throw new Error(`CAR-E-MCP: ${cred}`)
    this.#servers.set(cfg.serverId, cfg)
    const res = await cfg.transport.send({ jsonrpc: '2.0', id: this.#nextId++, method: 'tools/list' })
    const tools = (res.result as { tools: Array<{ name: string; description?: string; sideEffect?: 'readonly' | 'write'; inputSchema?: unknown }> }).tools
    for (const t of tools) {
      // T-22：未声明 sideEffect 按 write 最高约束收敛（安全默认，注册时强制）
      this.#tools.set(`${cfg.serverId}:${t.name}`, {
        serverId: cfg.serverId, name: t.name, description: t.description,
        declaredSideEffect: t.sideEffect ?? 'write',
        inputSchema: t.inputSchema,
      })
    }
    return [...this.#tools.values()].filter(t => t.serverId === cfg.serverId)
  }

  /** 能力矩阵视图（加载报告用） */
  listTools(): McpToolDefinition[] { return [...this.#tools.values()] }

  isAvailable(serverId: string): boolean { return this.#servers.has(serverId) && !this.#unavailable.has(serverId) }

  /** 调用：走统一权限/审计链路（无旁路）；结果回填日志前必经 redact（调用方职责） */
  async callTool(serverId: string, tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const cfg = this.#servers.get(serverId)
    if (!cfg) throw new Error('CAR-A050001: unregistered MCP connection rejected（登记制）')
    if (this.#unavailable.has(serverId)) {
      // BD-02：崩溃/超时整体标记不可用——显式错误结果，不抛异常不阻断主链路
      return { ok: false, error: `MCP server "${serverId}" unavailable (BD-02)` }
    }
    const key = `${serverId}:${tool}`
    if (!this.#tools.has(key)) return { ok: false, error: `unknown tool "${tool}" on "${serverId}"` }
    try {
      const res = await Promise.race([
        cfg.transport.send({ jsonrpc: '2.0', id: this.#nextId++, method: 'tools/call', params: { name: tool, arguments: args } }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mcp timeout')), opts.timeoutMs ?? 30_000)),
      ])
      return { ok: true, result: (res as JsonRpcResponse).result }
    } catch (e) {
      // BD-02：崩溃/超时 → 整体不可用（不静默：错误事件由调用方落审计日志）
      this.#unavailable.add(serverId)
      return { ok: false, error: `MCP call failed, server marked unavailable (BD-02): ${String(e)}` }
    }
  }
}
