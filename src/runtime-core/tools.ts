/**
 * 1.4-S1 · 工具声明面转换（执行面 Map → 模型声明面 ToolDefinition[]）
 *
 * 口径（1.4 规划 W1-3 / D-18 / T-22 / 声明面=授权面红线）：
 *  - **执行面与声明面同一对象**：ToolDef（loop/stop.ts，declaredSideEffect+run）即声明来源——
 *    插件注册的 ToolReg 经 bindCore 收集后直接进本转换器，模型看到的工具集合 = 授权门放行的集合
 *    （多渲一个 = 无授权执行面，少渲一个 = 授权白给——PTC SDK 同款红线）；
 *  - T-22 收口：declaredSideEffect 缺省 write（未声明按最高约束——mcp/gateway.ts 注册点同款）；
 *  - 跨源同名显式报错（禁静默覆盖）：Map 键即名字，插件/MCP 工具合并由调用方先行去重——
 *    本转换器对重名（Map 键重复不可能，但 ToolDef.name 与键不一致时）显式报错；
 *  - declaredSideEffect 不出站（llm.ts 出站映射只带 name/description/parameters——权限面只进权限门）。
 */
import type { ToolDef } from '../loop/stop.ts'
import type { ToolDefinition } from './types.ts'

export function toToolDefinitions(tools: Map<string, ToolDef>): ToolDefinition[] {
  const out: ToolDefinition[] = []
  for (const [name, t] of tools) {
    out.push({
      name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      declaredSideEffect: t.declaredSideEffect ?? 'write',
    })
  }
  return out
}
