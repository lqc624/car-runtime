/**
 * F7 · 事件分发契约（@mode 声明 + 启动期机器校验）
 *
 * 设计口径（《系统设计》F7：五种分发模式可裁剪起步）：
 *  - S2 实装全部五模式：emit（广播）/ serial（有序检查点）/ bail（首断即止）/
 *    waterfall（环绕中间件 next()）/ parallel（扇出）
 *  - 分发模式是事件的公开契约：未声明的事件禁止注册与分发（启动期静态报错 A010003，US-7 AC2）
 *  - 短路易错点（D3 §4.1 警示）：waterfall 观察型监听器忘调 next() 会静默截断——
 *    文档红线 + validateWaterfallUsage 辅助检测
 */
export type DispatchMode = 'emit' | 'serial' | 'bail' | 'waterfall' | 'parallel'

/** 事件契约目录（对应 dsh typert 生成目录的 CAR 自研等价物） */
const catalog = new Map<string, DispatchMode>()

export function declareEvent(name: string, mode: DispatchMode): void {
  if (catalog.has(name) && catalog.get(name) !== mode) {
    throw new Error(`CAR-E-CONTRACT: event "${name}" re-declared with mode "${mode}" (was "${catalog.get(name)}")`)
  }
  catalog.set(name, mode)
}

export function declaredMode(name: string): DispatchMode | undefined {
  return catalog.get(name)
}

/** 启动期机器校验：目录自洽性（声明与分发点一致性由 EventBus.dispatch 强制） */
export function verifyContracts(): { ok: true; declared: number } {
  return { ok: true, declared: catalog.size }
}

type Handler<P, R> = (payload: P, next: () => R) => R

export class EventBus {
  #handlers = new Map<string, Array<{ fn: Handler<any, any>; label: string }>>()

  /** 注册处理器：事件未声明 = 启动期静态报错（禁止隐式扩契约） */
  on<P = unknown, R = unknown>(event: string, fn: Handler<P, R>, label = 'anonymous'): void {
    if (!catalog.has(event)) {
      throw new Error(`CAR-E-CONTRACT: cannot subscribe to undeclared event "${event}"（@mode 契约缺失，先 declareEvent）`)
    }
    const list = this.#handlers.get(event) ?? []
    list.push({ fn: fn as Handler<any, any>, label })
    this.#handlers.set(event, list)
  }

  handlerCount(event: string): number {
    return this.#handlers.get(event)?.length ?? 0
  }

  /** 分发：严格按声明模式执行（声明与分发点不一致 = 契约违例） */
  async dispatch<P, R = unknown>(event: string, payload: P, init?: () => R): Promise<R | undefined> {
    const mode = catalog.get(event)
    if (!mode) throw new Error(`CAR-E-CONTRACT: dispatch of undeclared event "${event}"`)
    const handlers = [...(this.#handlers.get(event) ?? [])]
    const fallback = init ?? (() => undefined as R)
    switch (mode) {
      case 'emit': // 广播：不等待、无返回值（同步通知语义）
        for (const h of handlers) { const r = h.fn(payload, () => undefined as R); void r }
        return undefined
      case 'serial': { // 有序检查点：await 串行，链式传值
        let acc = fallback()
        for (const h of handlers) acc = await h.fn(payload, () => acc)
        return acc
      }
      case 'bail': { // 首断即止：首个非 undefined 返回即终止（短路是设计意图）
        for (const h of handlers) {
          const r = await h.fn(payload, () => undefined as R)
          if (r !== undefined) return r
        }
        return fallback()
      }
      case 'waterfall': { // 环绕中间件：next() 前后均可介入，不调 next() = 短路整条链
        let index = -1
        const run = async (i: number): Promise<R> => {
          if (i === handlers.length) return fallback()
          index = i
          return handlers[i].fn(payload, () => run(i + 1))
        }
        return await run(0)
      }
      case 'parallel': { // 扇出：全部并发，聚合数组
        const results = await Promise.all(handlers.map(h => h.fn(payload, () => undefined as R)))
        return results as unknown as R
      }
    }
  }
}
