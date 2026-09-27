/**
 * CAR CLI（N2 DX 基线 / US-1 / §6.5 审计触点）
 *
 * 命令（语义化退出码：0=成功，1=数据校验失败，2=用法/输入不可用）：
 *   car run <plugin.ts> [--turns N]     快速上手流：装配插件 → 跑一轮对话 → 日志落盘 → 审计摘要
 *   car reload <plugin.ts|dir>          热重载：epoch 击穿缓存 → invalidate 旧实例 → 五阶段加载报告
 *   car session verify <events.jsonl[.zstd]>      哈希链完整性校验（撕裂尾显式报告；审计员入口）
 *   car session replay <events.jsonl[.zstd]>      deriveMessages 投影回放（不依赖模型状态）
 *   car session export <file> --out <dir> [--zstd]  取证包导出（SQ-06：断链中止；落盘读回重验，离线自证）
 *   car session rebuild-index <root> [--db <path>]  从 JSONL 重建 SQLite 会话索引（幂等；断链/坏格式文件入 errors 跳过）
 *   car doctor                          环境自检（Node 版本/沙箱/凭据/签名/keychain/连通性）
 *   car plugin-sign keygen|sign|verify  插件签名工具（1.1-S1：keygen/sign/verify；离线 minisign 轨）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { probeCapabilities, SandboxExecutor } from './sandbox/sandbox.ts'
import { SessionLog, loadSessionLog, type SessionEvent } from './session/log.ts'
import { SessionFileStore } from './session/store.ts'
import { compressJsonlZstd, decodeLogBuffer, zstdAvailable } from './session/format.ts'
import { exportForensicsBundle, verifyBundle, type ExportMeta } from './session/export.ts'
import { runTurn } from './loop/stop.ts'
import { Context } from './kernel/context.ts'
import { mountPlugin } from './load/loader.ts'
import { verifyPluginFile } from './load/sigGate.ts'
import { loadCarConfig, mergeSignatureGate } from './load/config.ts'
import { generateSigningKeypair, signPluginFile, resolveTrustRoot } from './load/sign.ts'
import { doctorCredentials, doctorConnectivity, doctorKeychain, doctorSignature } from './dx/doctor.ts'

const HELP = `用法: car <command> [args]
  run <plugin.ts> [--sig-enforce] [--config <path>]
                                    装配并运行插件（快速上手流；装载前签名门 warn 缺省）
  reload <file|dir> [--sig-enforce] [--config <path>]
                                    热重载插件并打印六阶段加载报告（含 verify 签名门）
  session verify <file>            哈希链完整性校验（撕裂尾显式报告）
  session replay <file>            会话回放（deriveMessages 投影）
  session export <file> --out <dir> [--zstd]
                                    取证包导出（断链中止；落盘读回重验，离线自证）
  session rebuild-index <root> [--db <path>]
                                    从 JSONL 重建 SQLite 会话索引（幂等）
  doctor                环境自检
  plugin-sign keygen [--out <前缀>] [--force]
                                    生成 ed25519 签名密钥对（<前缀>.priv PKCS8 DER / <前缀>.pub SPKI base64；缺省前缀 car-release）
  plugin-sign sign <file...> [--key <priv>]
                                    对插件文件签名，写 <file>.minisig sidecar（被签物 = 文件裸字节 sha256 hex；改动文件必须重签）
  plugin-sign verify <file...> [--trust-root <spki base64>]
                                    验证签名（信任根序：--trust-root > CAR_TRUST_ROOT > ./car-release.pub；缺签/坏签均 FAIL）
签名门环境变量：CAR_SIG_ENFORCE=1 切 enforce；CAR_TRUST_ROOT=<ed25519 spki base64>；
CAR_UNSIGNED_ALLOW=1 显式声明豁免（warn 缺签路径计数 confirmed=yes，横幅保留）
配置文件通道（1.1）：cwd car.config.json 或 --config <path>；键位 sandbox.unsigned.allow /
sandbox.sig.enforce / sandbox.sig.trustRoot；优先级 flag > env > 配置 > 缺省；未知键 fail-visible`

// 进程内热重载会话（ReloadManager 持有 epoch 与实例注册表；同进程连续 reload 语义完整）
let reloadMgrPromise: Promise<import('./load/report.ts').ReloadManager> | undefined
function getReloadManager() {
  reloadMgrPromise ??= import('./load/report.ts').then(m => new m.ReloadManager())
  return reloadMgrPromise
}

/** 取 flag 的值（--config <path> 等；缺位返回 undefined） */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/** mcp-serve 插件源收集：--plugin <file|dir> 可重复 + CAR_PLUGINS env（';' 分隔，Windows 安全） */
function collectPluginSources(argv: string[]): { sources: string[]; error?: string } {
  const sources: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--plugin') continue
    const v = argv[++i]
    if (!v) return { sources, error: '缺少 --plugin 路径' }
    sources.push(v)
  }
  for (const s of (process.env.CAR_PLUGINS ?? '').split(';')) {
    const t = s.trim()
    if (t) sources.push(t)
  }
  return { sources }
}

/**
 * 装载签名门选项装配（1.1-S3 统一入口）：flag > env > car.config.json > 缺省 warn。
 * 配置文件 fail-visible：显式路径不存在 / 坏 JSON / 未登记键 → 返回 error 由调用方中止（exit 2）。
 */
function resolveSigGate(argv: string[]): { options: import('./load/sigGate.ts').SignatureGateOptions; error?: string } {
  const cfg = loadCarConfig({ explicitPath: flagValue(argv, '--config') })
  if (cfg.error) return { options: {}, error: cfg.error }
  return { options: mergeSignatureGate(process.env, cfg.config, argv.includes('--sig-enforce')) }
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv
  switch (cmd) {
    case 'run': {
      const file = rest[0]
      if (!file) { console.error('缺少插件文件参数'); return 2 }
      const t0 = Date.now()
      // 环节 0：装载前签名门（M5-S28 装载接线 + 1.1-S3 配置通道：flag > env > car.config.json > 缺省 warn）
      const sig = resolveSigGate(rest)
      if (sig.error) { console.error(sig.error); return 2 }
      const g = verifyPluginFile(file, sig.options)
      if (!g.allowed) { console.error(`签名门禁拒绝：${g.error ?? 'CAR-E-SIG: rejected'}`); return 1 }
      if (g.warning) console.log(`[0/5 签名] ⚠ ${g.warning}`)
      // 环节 1：装配加载
      const manifest = { name: file.replace(/.*[/\\]/, '').replace(/\.ts$/, ''), version: '0.0.1' }
      const plugin = await mountPlugin({ file, manifest })
      const ctx = new Context()
      const log = new SessionLog('S-' + Date.now().toString(36))
      // §3.2.M7.5「先落日志后放行」：run 流全程逐事件 fsync 落盘（append 返回 = 已过掉电窗口）
      const store = new SessionFileStore(`session-${log.sessionId}.jsonl`)
      log.attachSink(line => store.append(line))
      const hostTools: any[] = []
      ctx.plugin({ name: plugin.manifest.name, apply: (c) => {
        plugin.bindCore({
          registerTool: (t) => { hostTools.push(t); c.provide('tool:' + t.name, t) },
          getRegisteredTools: () => hostTools,
        })
        plugin.api.registerTool({
          name: 'demo_tool', run: async () => 'demo-ok',
        })
      } })
      console.log(`[1/5 装配] OK（${Date.now() - t0}ms，工具: ${hostTools.map(t => t.name).join(', ') || '无'}）`)
      // 环节 2-3：沙箱探测 + 事件运行 + 停止收口
      const probe = await probeCapabilities()
      const sandbox = new SandboxExecutor({ probe, audit: () => {}, workspace: process.cwd() })
      console.log(`[2/5 沙箱] ${probe.degraded ? `降级（${probe.reason}）——Q-04 约束生效` : 'Landlock 就绪'}`)
      log.append('user', 'user', 'T0', '请调用 demo_tool 并汇报')
      const r = await runTurn({
        log, turnId: 'T0',
        preset: { mode: 'confirm', authorize: async () => { console.log('[授权] 确认模式：放行 demo_tool'); return true } },
        tools: new Map([['demo_tool', { declaredSideEffect: 'write', run: async () => 'demo-ok' } as any]]),
        model: async () => ({ stopReason: 'toolUse' as const, toolCalls: [{ id: 'c1', tool: 'demo_tool', args: {} }] }),
      })
      console.log(`[3/5 收口] turnEnd=${r.reason}（steps=${r.steps}）`)
      // 环节 4：落盘收口（全程逐事件 fsync 已发生，此处仅关句柄核对）
      store.close()
      console.log(`[4/5 落盘] ${store.path}（${log.events.length} 事件逐事件 fsync，哈希链 ${log.verifyChain() === null ? '完整' : '断链!'}）`)
      // 环节 5：审计回放
      const replay = log.deriveMessages()
      console.log(`[5/5 回放] ${replay.length} 条消息投影（Model-visible means logged: ${log.assertModelVisibleLogged().ok ? 'PASS' : 'FAIL'}）`)
      console.log(`首插件跑通总耗时：${((Date.now() - t0) / 1000).toFixed(1)}s（N2 目标 ≤300s）`)
      return 0
    }
    case 'reload': {
      const target = rest[0]
      if (!target) { console.error('缺少插件文件或目录参数'); return 2 }
      const { formatLoadReport } = await import('./load/report.ts')
      const mgr = await getReloadManager()
      // 装载签名门透传（M5-S28 + 1.1-S3 配置通道）：flag > env > car.config.json，六阶段报告含 verify
      const sig = resolveSigGate(rest)
      if (sig.error) { console.error(sig.error); return 2 }
      const { report, plugins } = await mgr.reload(target, { signature: sig.options })
      for (const line of formatLoadReport(report)) console.log(line)
      console.log(`装配插件：${plugins.map(p => `${p.manifest.name}@${p.manifest.version}`).join(', ') || '无'}`)
      return report.stages.some(s => s.status === 'FAIL') ? 1 : 0
    }
    case 'doctor': {
      const probe = await probeCapabilities()
      console.log(`node: ${process.version}（要求 ≥22.19）`)
      console.log(`sandbox: ${probe.degraded ? `DEGRADED（${probe.reason}）` : 'Landlock+seccomp 就绪'}`)
      console.log(`盘加密提示: ${process.platform === 'win32' ? '建议启用 BitLocker' : '建议启用 LUKS/FileVault'}`)
      // M6 增强：凭据存在性（只报 present/not-set，值永不打印）
      for (const c of doctorCredentials()) {
        console.log(`credentials.${c.envVar}: ${c.present ? '已设置（值不打印）' : `未设置 — ${c.hint}`}`)
      }
      // M8 增强：keychain 通道状态（模型凭据读取面；缺席显式降级不静默）
      const kc = doctorKeychain()
      console.log(`keychain: ${kc.available ? '就绪' : `缺席（显式降级）— ${kc.note}`}`)
      // 1.1-S2 增强：签名就绪行（mode 生效值 / 信任根可解析性 / 配置文件通道发现态；诊断只读）
      const sig = doctorSignature({ cwd: process.cwd(), configPath: flagValue(rest, '--config') })
      console.log(`signature: ${sig.detail}`)
      // M6 增强：registry 连通性（不可达 = SKIPPED 显式跳过，离线不失败）
      const conn = await doctorConnectivity()
      console.log(`connectivity: ${conn.status} — ${conn.detail}${conn.status === 'PASS' ? `（${conn.latencyMs}ms）` : ''}`)
      return 0
    }
    case 'session': {
      const [sub, ...args] = rest
      const flags: Record<string, string | true> = {}
      const positional: string[] = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === '--zstd') flags.zstd = true
        else if (a === '--out' || a === '--db') flags[a.slice(2)] = args[++i] ?? ''
        else positional.push(a)
      }
      // C-02 索引重建（§3.2.M7.5 Step 3「异步可容忍，丢失可 rebuild」；幂等单事务）
      if (sub === 'rebuild-index') {
        const root = positional[0]
        if (!root) { console.error('缺少 sessions 根目录参数'); return 2 }
        const { rebuildIndex } = await import('./session/indexStore.ts')
        try {
          const r = await rebuildIndex(root, (flags.db as string) || join(root, 'sessions-index.db'))
          for (const e of r.errors) console.error(`[index-skip] ${e.file}: ${e.reason}`)
          console.log(`索引重建：${r.rows.length} 会话入索引，${r.errors.length} 个文件跳过 → ${r.dbPath}`)
          for (const row of r.rows) {
            console.log(`  ${row.sessionId}  events=${row.eventCount}  encoding=${row.encoding}${row.tornTail ? '  tornTail(半行已显式丢弃)' : ''}`)
          }
          return 0
        } catch (e) { console.error((e as Error).message); return 2 }
      }
      const file = positional[0]
      if (!file) { console.error('缺少文件参数'); return 2 }
      if (sub === 'export' && !flags.out) { console.error('缺少 --out 目录参数'); return 2 }
      let loaded: ReturnType<typeof loadSessionLog>
      try { loaded = loadSessionLog(file) } catch (e) { console.error((e as Error).message); return 2 }
      const { log, brokenAt } = loaded
      if (loaded.tornTail) console.error(`[torn-tail] 撕裂尾 ${loaded.tornTailBytes} 字节已显式丢弃（崩溃半行，非断链）`)
      if (sub === 'verify') {
        if (brokenAt !== null) { console.error(`断链 @ seq=${brokenAt}（审计中止）`); return 1 }
        console.log(`哈希链完整：${log.events.length} 事件（encoding=${loaded.encoding}）`)
        return 0
      }
      if (sub === 'replay') {
        if (brokenAt !== null) { console.error(`断链 @ seq=${brokenAt}（拒绝回放带病日志）`); return 1 }
        for (const m of log.deriveMessages()) console.log(JSON.stringify(m))
        return 0
      }
      // 取证包导出（§3.2.M7.2 导出行 + SQ-06 时序：verifyHashChain → deriveMessages 可用 → 落盘 → 读回重验）
      if (sub === 'export') {
        const outDir = flags.out as string | undefined
        if (!outDir) { console.error('缺少 --out 目录参数'); return 2 }
        if (brokenAt !== null) { console.error(`断链 @ seq=${brokenAt}——导出中止（SQ-06：不产出带病审计包）`); return 1 }
        const wantZstd = flags.zstd === true
        if (wantZstd && !zstdAvailable()) { console.error('CAR-E-ZSTD: --zstd 需 zstd 能力（22.15+/23.8+ 原生内置，当前 Node 无）'); return 2 }
        const events = log.events as SessionEvent[]
        const meta: ExportMeta = {
          sessionId: log.sessionId,
          exportedBy: process.env.USERNAME ?? process.env.USER ?? 'unknown',
          exportedAt: new Date().toISOString(),
          runtimeVersion: process.version,
          sessionRange: { fromSeq: 0, toSeq: Math.max(events.length - 1, 0) },
        }
        const bundle = exportForensicsBundle(log, meta)
        const eventsFile = bundle.files[0]!
        let zbuf: Buffer | undefined
        if (wantZstd) {
          zbuf = compressJsonlZstd(eventsFile.content)
          bundle.manifest.storage = {
            encoding: 'zstd',
            storedAs: eventsFile.name + '.zstd',
            physicalSha256: createHash('sha256').update(zbuf).digest('hex'),
          }
          // storage 注入后重生成 manifest 自身条目（自证口径：盘上 manifest.json 与 bundle 一致）
          const mf = bundle.files.find(f => f.name === 'manifest.json')!
          mf.content = JSON.stringify(bundle.manifest, null, 2)
          mf.sha256 = createHash('sha256').update(mf.content).digest('hex')
        }
        mkdirSync(outDir, { recursive: true })
        const eventsPath = join(outDir, wantZstd ? bundle.manifest.storage!.storedAs : eventsFile.name)
        mkdirSync(dirname(eventsPath), { recursive: true })
        if (zbuf) writeFileSync(eventsPath, zbuf)
        else writeFileSync(eventsPath, eventsFile.content, 'utf-8')
        const mfEntry = bundle.files.find(f => f.name === 'manifest.json')!
        const manifestPath = join(outDir, 'manifest.json')
        writeFileSync(manifestPath, mfEntry.content, 'utf-8')
        // 落盘读回重验（离线自证：仅凭导出目录字节，不依赖源文件与运行时状态）
        const diskEvents = readFileSync(eventsPath)
        const diskText = decodeLogBuffer(diskEvents).text
        const diskManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as typeof bundle.manifest
        const rechecked =
          diskText === eventsFile.content &&
          createHash('sha256').update(diskText).digest('hex') === diskManifest.files[0]!.sha256 &&
          JSON.stringify(diskManifest) === JSON.stringify(bundle.manifest) &&
          (!zbuf || createHash('sha256').update(diskEvents).digest('hex') === diskManifest.storage!.physicalSha256) &&
          verifyBundle({ files: [{ name: diskManifest.files[0]!.name, content: diskText, sha256: diskManifest.files[0]!.sha256 }], manifest: diskManifest }).ok
        if (!rechecked) { console.error('CAR-E-EXPORT: 落盘读回重验失败——导出目录与清单不自证，已中止'); return 1 }
        console.log(`取证包导出：${log.events.length} 事件 → ${outDir}（链 ${bundle.manifest.chainHead?.slice(0, 8)}…→${bundle.manifest.chainTail?.slice(0, 8)}…，encoding=${wantZstd ? 'zstd' : 'plain'}）`)
        console.log(`离线自证 PASS：manifest.json + sessions/${log.sessionId}/events.jsonl${wantZstd ? '.zstd' : ''} 读回重验一致`)
        return 0
      }
      console.error(HELP); return 2
    }
    case 'mcp-serve': {
      // E-6 宿主实连入口（M4-S18）：CAR-as-MCP-Server——宿主（Claude Code/Codex）经 stdio JSON-RPC 接入
      // 1.1-S4 装载接线：--plugin <file|dir>（可重复）/ CAR_PLUGINS env → 六阶段流水线（verify 门先于
      // import()）挂载进 Context + car_load_total/car_unsigned_confirmed 全链计数。
      // 边界（1.1 规划 W2-4，防口径外推）：此处是「装载接线 + 采集全链」——插件被真实装配
      // （factory 执行 + bindCore 冲刷注册项），但宿主会话执行插件工具的执行接线属 W1 登记后续
      // （sessionTurn 仍为事件批归一化）。
      const hostIdx = rest.indexOf('--host')
      const { HOST_MAPPINGS } = await import('./host/mappings.ts')
      // 默认宿主取映射表首项（数据驱动，静态架构断言红线：宿主标识只在 mappings 数据文件）
      const hostId = hostIdx >= 0 ? rest[hostIdx + 1] : HOST_MAPPINGS[0].hostId
      // 宿主白名单数据驱动（静态架构断言红线：宿主标识字符串只允许出现在 mappings 数据文件）
      if (!HOST_MAPPINGS.some(h => h.hostId === hostId)) {
        console.error(`未知宿主 "${hostId}"（可用：${HOST_MAPPINGS.map(h => h.hostId).join(' | ')}）`); return 2
      }
      // 1.1-S3 配置通道（--config / cwd car.config.json）+ 签名门选项（flag > env > 配置 > 缺省 warn）
      const sig = resolveSigGate(rest)
      if (sig.error) { console.error(sig.error); return 2 }
      const pluginsArg = collectPluginSources(rest)
      if (pluginsArg.error) { console.error(pluginsArg.error); return 2 }
      const { createCounters, assertZeroContent } = await import('./telemetry/metrics.ts')
      const counters = createCounters()
      if (pluginsArg.sources.length) {
        const { loadPlugins, formatLoadReport } = await import('./load/report.ts')
        const { Context } = await import('./kernel/context.ts')
        const ctx = new Context()
        const hostTools: any[] = []
        for (const src of pluginsArg.sources) {
          const result = await loadPlugins({ source: src, signature: { ...sig.options, onCount: (n, l) => counters.onCount(n, l) } })
          if (result.report.stages.some(s => s.status === 'FAIL')) {
            // 加载期显式失败红线（两模式一致）：FAIL = 插件未装上，服务不得静默缺插件启动。
            // DEC-1 warn/enforce 之分仅在签名门缺签路径（warn=横幅放行，enforce=verify FAIL 走此分支）
            for (const line of formatLoadReport(result.report)) console.error(line)
            console.error('[car mcp-serve] 装载 FAIL——fail-closed 启动中止（warn 仅豁免缺签，不豁免装载失败）')
            return 1
          }
          for (const w of result.report.warnings) console.error(`[car mcp-serve] ⚠ ${w}`)
          for (const p of result.plugins) {
            ctx.plugin({ name: p.manifest.name, apply: c => {
              p.bindCore({
                registerTool: t => { hostTools.push(t); c.provide('tool:' + t.name, t) },
                getRegisteredTools: () => hostTools,
              })
            } })
          }
          const names = result.plugins.map(p => `${p.manifest.name}@${p.manifest.version}`).join(', ')
          console.error(`[car mcp-serve] plugins loaded: ${names}（tools: ${hostTools.map(t => t.name).join(', ') || '无'}；装载已接线，会话内执行接线属 W1 登记后续）`)
        }
      }
      const { HostGateway } = await import('./host/hostGateway.ts')
      const { createRuntimeFacade } = await import('./host/facade.ts')
      const { createStdioServer } = await import('./host/stdio.ts')
      const profiles = new Map(HOST_MAPPINGS.map(h => [h.hostId, h]))
      const facade = createRuntimeFacade({ profiles })
      const gw = new HostGateway({ facade, audit: e => counters.onCount('car_registry_decision', { source: 'registry' }) })
      for (const h of HOST_MAPPINGS) gw.registerHost({ hostId: h.hostId, profile: h, transport: {} as never })
      const server = createStdioServer((tool, args) => gw.handle(hostId, tool, args))
      const n = await server.serve(process.stdin, process.stdout)
      // 采集窗口收口（登记表兜底通道）：快照写 stderr（stdout 为协议通道不可污染）
      const snap = counters.snapshot()
      console.error(`[car mcp-serve] host=${hostId} requests=${n} snapshot=${JSON.stringify(snap)} zeroContent=${assertZeroContent(snap)}`)
      return 0
    }
    case 'plugin-sign': {
      // 1.1-S1 插件签名工具（指南 §2 node -e 手工流固化）：keygen / sign / verify
      // 退出码沿用家规：0=成功，1=数据校验失败（签名/验签不通过），2=用法/输入不可用
      const [sub, ...sargs] = rest
      const parseFiles = (argv: string[], keyFlag?: string): { files: string[]; keyPath?: string; trustRoot?: string; error?: string } => {
        const files: string[] = []
        let keyPath: string | undefined
        let trustRoot: string | undefined
        for (let i = 0; i < argv.length; i++) {
          const a = argv[i]!
          if (keyFlag && a === keyFlag) {
            keyPath = argv[++i]
            if (!keyPath) return { files, error: `缺少 ${keyFlag} 路径` }
          } else if (a === '--trust-root') {
            trustRoot = argv[++i]
            if (!trustRoot) return { files, error: '缺少 --trust-root 值' }
          } else if (a.startsWith('--')) {
            return { files, error: `未知选项 ${a}` }
          } else files.push(a)
        }
        return { files, keyPath, trustRoot }
      }
      if (sub === 'keygen') {
        let prefix = 'car-release'
        let force = false
        for (let i = 0; i < sargs.length; i++) {
          const a = sargs[i]!
          if (a === '--out') { prefix = sargs[++i] ?? ''; if (!prefix) { console.error('缺少 --out 前缀'); return 2 } }
          else if (a === '--force') force = true
          else if (a.startsWith('--')) { console.error(`未知选项 ${a}`); return 2 }
          else { console.error(`多余位置参数 ${a}`); return 2 }
        }
        const privPath = `${prefix}.priv`
        const pubPath = `${prefix}.pub`
        if (!force && (existsSync(privPath) || existsSync(pubPath))) {
          console.error(`已存在 ${privPath} / ${pubPath}——拒绝覆盖（--force 显式覆盖）。注意：覆盖 ≠ 轮换，旧公钥仍在用请先按轮换流程处置`)
          return 2
        }
        const kp = generateSigningKeypair()
        writeFileSync(privPath, kp.privateKeyDer, { mode: 0o600 })
        writeFileSync(pubPath, kp.publicKeyBase64)
        console.log(`密钥对已生成（前缀 ${prefix}）：`)
        console.log(`  私钥 ${privPath}（PKCS8 DER；离线保管，不入仓库——secrets 红线）`)
        console.log(`  公钥 ${pubPath}（SPKI DER base64）`)
        console.log(`信任根（CAR_TRUST_ROOT 值，或 plugin-sign verify --trust-root）：`)
        console.log(kp.publicKeyBase64)
        return 0
      }
      if (sub === 'sign') {
        const p = parseFiles(sargs, '--key')
        if (p.error) { console.error(p.error); return 2 }
        if (!p.files.length) { console.error('缺少插件文件参数'); return 2 }
        const keyPath = p.keyPath ?? 'car-release.priv'
        let priv: Buffer
        try { priv = readFileSync(keyPath) } catch {
          console.error(`私钥不可读：${keyPath}（先 car plugin-sign keygen 生成，或 --key 指定路径）`)
          return 2
        }
        let failed = false
        for (const f of p.files) {
          try {
            const r = signPluginFile(f, priv)
            console.log(`signed ${r.file} fp:${r.manifestHash.slice(0, 12)} → ${r.sidecar}`)
          } catch (e) {
            console.error(`sign FAIL ${f} — ${(e as Error).message}`)
            failed = true
          }
        }
        return failed ? 1 : 0
      }
      if (sub === 'verify') {
        const p = parseFiles(sargs)
        if (p.error) { console.error(p.error); return 2 }
        if (!p.files.length) { console.error('缺少插件文件参数'); return 2 }
        // 信任根解析序（与指南 §4 对齐）：--trust-root > CAR_TRUST_ROOT env > ./car-release.pub
        const tr = resolveTrustRoot({ flag: p.trustRoot, env: process.env, pubFilePath: 'car-release.pub' })
        if (!tr.value) {
          console.error('无信任根：--trust-root / CAR_TRUST_ROOT / ./car-release.pub 均未提供（keygen 产出的 .pub 即信任根）')
          return 2
        }
        let failed = false
        for (const f of p.files) {
          // verify 语义固定 enforce：缺签与坏签同为 FAIL（验签命令不做 warn 放行）
          const g = verifyPluginFile(f, { mode: 'enforce', trustRootPublicKey: tr.value })
          if (g.allowed && !g.warning) console.log(`verify: PASS ${f} fp:${g.manifestHash?.slice(0, 12)}（信任根来源 ${tr.source}）`)
          else { console.error(`verify: FAIL ${f} — ${g.error ?? g.warning ?? 'rejected'}`); failed = true }
        }
        return failed ? 1 : 0
      }
      console.error('用法: car plugin-sign <keygen|sign|verify> [args]（--help 查看全部命令）')
      return 2
    }
    default:
      console.log(HELP)
      return cmd ? 2 : 0
  }
}

main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1) })
