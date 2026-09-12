/**
 * T-2 · PTC TS SDK 渲染（M3-S15）+ 深度参数渲染转正（M5 · DEC-4）
 *
 * 口径（M3系统设计增补 T-2 / dsh 一手口径 tools/src/index.ts:26,97）：
 *  - SDK = 从工具注册表快照渲染进 system prompt 的 TS 声明（**非 .d.ts 文件生成**）；
 *  - **声明面/授权面一致性红线**：渲染源与授权消费源必须同一 Map 快照——模型看到的工具集合
 *    即授权门放行的集合（多渲一个 = 无授权执行面，少渲一个 = 授权白给）；
 *  - 参数形状优先级：paramHint（手写 TS 字面量）> inputSchema（JSON Schema 深度转换，
 *    M5 DEC-4 转正，见 ./schemaRender.ts）> `args: unknown`（无形状声明时的 fail-visible 默认）。
 */
import type { ToolBridge } from './runCode.ts'
import { jsonSchemaToTs } from './schemaRender.ts'

export interface SdkToolDef {
  name: string
  description?: string
  /** 参数形状提示（TS 字面量），如 '{ x: number; y: number }'——手写声明，优先级最高 */
  paramHint?: string
  /** JSON Schema（MCP tools/list inputSchema）——深度转换渲染，paramHint 缺省时生效 */
  inputSchema?: unknown
}

/** 渲染单工具参数形状（优先级：paramHint > inputSchema 深渲 > unknown） */
function renderArgsHint(d: SdkToolDef): string {
  if (d.paramHint) return d.paramHint
  if (d.inputSchema !== undefined) return jsonSchemaToTs(d.inputSchema)
  return 'args: unknown'
}

/** 渲染 SDK 声明：注入 PTC 程序体上文的 TS 类型面（模型据此写代码） */
export function renderSdk(defs: Iterable<SdkToolDef>): string {
  const lines = ['// CAR PTC SDK —— 以下声明与授权门消费同一注册表快照（声明面=授权面）', 'declare const tools: {']
  for (const d of defs) {
    const hint = renderArgsHint(d)
    lines.push(`  ${JSON.stringify(d.name)}: (${hint}) => Promise<unknown>${d.description ? ` // ${d.description}` : ''}`)
  }
  lines.push('};')
  return lines.join('\n')
}

/** 从 ToolBridge 注册表快照渲染（包装：接受可选 description/paramHint/inputSchema 的注册表条目） */
export function renderSdkFromRegistry(registry: Map<string, ToolBridge & { description?: string; paramHint?: string; inputSchema?: unknown }>): string {
  return renderSdk([...registry.entries()].map(([name, d]) => ({ name, description: d.description, paramHint: d.paramHint, inputSchema: d.inputSchema })))
}
