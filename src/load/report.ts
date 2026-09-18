/**
 * M6 · 加载报告与装配编排（《系统设计》§3.2.M6）
 *
 * 口径：
 *  - 五阶段流水线：discover → parse → validate → topo → register，任一阶段 FAIL 短路
 *    后续阶段（status=SKIPPED），FAIL 必附错误定位（文件 + 原因，冲突链进 conflicts）
 *  - LoadReportVO 字段名逐字对齐 §3.2.M6.3（installId/startedTime/durationMs/stages/warnings）；
 *    `error` 为规格外扩展字段（非冲突类失败——如 manifest 语法错——也需要文件+原因定位，BD-03）
 *  - git 直载（工作树内含 .git 即视为未经 registry 安装的直载来源）产生 CAR-W-GIT-DIRECT 告警（E-03 语义）
 *  - 热重载（SQ-05）：epoch+1 击穿缓存 → invalidate 旧实例（旧 ctx 后续访问经 Proxy 抛
 *    CAR-INVALIDATED）→ 重走 discover→register，产出五阶段加载报告
 */
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseManifest,
  validatePeers,
  computePeerViolations,
  mountPlugin,
  type Manifest,
  type LoadedPlugin,
} from './loader.ts'

// ==================== VO / DTO（字段名逐字对齐 §3.2.M6.3） ====================

export type LoadStage = 'discover' | 'parse' | 'validate' | 'topo' | 'register'
export type StageStatus = 'PASS' | 'FAIL' | 'SKIPPED'

/** 冲突链定位：文件 / 依赖路径 / 区间 / 实际版本（§3.2.M6.3 stages[].conflicts） */
export interface PeerConflictChain {
  /** 违规声明所在插件文件 */
  file: string
  peer: string
  range: string
  installed: string | null
  /** 依赖路径（声明来源，如 manifest.peers） */
  path: string
}

export interface LoadReportVO {
  installId: string
  startedTime: string          // ISO 8601
  durationMs: number           // 与 Q3/QS-05 基线比对（P95 ≤ 800ms）
  stages: Array<{
    stage: LoadStage
    status: StageStatus
    /** validate FAIL 时的 peer 冲突链 */
    conflicts?: PeerConflictChain[]
    /** 规格外扩展：FAIL 错误定位（文件 + 原因；冲突类失败用 conflicts，其余用 error） */
    error?: { file: string; reason: string }
  }>
  warnings: string[]           // 如 git 直载告警（E-03 语义）
}

/** 装配计划（renderLoadReport 的第一参；由 loadPlugins 在各阶段推进中冻结） */
export interface LoadPlan {
  installId: string
  source: string
  /** ISO 8601 起始时间（进入报告） */
  startedTime: string
  /** 内部计时基准（epoch ms，用于 durationMs） */
  startedAtMs: number
  /** discover 产物：插件文件绝对路径（拓扑序待 topo 阶段确定） */
  files: string[]
  reloadEpoch?: number
  /** 装配期告警（git 直载 / peer 豁免等，E-03 语义） */
  warnings: string[]
}

/** 阶段执行中间结果（内部类型，冻结前由各阶段填充） */
export interface LoadStageResult {
  stage: LoadStage
  status: StageStatus
  conflicts?: PeerConflictChain[]
  error?: { file: string; reason: string }
}

// ==================== renderLoadReport（报告冻结：plan + 阶段执行结果 → VO） ====================

let installSeq = 0

/** 生成安装 ID（进程内单调 + 时间戳，可读可留审计） */
export function newInstallId(now = Date.now()): string {
  installSeq += 1
  return `car-install-${now.toString(36)}-${installSeq.toString(36).padStart(3, '0')}`
}

export function renderLoadReport(plan: LoadPlan, stageReports: LoadStageResult[]): LoadReportVO {
  return {
    installId: plan.installId,
    startedTime: plan.startedTime,
    durationMs: Date.now() - plan.startedAtMs,
    stages: stageReports.map(s => ({
      stage: s.stage,
      status: s.status,
      ...(s.conflicts ? { conflicts: s.conflicts } : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
    warnings: [...plan.warnings],
  }
}

// ==================== 五阶段装配编排 ====================

export interface DiscoveredEntry {
  file: string
  manifestRaw: unknown
}

export interface LoadPluginsOptions {
  /** 插件目录（扫描 *.ts）或单插件文件路径 */
  source: string
  /** 热重载版本号：>0 时以 ?epoch=N 查询串击穿 ESM 缓存 */
  reloadEpoch?: number
  /** 批外已安装插件版本（peer 校验的 installed 基线；缺省仅用本批次内 manifest） */
  installedVersions?: Map<string, string>
  /** 显式声明 git 直载来源（如经 git URL 拉取后未走 registry 安装）——补充扫描 .git 探测 */
  gitDirect?: boolean
}

export interface LoadPluginsResult {
  report: LoadReportVO
  /** register 成功装配的插件（拓扑序；FAIL 短路时为已装配前缀或空） */
  plugins: LoadedPlugin[]
  /** 拓扑序 manifest（供 CLI/测试断言装配顺序） */
  order: Manifest[]
}

const GIT_URL_RE = /^(?:git\+|git@|ssh:\/\/git@)/
const CAR_W_GIT = 'CAR-W-GIT-DIRECT'
const CAR_E = (stage: string, msg: string) => `CAR-E-${stage.toUpperCase()}: ${msg}`
const STAGE_ORDER: LoadStage[] = ['discover', 'parse', 'validate', 'topo', 'register']

/** 五阶段装配：discover → parse → validate → topo → register（任一 FAIL 短路，后续 SKIPPED） */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadPluginsResult> {
  const startedAtMs = Date.now()
  const startedTime = new Date(startedAtMs).toISOString()
  const epoch = opts.reloadEpoch ?? 0
  const warnings: string[] = []
  const stages: LoadStageResult[] = []
  let files: string[] = []
  let ordered: Manifest[] = []

  // 短路收口：为尚未执行的阶段补 SKIPPED，冻结 plan → LoadReportVO
  const finish = (ps: LoadedPlugin[]): LoadPluginsResult => {
    const complete: LoadStageResult[] = [...stages]
    for (const s of STAGE_ORDER) {
      if (!complete.some(d => d.stage === s)) complete.push({ stage: s, status: 'SKIPPED' })
    }
    const plan: LoadPlan = {
      installId: newInstallId(startedAtMs),
      source: opts.source,
      startedTime,
      startedAtMs,
      files,
      reloadEpoch: epoch,
      warnings,
    }
    return { report: renderLoadReport(plan, complete), plugins: ps, order: ordered }
  }

  // ===== 阶段 1：discover（扫描插件目录 *.ts；git 直载来源产生告警） =====
  if (opts.gitDirect || GIT_URL_RE.test(opts.source)) {
    // git 直载告警先于扫描：直载 URL 本地不存在也能在 FAIL 报告中携带来源告警（E-03）
    warnings.push(`${CAR_W_GIT}: 插件来源为 git 直载（${opts.source}）——未经 registry 验签，建议改用 registry 安装（E-03）`)
  }
  try {
    files = discoverFiles(opts.source)
    if (existsSync(opts.source) && statSync(opts.source).isDirectory() && existsSync(join(opts.source, '.git'))) {
      warnings.push(`${CAR_W_GIT}: 插件目录位于 git 工作树（${opts.source}）——未经 registry 验签的直载来源（E-03）`)
    }
    if (!files.length) {
      stages.push({ stage: 'discover', status: 'FAIL', error: { file: opts.source, reason: CAR_E('discover', `no *.ts plugin files found under "${opts.source}"`) } })
      return finish([])
    }
    stages.push({ stage: 'discover', status: 'PASS' })
  } catch (e) {
    stages.push({ stage: 'discover', status: 'FAIL', error: { file: opts.source, reason: `${(e as Error).message}` } })
    return finish([])
  }

  // ===== 阶段 2：parse（parseManifest；manifest 取模块命名导出，缺失则按文件名合成） =====
  const entries: DiscoveredEntry[] = []
  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(file).href + (epoch ? `?epoch=${epoch}` : ''))) as { manifest?: unknown }
      entries.push({ file, manifestRaw: mod.manifest ?? { name: basename(file).replace(/\.ts$/, ''), version: '0.0.1' } })
    } catch (e) {
      stages.push({ stage: 'parse', status: 'FAIL', error: { file, reason: `CAR-E-PARSE: module import failed — ${(e as Error).message}` } })
      return finish([])
    }
  }
  const parsed: Array<{ file: string; manifest: Manifest }> = []
  for (const { file, manifestRaw } of entries) {
    try {
      parsed.push({ file, manifest: parseManifest(manifestRaw, file) })
    } catch (e) {
      stages.push({ stage: 'parse', status: 'FAIL', error: { file, reason: (e as Error).message } })
      return finish([])
    }
  }
  const manifests: Manifest[] = parsed.map(p => p.manifest)
  stages.push({ stage: 'parse', status: 'PASS' })

  // ===== 阶段 3：validate（peer 冲突链；豁免需 reason → 告警留痕） =====
  const installed = opts.installedVersions ?? new Map<string, string>()
  for (const m of manifests) installed.set(m.name, m.version)
  const conflicts: PeerConflictChain[] = []
  const exemptDetail: string[] = []
  let exemptedAny = false
  for (const { file, manifest: m } of parsed) {
    try {
      const r = validatePeers(m, installed)
      if (r.exempted) {
        // 豁免生效：不进 FAIL 冲突链，仅告警留痕（reason 已在 manifest 声明）
        exemptedAny = true
        for (const v of r.violations.filter(v => !v.optional)) {
          exemptDetail.push(`${file}: peer ${v.peer}@${v.range} vs ${v.installed ?? '<missing>'}`)
        }
      }
    } catch {
      // 严格模式硬冲突：不中止校验其余插件，收集全量冲突链后统一 FAIL（BD-03 定位口径）
      for (const v of computePeerViolations(m, installed).filter(v => !v.optional)) conflicts.push(toChain(file, v))
    }
  }
  if (conflicts.length) {
    stages.push({ stage: 'validate', status: 'FAIL', conflicts })
    return finish([])
  }
  if (exemptedAny) warnings.push(`CAR-W-PEER-EXEMPT: peer 冲突经 manifest.peerPolicyOverride 显式豁免（${exemptDetail.join('; ')}）——reason 已声明，审计留痕`)
  stages.push({ stage: 'validate', status: 'PASS' })

  // ===== 阶段 4：topo（peer 依赖边 → Kahn 分层拓扑排序；环 = 显式报错） =====
  try {
    ordered = topoSort(manifests)
  } catch (e) {
    stages.push({ stage: 'topo', status: 'FAIL', error: { file: opts.source, reason: (e as Error).message } })
    return finish([])
  }
  stages.push({ stage: 'topo', status: 'PASS' })

  // ===== 阶段 5：register（mountPlugin 按拓扑序装配；重名 = 显式冲突 + 冲突链定位） =====
  const plugins: LoadedPlugin[] = []
  const seenNames = new Set<string>()
  for (const m of ordered) {
    const file = parsed.find(p => p.manifest.name === m.name)?.file ?? ''
    if (seenNames.has(m.name)) {
      // M6-BUG-1：重名冲突链 = 全部同名文件路径（BD-03：文件级定位，不再误导为依赖环）
      const dupFiles = parsed.filter(p => p.manifest.name === m.name).map(p => p.file)
      stages.push({ stage: 'register', status: 'FAIL', error: { file, reason: `CAR-E-DUP: plugin "${m.name}" registered more than once (duplicate registration is blocked) (conflict chain: ${dupFiles.join(', ')})` } })
      return finish(plugins)
    }
    seenNames.add(m.name)
    try {
      plugins.push(await mountPlugin({ file, manifest: m, reloadEpoch: epoch }))
    } catch (e) {
      stages.push({ stage: 'register', status: 'FAIL', error: { file, reason: (e as Error).message } })
      return finish(plugins)
    }
  }
  stages.push({ stage: 'register', status: 'PASS' })
  return finish(plugins)
}

function toChain(declaringFile: string, v: { peer: string; range: string; installed: string | null }): PeerConflictChain {
  return { file: declaringFile, peer: v.peer, range: v.range, installed: v.installed, path: 'manifest.peers' }
}

/** discover：目录扫描 *.ts（排除 .d.ts / .spec.ts）；单文件直载原样返回 */
function discoverFiles(source: string): string[] {
  if (!existsSync(source)) {
    throw new Error(CAR_E('discover', `source not found: "${source}"`))
  }
  if (statSync(source).isFile()) return [source]
  return readdirSync(source)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.spec.ts'))
    .sort()
    .map(f => join(source, f))
}

/**
 * topo：Kahn 分层——边 = 非可选 peer 指向批次内另一插件；环 = CAR-E-DEPCYCLE。
 * 重名安全（M6-BUG-1）：放置判定按 manifest 逐个推进 + pushedNames 记名级放置——
 * 重名 manifest 在首个同名放置后即可全部放置，不再因 name 键碰撞被误判为依赖环；
 * 重名的显式冲突由 register 阶段 CAR-E-DUP 报出（BD-03：不误导定位到 topo）。
 */
function topoSort(manifests: Manifest[]): Manifest[] {
  const names = new Set(manifests.map(m => m.name))
  const depsOf = new Map<string, Set<string>>()
  for (const m of manifests) {
    const deps = depsOf.get(m.name) ?? new Set<string>()
    for (const p of m.peers ?? []) {
      if (!p.optional && names.has(p.peer) && p.peer !== m.name) deps.add(p.peer)
    }
    depsOf.set(m.name, deps)
  }
  const ordered: Manifest[] = []
  const pushed = new Set<Manifest>()
  const pushedNames = new Set<string>()
  let progressed = true
  while (ordered.length < manifests.length && progressed) {
    progressed = false
    for (const m of manifests) {
      if (pushed.has(m)) continue
      // 就绪条件：自身名已放置（重名后续项）或全部 peer 依赖已放置
      if (pushedNames.has(m.name) || [...depsOf.get(m.name)!].every(d => pushedNames.has(d))) {
        ordered.push(m)
        pushed.add(m)
        pushedNames.add(m.name)
        progressed = true
      }
    }
  }
  if (ordered.length < manifests.length) {
    // 仅「未放置且依赖永不齐全」的真实依赖环落入此分支（重名已被 pushedNames 消化）
    const cyclic = [...new Set(manifests.filter(m => !pushed.has(m)).map(m => m.name))]
    throw new Error(`CAR-E-DEPCYCLE: dependency cycle among [${cyclic.join(', ')}] (peer 边成环，拓扑排序中止)`)
  }
  return ordered
}

// ==================== 热重载（SQ-05：car reload） ====================

/** 报告 → stdout 行（CLI 打印用；PASS/FAIL + 定位 + 耗时） */
export function formatLoadReport(report: LoadReportVO): string[] {
  const lines: string[] = []
  lines.push(`加载报告 installId=${report.installId} startedTime=${report.startedTime}`)
  for (const s of report.stages) {
    let line = `  [${s.stage.padEnd(8)}] ${s.status}`
    if (s.error) line += ` — ${s.error.reason} (file: ${s.error.file})`
    if (s.conflicts?.length) {
      line += ' — ' + s.conflicts.map(c => `${c.file}: peer ${c.peer}@${c.range} required but ${c.installed ?? '<missing>'} installed (path: ${c.path})`).join('; ')
    }
    lines.push(line)
  }
  lines.push(`  durationMs=${report.durationMs} warnings=${report.warnings.length}`)
  for (const w of report.warnings) lines.push(`  ⚠ ${w}`)
  return lines
}

/** 热重载会话：持有 epoch 与实例注册表，reload() 重走五阶段并 invalidate 旧实例 */
export class ReloadManager {
  #epoch = 0
  #instances: LoadedPlugin[] = []
  #reports: LoadReportVO[] = []

  get epoch(): number { return this.#epoch }
  get instances(): readonly LoadedPlugin[] { return this.#instances }
  get history(): readonly LoadReportVO[] { return this.#reports }

  /**
   * SQ-05 时序：epoch+1 击穿缓存 → invalidate 旧实例（旧 ctx 后续访问抛 CAR-INVALIDATED）
   * → 重走 discover→register → 五阶段报告。任一阶段 FAIL 即返回 FAIL 报告（旧实例已失效，
   * 不做静默回退——加载期显式失败红线）。
   */
  async reload(source: string, opts: Omit<LoadPluginsOptions, 'source' | 'reloadEpoch'> = {}): Promise<LoadPluginsResult> {
    this.#epoch += 1
    for (const old of this.#instances) old.invalidate()
    const result = await loadPlugins({ ...opts, source, reloadEpoch: this.#epoch })
    this.#instances = result.plugins
    this.#reports = [...this.#reports, result.report]
    return result
  }
}
