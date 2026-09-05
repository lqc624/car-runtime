/**
 * T-2 · PTC TS SDK 渲染（M3-S15）
 *
 * 口径（M3系统设计增补 T-2 / dsh 一手口径 tools/src/index.ts:26,97）：
 *  - SDK = 从工具注册表快照渲染进 system prompt 的 TS 声明（**非 .d.ts 文件生成**）；
 *  - **声明面/授权面一致性红线**：渲染源与授权消费源必须同一 Map 快照——模型看到的工具集合
 *    即授权门放行的集合（多渲一个 = 无授权执行面，少渲一个 = 授权白给）；
 *  - 参数形状以 description + 可选 paramHint 声明（v1 不做 JSON Schema→TS 深度转换，S16 评估）。
 */
import type { ToolBridge } from './runCode.ts'

export interface SdkToolDef { name: string; description?: string; /** 参数形状提示（TS 字面量），如 '{ x: number; y: number }' */ paramHint?: string }

/** 渲染 SDK 声明：注入 PTC 程序体上文的 TS 类型面（模型据此写代码） */
export function renderSdk(defs: Iterable<SdkToolDef>): string {
  const lines = ['// CAR PTC SDK —— 以下声明与授权门消费同一注册表快照（声明面=授权面）', 'declare const tools: {']
  for (const d of defs) {
    const hint = d.paramHint ?? 'args: unknown'
    lines.push(`  ${JSON.stringify(d.name)}: (${hint}) => Promise<unknown>${d.description ? ` // ${d.description}` : ''}`)
  }
  lines.push('};')
  return lines.join('\n')
}

/** 从 ToolBridge 注册表快照渲染（包装：接受可选 description/paramHint 的注册表条目） */
export function renderSdkFromRegistry(registry: Map<string, ToolBridge & { description?: string; paramHint?: string }>): string {
  return renderSdk([...registry.entries()].map(([name, d]) => ({ name, description: d.description, paramHint: d.paramHint })))
}
