/**
 * J-08 invariant-n1 · N1 不变量常驻门禁（M2部署设计增补 §2.3）
 *
 * 口径：N1 =「Model-visible means logged」（F2）——请求时快照 === 日志前缀投影。
 * 本脚本为 CI 承载体：100 个确定性回放 fixtures（固定种子 PRNG）× 三类断言：
 *   ① 正向：每 fixture 的全部快照与当前日志前缀投影逐字节一致（assertModelVisibleLogged）
 *   ② 哈希链：verifyChain 全绿；篡改任一事件 payload 必然断链（防假绿自检——G-11 教训：
 *      「看起来在测」的门禁必须先证明它能 FAIL）
 *   ③ 事件种类覆盖：8 种 EventKind 在 100 fixtures 上全覆盖（≥95% 判据按 8/8 执行）
 * 任一失败 exit 1；输出 JSONL 明细 + 汇总行（审计口径与 J-05/J-18 一致）。
 */
import { SessionLog } from '../src/session/log.ts'
import { writeFileSync, mkdirSync } from 'node:fs'

/** 固定种子 PRNG（mulberry32）——fixtures 可复现，重跑不漂移 */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KINDS = ['user', 'assistant', 'toolCall', 'toolResult', 'turnEnd', 'goalUpdate', 'hostRaw', 'fork'] as const
type Kind = (typeof KINDS)[number]

const ACTOR_BY_KIND: Record<Kind, string> = {
  user: 'user', assistant: 'model', toolCall: 'model', toolResult: 'runtime',
  turnEnd: 'runtime', goalUpdate: 'runtime', hostRaw: 'runtime', fork: 'runtime',
}

function payloadFor(kind: Kind, i: number): unknown {
  switch (kind) {
    case 'user': return { text: `msg-${i}` }
    case 'assistant': return { text: `reply-${i}` }
    case 'toolCall': return { name: 'tool', args: { n: i } }
    case 'toolResult': return { ok: true, value: i }
    case 'turnEnd': return { reason: 'end_turn' }
    case 'goalUpdate': return { goal: `g-${i}` }
    case 'hostRaw': return { raw: `r-${i}` }
    case 'fork': return { from: `s-${i}` }
  }
}

/** 构造一个含随机事件序列与随机快照点的 fixture */
function buildFixture(seed: number): { log: SessionLog; kindsSeen: Set<Kind> } {
  const rand = prng(seed)
  const log = new SessionLog(`N1-F${String(seed).padStart(3, '0')}`)
  const kindsSeen = new Set<Kind>()
  const turns = 3 + Math.floor(rand() * 10)
  for (let t = 0; t < turns; t++) {
    // 每轮先随机登记 0-2 个快照（快照点 = 当前事件数，投影边界随机化）
    const snaps = Math.floor(rand() * 3)
    for (let s = 0; s < snaps; s++) log.snapshotModelRequest()
    const events = 1 + Math.floor(rand() * 6)
    for (let e = 0; e < events; e++) {
      const kind = KINDS[Math.floor(rand() * KINDS.length)]
      kindsSeen.add(kind)
      log.append(ACTOR_BY_KIND[kind] as never, kind, `T${t}`, payloadFor(kind, log.events.length))
    }
  }
  log.snapshotModelRequest() // 收尾快照：覆盖最后一条事件之后的前缀
  return { log, kindsSeen }
}

// ── 主流程 ──
const REPLAYS = 100
const results: Array<{ fixture: string; events: number; snapshots: number; ok: boolean; chainOk: boolean; tamperDetected: boolean }> = []
const kindCoverage = new Map<Kind, number>(KINDS.map(k => [k, 0]))
let failed = 0

for (let i = 0; i < REPLAYS; i++) {
  const { log, kindsSeen } = buildFixture(i)
  const fwd = log.assertModelVisibleLogged()
  const chainOk = log.verifyChain() === null

  // 防假绿自检：篡改中间事件 payload 必须被 verifyChain 检出
  const tampered = SessionLog.fromEvents(log.sessionId, log.events.map((e, idx) =>
    idx === Math.min(1, e.seq) ? { ...e, payload: { TAMPERED: true } } : e))
  const tamperDetected = tampered.verifyChain() !== null

  for (const k of kindsSeen) kindCoverage.set(k, (kindCoverage.get(k) ?? 0) + 1)
  const ok = fwd.ok && chainOk && tamperDetected
  if (!ok) failed++
  results.push({ fixture: log.sessionId, events: log.events.length, snapshots: log.stats().snapshots, ok: fwd.ok, chainOk, tamperDetected })
}

const covered = [...kindCoverage.values()].filter(n => n > 0).length
const coverage = covered / KINDS.length
const summary = { gate: 'J-08-invariant-n1', replays: REPLAYS, passed: REPLAYS - failed, failed, kindCoverage: `${covered}/${KINDS.length}`, coverage, ok: failed === 0 && coverage >= 0.95, ts: Date.now() }
console.log(JSON.stringify(summary))
mkdirSync('dist/ci', { recursive: true })
writeFileSync('dist/ci/invariant-n1.jsonl', results.map(r => JSON.stringify(r)).join('\n') + '\n')
process.exit(summary.ok ? 0 : 1)
