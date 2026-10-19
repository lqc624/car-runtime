/**
 * 1.15-S2 · 引导消息排队扫描（K-STEER-1 / D-V02-9 / D-47 ②）
 *
 * 口径（红线先立后码）：
 *  - **消费契约**：内核出排队扫描查询面（未消费 user 事件按 seq 序枚举），FIFO 续跑调度
 *    在宿主装配层（turn 收口 → 扫描 → 逐条以事件自身 turnId 调 runTurn）——内核不改
 *    runTurn 调度语义（D-40 同款宿主装配层纪律）；
 *  - **pending 判定**：kind='user' 且该 turnId 无 turnEnd 事件（未闭合）。当前执行中 turn
 *    也未闭合但正在消费——由 opts.excludeTurnId 排除（宿主传活跃 turnId）；已消费（turnEnd
 *    已落）/ 已被 recover 补记 interrupted（turnEnd 已落，R-8 定性：消息已发未跑，重启后
 *    不重复消费）均不算 pending；
 *  - **逐条成 turn 不合并**：每条 pending 条目 = 一条 user 事件（含 turnId 与发出时刻 ts/
 *    seq）——宿主逐条消费；同 turnId 多条 user 事件逐条报出（宿主守规形态 = 每条引导消息
 *    append 时分配独立 turnId）；
 *  - **发出时刻落链**：引导 append 本身零包装（SessionLog.append 任意时刻可调——执行中
 *    append 无需内核加「允许」逻辑，D-47 ④）；**投影隔离红线**（引导不进当前 turn 投影）
 *    在 log.ts deriveMessages activeTurnId 口径落地，非本文件职责；
 *  - **model_visible=0**：pending user 事件在其所属 turn 被消费前不进任何模型请求
 *    （消费后以正常 user 事件身份进该 turn 投影——Model-visible means logged 由构造保证）。
 */
import type { SessionLog } from './log.ts'

export interface PendingSteerTurn {
  /** 引导 user 事件 seq（发出时刻链上位置——FIFO 序） */
  seq: number
  /** 引导 user 事件 ts（发出时刻时间戳——链序校验口径） */
  ts: number
  /** 引导事件 turnId（发出时分配的新 turnId——消费时宿主以同 turnId 调 runTurn） */
  turnId: string
  /** 引导消息正文（user 事件 payload 原样） */
  text: unknown
}

/** 排队扫描：未闭合 user 事件按 seq 序枚举（未消费引导队列——宿主 FIFO 续跑消费面） */
export function pendingSteerTurns(log: SessionLog, opts: { /** 排除当前执行中 turn（其 user 事件也未闭合但正在消费） */ excludeTurnId?: string } = {}): PendingSteerTurn[] {
  const closed = new Set<string>()
  for (const e of log.events) {
    if (e.kind === 'turnEnd') closed.add(e.turnId)
  }
  const out: PendingSteerTurn[] = []
  for (const e of log.events) {
    if (e.kind !== 'user') continue
    if (closed.has(e.turnId)) continue // 已消费 / 已 recover 补记 interrupted——不算 pending
    if (opts.excludeTurnId && e.turnId === opts.excludeTurnId) continue // 当前执行中 turn
    out.push({ seq: e.seq, ts: e.ts, turnId: e.turnId, text: e.payload })
  }
  return out
}
