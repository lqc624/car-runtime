/**
 * F14 · 治理视图（M2-S9）：配置树 dump + 事件产消图
 *
 * 口径（M2演进规划 F14 / PRD P1-7）：
 *  - 配置树：装配快照（插件/依赖/服务/副作用计数）——来自 Context.governanceSnapshot()；
 *  - 事件产消图：@mode 事件目录 × handlerChain（F11 priority 治理视图）——生产者=dispatch 点、
 *    消费者=on 注册（label+priority，按实际执行序）；未声明事件在 F7 契约层已被禁止，此图即最终事实；
 *  - 输出为纯数据结构（可 JSON 序列化落盘），供 `car governance dump` CLI（S10）与文档生成。
 */
import type { Context } from '../kernel/context.ts'
import type { EventBus } from '../kernel/events.ts'

export interface AssemblyTree {
  plugins: { name: string; inject: string[]; state: string; effects: number; effectLabels: string[]; provides: string[] }[]
  services: { name: string; provider: string }[]
  pending: string[]
}

export function dumpAssembly(ctx: Context): AssemblyTree {
  return ctx.governanceSnapshot() as AssemblyTree
}

export interface EventGraphEdge { event: string; mode: string; direction: 'producer' | 'consumer'; detail: string }

/** 事件产消图：目录内每个事件 → 模式（生产语义）+ 处理器链（消费视图） */
export function dumpEventGraph(bus: EventBus, declared: Map<string, { mode: string }>): {
  events: { event: string; mode: string; consumers: { label: string; priority: number }[] }[]
  edges: EventGraphEdge[]
} {
  const events: { event: string; mode: string; consumers: { label: string; priority: number }[] }[] = []
  const edges: EventGraphEdge[] = []
  for (const [event, { mode }] of declared) {
    const consumers = bus.handlerChain(event)
    events.push({ event, mode, consumers })
    edges.push({ event, mode, direction: 'producer', detail: `dispatch(${mode}) at declared site（@mode 契约机器校验）` })
    for (const c of consumers) {
      edges.push({ event, mode, direction: 'consumer', detail: `${c.label} (priority=${c.priority})` })
    }
  }
  return { events, edges }
}
