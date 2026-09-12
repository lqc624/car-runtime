/**
 * T-1 · stdio ServerTransport 实装（M3-S12）：宿主 → CAR 的 JSON-RPC over stdin/stdout
 *
 * 口径（M3系统设计增补 T-1 / M3部署设计增补 §4 多宿主拓扑：stdio 为 M3 主形态）：
 *  - 换行分隔 JSON-RPC 2.0（与 M1 client 侧 gateway 同帧格式）；
 *  - 方法面：initialize/notifications 握手（MCP 协议兼容）+ tools/list（10 tool 能力发现）+ tools/call（分发到 HostGateway.handle）；
 *  - 所有到达请求与响应均经 HostGateway 审计（无旁路）；未登记宿主在 handle 层拒绝；
 *  - stdin 结束（宿主退出）→ 通道关闭，进程内状态由审计日志承载（BD-02 等价：不静默丢数据）。
 */
import { createInterface } from 'node:readline'
import { HOST_TOOLS, type HostTool } from './hostGateway.ts'

export interface StdioDispatcher {
  (tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>
}

export interface StdioServer {
  /** 消费 stdin 行直到结束；返回处理请求数（供测试断言） */
  serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<number>
}

export function createStdioServer(dispatch: StdioDispatcher): StdioServer {
  let nextId = 0
  return {
    async serve(input, output) {
      let count = 0
      const rl = createInterface({ input })
      const done = new Promise<void>(resolve => rl.on('close', resolve))
      rl.on('line', line => {
        const trimmed = line.trim()
        if (!trimmed) return
        count++
        let req: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
        try { req = JSON.parse(trimmed) } catch {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
          return
        }
        nextId++
        const respond = (result: unknown, error?: { code: number; message: string }) => {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: req.id ?? nextId, ...(error ? { error } : { result }) }) + '\n')
        }
        // MCP 协议握手（E-6 实连前置）：真实宿主客户端先发 initialize → 回 serverInfo；
        // notifications/initialized 为无 id 通知，不响应（协议规定）
        if (req.method === 'initialize') {
          respond({
            protocolVersion: (req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'car-runtime', version: '0.3.0' },
          })
          return
        }
        if (req.method === 'notifications/initialized' || (req.method ?? '').startsWith('notifications/')) {
          return // 通知无响应
        }
        if (req.method === 'tools/list') {
          respond({ tools: HOST_TOOLS.map((t: HostTool) => ({ name: t })) })
          return
        }
        if (req.method === 'tools/call') {
          const name = req.params?.name ?? ''
          const args = req.params?.arguments ?? {}
          void dispatch(name, args).then(r => {
            if (r.ok) respond({ content: [{ type: 'text', text: JSON.stringify(r.result ?? {}) }], carOk: true })
            else respond(undefined, { code: -32000, message: r.error ?? 'host call failed' })
          }).catch(e => respond(undefined, { code: -32000, message: String(e) }))
          return
        }
        respond(undefined, { code: -32601, message: `unknown method "${req.method}"（支持 initialize / tools/list / tools/call）` })
      })
      await done
      return count
    },
  }
}
