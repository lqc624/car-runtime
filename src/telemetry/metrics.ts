/**
 * S17 · 采集面（D-2 enforce 数据窗口 S18–S20 前置）：零内容计数器
 *
 * 口径（M4系统设计增补 S17 采集面 / Q-08 遥测三原则 / D-3）：
 *  - 3 个 Counter：car_load_total{result} / car_unsigned_confirmed{confirmed} / car_registry_decision{source}；
 *    labels 仅枚举值（来源/结果/模式）——**零内容字段**（无代码/提示词/路径/会话 id 明文），Q-08 兼容可机器断言；
 *  - 双通道：遥测显式开（OTel 端点归用户）+ 登记表人工填报兜底（snapshot() 导出计数快照）；
 *    未开启遥测时仅进程内累计，不落地不缓存出站（BD-05 语义）；
 *  - 本层是可插拔计数钩子（onCount 注入面），非完整 OTel Metrics——完整面显式排除在 S17 外。
 */

export type CounterName = 'car_load_total' | 'car_unsigned_confirmed' | 'car_registry_decision'
/** labels 仅枚举值——零内容红线由 AllowedLabels 类型约束 */
export type AllowedLabels = { result?: 'ok' | 'failed'; confirmed?: 'yes' | 'no'; source?: 'registry' | 'npm-fallback' | 'rejected' | 'git' | 'path' }

export interface Counters {
  onCount(name: CounterName, labels?: AllowedLabels): void
  /** 计数快照（登记表人工填报兜底通道的数据源；不含任何内容字段） */
  snapshot(): Record<string, number>
}

export function createCounters(): Counters {
  const store = new Map<string, number>()
  return {
    onCount(name, labels = {}) {
      const key = name + Object.entries(labels).sort().map(([k, v]) => `|${k}=${v}`).join('')
      store.set(key, (store.get(key) ?? 0) + 1)
    },
    snapshot() {
      return Object.fromEntries([...store.entries()].sort())
    },
  }
}

/** 零内容红线自检：snapshot 键不得包含内容型模式（sk-/路径分隔/空格长串） */
export function assertZeroContent(snapshot: Record<string, number>): boolean {
  return Object.keys(snapshot).every(k => !/sk-|ghp_|\/|\\|.{60,}/.test(k))
}
