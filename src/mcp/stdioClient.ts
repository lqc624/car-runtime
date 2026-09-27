/**
 * 1.4-S7 · MCP stdio 客户端传输（W1 MCP 工具进 turn）：spawn 子进程 + JSON-RPC 换行分隔 JSON
 *
 * 口径（1.4 规划 W1 MCP 块 / D-18）：
 *  - CAR → 外部 MCP Server 方向（gateway.ts ClientTransport 的真实通道实装——此前仅测试替身）；
 *    server 侧对偶（宿主 → CAR）见 src/host/stdio.ts；
 *  - 行协议：请求一行 JSON 写入 server stdin；响应按 id 匹配 pending 表（行解析容错跳过非 JSON 行）；
 *  - send 内建 30s 超时（fail-visible——gateway.register 的 tools/list 无外层 race，防挂死）；
 *  - stderr 不透传（server 诊断输出与协议通道隔离）；close = kill（car run 收口调用）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { ClientTransport, JsonRpcResponse } from './gateway.ts'

export interface StdioServerSpec {
  command: string
  args?: string[]
}

export function createStdioClientTransport(spec: StdioServerSpec): ClientTransport & { readonly alive: () => boolean } {
  const child: ChildProcess = spawn(spec.command, spec.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, (res: JsonRpcResponse) => void>()
  let buffer = ''
  let exited = false
  child.on('exit', () => { exited = true })
  child.stdout!.on('data', chunk => {
    buffer += chunk.toString('utf-8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        const res = JSON.parse(line) as JsonRpcResponse
        const settle = pending.get(res.id as number)
        if (settle) {
          pending.delete(res.id as number)
          settle(res)
        }
      } catch { /* 非 JSON 行容错跳过（server 诊断污染 stdin 协议通道时不断链） */ }
    }
  })
  child.stderr!.on('data', () => { /* 隔离（见头注释） */ })
  child.on('error', () => { exited = true })

  const transport: ClientTransport & { readonly alive: () => boolean } = {
    send(req) {
      return new Promise((resolve, reject) => {
        if (!transport.alive()) {
          reject(new Error('CAR-E-MCP: stdio transport not alive（server 进程已退出）'))
          return
        }
        const timer = setTimeout(() => {
          pending.delete(req.id as number)
          reject(new Error('CAR-E-MCP: stdio send timeout (30s)'))
        }, 30_000)
        pending.set(req.id as number, res => {
          clearTimeout(timer)
          resolve(res)
        })
        try {
          child.stdin!.write(JSON.stringify(req) + '\n')
        } catch (e) {
          clearTimeout(timer)
          pending.delete(req.id as number)
          reject(e)
        }
      })
    },
    alive: () => !exited && child.exitCode === null && !child.killed,
    close: () => {
      try { child.kill() } catch { /* 已退出 */ }
    },
  }
  return transport
}
