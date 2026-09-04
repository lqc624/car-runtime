/**
 * CAR 微内核骨架（F1 可逆注册+依赖注入 / F9 加载-运行两阶段 / ADR-002 双模式卸载）
 *
 * 设计口径（《系统设计》v1.1）：
 *  - 自研实现，范式借鉴 dsh/Cordis（inject 依赖推导、ctx.effect 可逆注册），代码不复用
 *  - 卸载双模式（ADR-002）：strict-topo = 消费者先于提供者逐层排空（依赖计数屏障）；
 *    concurrent = 跨 fiber Promise.all 并发。fiber 内一律注册逆序串行（确定性回卷）
 *  - 加载期错误必须显式（冲突链定位），禁止静默覆盖（US-7/N2）
 */
export type Disposer = () => void | Promise<void>
export interface PluginDef {
  name: string
  /** 声明所需服务依赖；加载顺序由依赖推导（缺依赖 = PENDING 等待，不手工编排） */
  inject?: string[]
  apply(ctx: PluginContext): void | Promise<void>
}
export interface DisposeReport {
  unloaded: string[]
  /** 实际卸载顺序（strict-topo = 消费者→提供者；供治理视图审计，M2） */
  order: string[]
  errors: { plugin: string; label: string; error: unknown }[]
}
interface Fiber {
  name: string
  inject: string[]
  disposables: { label: string; disposer: Disposer }[]
  state: 'PENDING' | 'ACTIVE' | 'DISPOSING' | 'DISPOSED'
}

const DEP_CYCLE = 'CAR-E-DEPCYCLE'

export class Context {
  private fibers = new Map<string, Fiber>()
  private services = new Map<string, { impl: unknown; provider: string }>()
  private pending: string[] = []

  /** 提供服务（provider 侧）；重复 provide 同名服务 = 加载期显式报错（禁静默覆盖） */
  provide(name: string, impl: unknown, provider = '<root>'): void {
    if (this.services.has(name)) {
      throw new Error(`${DEP_CYCLE}: service "${name}" already provided by "${this.services.get(name)!.provider}" (conflict chain: ${provider})`)
    }
    this.services.set(name, { impl, provider })
    this.tryMountPending()
  }

  /** 读取服务（consumer 侧，仅限已 inject 的插件 apply 内） */
  get(name: string): unknown {
    const s = this.services.get(name)
    if (!s) throw new Error(`${DEP_CYCLE}: service "${name}" not provided (inject 声明缺失或 provider 未就绪)`)
    return s.impl
  }

  /** 注册插件：依赖就绪即挂载，否则进入 PENDING 队列 */
  plugin(def: PluginDef): void {
    if (this.fibers.has(def.name)) {
      throw new Error(`${DEP_CYCLE}: plugin "${def.name}" already registered (duplicate registration is blocked)`)
    }
    const fiber: Fiber = { name: def.name, inject: def.inject ?? [], disposables: [], state: 'PENDING' }
    this.fibers.set(def.name, fiber)
    this.defs.set(def.name, def)
    if (fiber.inject.every(d => this.services.has(d))) this.mount(def, fiber)
    else this.pending.push(def.name)
  }

  private mount(def: PluginDef, fiber: Fiber): void {
    fiber.state = 'ACTIVE'
    const pluginCtx: PluginContext = {
      effect: (body: () => Disposer | Disposer[], label = 'anonymous') => {
        const disposers = typeof body === 'function' ? [body()] : [...body()]
        for (const d of disposers) fiber.disposables.push({ label, disposer: d as Disposer })
      },
      provide: (name: string, impl: unknown) => this.provide(name, impl, def.name),
      get: (name: string) => this.get(name),
      pluginName: def.name,
    }
    const ret = def.apply(pluginCtx)
    if (ret && typeof (ret as any).then === 'function') throw new Error(`${DEP_CYCLE}: async apply 不被 S1 骨架支持（启动期必须同步完成注册，异步初始化请走 effect）`)
    // 新提供的服务可能解锁 PENDING 插件
    this.tryMountPending()
  }

  private tryMountPending(): void {
    let progressed = true
    while (progressed) {
      progressed = false
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const name = this.pending[i]
        const fiber = this.fibers.get(name)!
        const def = this.defs.get(name)!
        if (fiber.inject.every(d => this.services.has(d))) {
          this.pending.splice(i, 1)
          this.mount(def, fiber)
          progressed = true
        }
      }
    }
  }

  private defs = new Map<string, PluginDef>()

  /** 卸载单个插件（回卷其全部副作用；fiber 内注册逆序） */
  async unload(name: string): Promise<void> {
    const fiber = this.fibers.get(name)
    if (!fiber || fiber.state === 'DISPOSED') return
    fiber.state = 'DISPOSING'
    for (const { label, disposer } of [...fiber.disposables].reverse()) {
      await disposer()
    }
    fiber.disposables = []
    fiber.state = 'DISPOSED'
  }

  /** 运行时整体卸载（ADR-002 双模式） */
  async disposeRuntime(opts: { order?: 'strict-topo' | 'concurrent' } = {}): Promise<DisposeReport> {
    const order = this.topoOrder()
    const report: DisposeReport = { unloaded: [], order: [], errors: [] }
    if ((opts.order ?? 'strict-topo') === 'strict-topo') {
      // 逐层排空：Kahn 分层为 provider→consumer 方向，卸载需反转（消费者层先于提供者层）
      for (const layer of [...order.layers].reverse()) {
        await Promise.all(layer.map(async name => {
          const fiber = this.fibers.get(name)!
          if (fiber.state !== 'ACTIVE') return
          fiber.state = 'DISPOSING'
          for (const { label, disposer } of [...fiber.disposables].reverse()) {
            try { await disposer() } catch (error) { report.errors.push({ plugin: name, label, error }) }
          }
          fiber.disposables = []
          fiber.state = 'DISPOSED'
          report.unloaded.push(name)
          report.order.push(name)
        }))
      }
    } else {
      // concurrent：全部 fiber 并发（对应 dsh Fiber._unload 行为——作为降级/对照模式保留）
      await Promise.all(order.all.map(async name => {
        const fiber = this.fibers.get(name)!
        if (fiber.state !== 'ACTIVE') return
        fiber.state = 'DISPOSING'
        await Promise.all([...fiber.disposables].reverse().map(async ({ label, disposer }) => {
          try { await disposer() } catch (error) { report.errors.push({ plugin: name, label, error }) }
        }))
        fiber.disposables = []
        fiber.state = 'DISPOSED'
        report.unloaded.push(name)
        report.order.push(name)
      }))
    }
    return report
  }

  /** 治理视图（F14）：装配配置树快照（插件/依赖/服务/副作用计数/状态）——只读，不改运行时 */
  governanceSnapshot() {
    return {
      plugins: [...this.fibers.values()].map(f => ({
        name: f.name,
        inject: [...f.inject],
        state: f.state,
        effects: f.disposables.length,
        effectLabels: f.disposables.map(d => d.label),
        provides: [...this.services.entries()].filter(([, s]) => s.provider === f.name).map(([n]) => n),
      })),
      services: [...this.services.entries()].map(([name, s]) => ({ name, provider: s.provider })),
      pending: [...this.pending],
    }
  }

  /** 依赖图拓扑分层（Kahn 分层；环 = 加载期显式报错） */
  private topoOrder(): { layers: string[][]; all: string[] } {    const active = [...this.fibers.values()].filter(f => f.state === 'ACTIVE')
    // provider 关系：插件 P provide 了服务 s，Q inject s => Q 依赖 P（Q 先卸载）
    const depsOf = new Map<string, Set<string>>() // name -> 依赖的 provider 集合
    for (const f of active) depsOf.set(f.name, new Set())
    for (const [name, s] of this.services) {
      if (depsOf.has(s.provider) && depsOf.has(name)) {
        // name 是 inject s 的插件（近似：以插件名=服务名匹配 inject 声明）
      }
    }
    for (const f of active) {
      for (const d of f.inject) {
        const s = this.services.get(d)
        if (s && s.provider !== '<root>' && depsOf.has(s.provider) && s.provider !== f.name) {
          depsOf.get(f.name)!.add(s.provider)
        }
      }
    }
    // Kahn 分层
    const remaining = new Map(depsOf)
    const layers: string[][] = []
    while (remaining.size) {
      const layer = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([n]) => n)
      if (!layer.length) throw new Error(`${DEP_CYCLE}: dependency cycle among [${[...remaining.keys()].join(', ')}]`)
      layers.push(layer)
      for (const n of layer) remaining.delete(n)
      for (const deps of remaining.values()) {
        for (const n of layer) deps.delete(n)
      }
    }
    return { layers, all: layers.flat() }
  }
}

/** 插件作用域上下文（effect 注册绑定到插件 fiber —— POC-2 实证的约束：不得透传根 ctx） */
export interface PluginContext {
  pluginName: string
  /** 可逆注册：body 返回 disposer 或 disposer 数组；卸载时按注册逆序回卷 */
  effect(body: () => Disposer | Disposer[], label?: string): void
  provide(name: string, impl: unknown): void
  get(name: string): unknown
}
