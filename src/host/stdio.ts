/**
 * T-1 · stdio ServerTransport 实装（M3-S12）：宿主 → CAR 的 JSON-RPC over stdin/stdout
 *
 * 口径（M3系统设计增补 T-1 / M3部署设计增补 §4 多宿主拓扑：stdio 为 M3 主形态）：
 *  - 换行分隔 JSON-RPC 2.0（与 M1 client 侧 gateway 同帧格式）；
 *  - 方法面：tools/list（9 tool 能力发现）+ tools/call（分发到 HostGateway.handle）；
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
        respond(undefined, { code: -32601, message: `unknown method "${req.method}"（仅 tools/list 与 tools/call）` })
      })
      await done
      return count
    },
  }
}
