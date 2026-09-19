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
 *   car doctor                          环境自检（Node 版本/沙箱/凭据/连通性）
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { probeCapabilities, SandboxExecutor } from './sandbox/sandbox.ts'
import { SessionLog, loadSessionLog, type SessionEvent } from './session/log.ts'
import { SessionFileStore } from './session/store.ts'
import { compressJsonlZstd, decodeLogBuffer, zstdAvailable } from './session/format.ts'
import { exportForensicsBundle, verifyBundle, type ExportMeta } from './session/export.ts'
import { runTurn } from './loop/stop.ts'
import { Context } from './kernel/context.ts'
import { mountPlugin } from './load/loader.ts'
import { doctorCredentials, doctorConnectivity } from './dx/doctor.ts'

const HELP = `用法: car <command> [args]
  run <plugin.ts>       装配并运行插件（快速上手流）
  reload <file|dir>     热重载插件并打印五阶段加载报告
  session verify <file>            哈希链完整性校验（撕裂尾显式报告）
  session replay <file>            会话回放（deriveMessages 投影）
  session export <file> --out <dir> [--zstd]
                                    取证包导出（断链中止；落盘读回重验，离线自证）
  session rebuild-index <root> [--db <path>]
                                    从 JSONL 重建 SQLite 会话索引（幂等）
  doctor                环境自检`

// 进程内热重载会话（ReloadManager 持有 epoch 与实例注册表；同进程连续 reload 语义完整）
let reloadMgrPromise: Promise<import('./load/report.ts').ReloadManager> | undefined
function getReloadManager() {
  reloadMgrPromise ??= import('./load/report.ts').then(m => new m.ReloadManager())
  return reloadMgrPromise
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv
  switch (cmd) {
    case 'run': {
      const file = rest[0]
      if (!file) { console.error('缺少插件文件参数'); return 2 }
      const t0 = Date.now()
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
      const { report, plugins } = await mgr.reload(target)
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
      const hostIdx = rest.indexOf('--host')
      const { HOST_MAPPINGS } = await import('./host/mappings.ts')
      // 默认宿主取映射表首项（数据驱动，静态架构断言红线：宿主标识只在 mappings 数据文件）
      const hostId = hostIdx >= 0 ? rest[hostIdx + 1] : HOST_MAPPINGS[0].hostId
      // 宿主白名单数据驱动（静态架构断言红线：宿主标识字符串只允许出现在 mappings 数据文件）
      if (!HOST_MAPPINGS.some(h => h.hostId === hostId)) {
        console.error(`未知宿主 "${hostId}"（可用：${HOST_MAPPINGS.map(h => h.hostId).join(' | ')}）`); return 2
      }
      const { HostGateway } = await import('./host/hostGateway.ts')
      const { createRuntimeFacade } = await import('./host/facade.ts')
      const { createStdioServer } = await import('./host/stdio.ts')
      const { createCounters, assertZeroContent } = await import('./telemetry/metrics.ts')
      const counters = createCounters()
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
    default:
      console.log(HELP)
      return cmd ? 2 : 0
  }
}

main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1) })
