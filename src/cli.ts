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
import { lookupSession, IndexUpdater, type SessionIndexRow } from './session/indexStore.ts'
import { runTurn } from './loop/stop.ts'
import { Context } from './kernel/context.ts'
import { mountPlugin } from './load/loader.ts'
import { verifyPluginFile } from './load/sigGate.ts'
import { loadCarConfig, mergeSignatureGate, mergeLlmConfig, warmCarConfig } from './load/config.ts'
import { generateSigningKeypair, signPluginFile, resolveTrustRoot } from './load/sign.ts'
import { doctorCredentials, doctorConnectivity, doctorKeychain, doctorSignature, doctorModelReadiness } from './dx/doctor.ts'
import { RuntimeCore, createOpenAICompatAdapter, createAnthropicAdapter } from './runtime-core/llm.ts'
import { CredentialService } from './runtime-core/credentials.ts'
import { chatStep } from './runtime-core/chatStep.ts'
import { toToolDefinitions } from './runtime-core/tools.ts'
import { createTelemetryFacade, telemetryConfigFromEnv } from './runtime-core/telemetry.ts'
import { TurnTracer, parseTraceparent, type TurnSpanHandle } from './runtime-core/trace.ts'
import type { CounterName, AllowedLabels } from './telemetry/metrics.ts'

const HELP = `用法: car <command> [args]
  run <plugin.ts> [--sig-enforce] [--config <path>] [--adapter-id <id>]
                                    装配并运行插件（快速上手流；装载前签名门 warn 缺省）
                                    真路径：--prompt <text> + --base-url/--model（或 llm.* 配置）；
                                    --adapter-id anthropic = Messages API（凭据 ANTHROPIC_API_KEY）；
                                    --demo = stub 演示流
  reload <file|dir> [--sig-enforce] [--config <path>]
                                    热重载插件并打印六阶段加载报告（含 verify 签名门）
  session verify <file>            哈希链完整性校验（撕裂尾显式报告）
  session replay <file>            会话回放（deriveMessages 投影）
  session export <file> --out <dir> [--zstd]
                                    取证包导出（断链中止；落盘读回重验，离线自证）
  session rebuild-index <root> [--db <path>]
                                    从 JSONL 重建 SQLite 会话索引（幂等）
  session verify/replay/export 均支持 --session <id> [--db <path>]
                                    经 SQLite 索引定位会话（1.2；缺省 db = cwd sessions-index.db；索引未收录 = 显式报错）
  doctor                环境自检
  mcp-serve [--host <id>] [--plugin <file|dir>...] [--config <path>]
                                    CAR-as-MCP-Server（宿主经 stdio JSON-RPC 接入）
  plugin-sign keygen [--out <前缀>] [--force]
                                    生成 ed25519 签名密钥对（<前缀>.priv PKCS8 DER / <前缀>.pub SPKI base64；缺省前缀 car-release）
  plugin-sign sign <file...> [--key <priv>]
                                    对插件文件签名，写 <file>.minisig sidecar（被签物 = 文件裸字节 sha256 hex；改动文件必须重签）
  plugin-sign verify <file...> [--trust-root <spki base64>]
                                    验证签名（信任根序：--trust-root > CAR_TRUST_ROOT > ./car-release.pub；缺签/坏签均 FAIL）
签名门环境变量：CAR_SIG_ENFORCE=1 切 enforce；CAR_TRUST_ROOT=<ed25519 spki base64>；
CAR_UNSIGNED_ALLOW=1 显式声明豁免（warn 缺签路径计数 confirmed=yes，横幅保留）
配置文件通道（1.5 起双载体）：cwd car.config.ts（export default {…}；发现序 ts > json）或
car.config.json 或 --config <path>；键位 sandbox.unsigned.allow / sandbox.sig.enforce /
sandbox.sig.trustRoot / llm.* / mcp.servers.*（stdio: command/args/env；远程: url/headers，
\${ENV_VAR} 引用注入凭据）；优先级 flag > env > 配置 > 缺省；未知键 fail-visible`

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
  // 1.5-S3（D-22）：car.config.ts 载体统一预热（--config *.ts 或 cwd 发现序 ts>json；无 TS 载体 = no-op）
  await warmCarConfig({ explicitPath: flagValue(rest, '--config') })
  switch (cmd) {
    case 'run': {
      // 1.4-S5（D-13）：缺省 = 真实模型路径（chatStep 经 openai-compat 适配器）；--demo 保留 stub 演示流。
      // 无模型配置 exit 2 显式报错引导（禁静默降级）。会话/索引/签名门两路径共用。
      const file = rest[0]
      if (!file) { console.error('缺少插件文件参数'); return 2 }
      const isDemo = rest.includes('--demo')
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
      // 1.2-S2 W3-2「更新半边」：append 后按行增量入索引（sink 先于事件入内存——行自带 seq/hash；
      // 失败非致命——索引为派生缓存，rebuild-index 兜底语义不变；SQLite 能力缺席 = 显式登记一次后停用）
      const indexUpdater = new IndexUpdater({ dbPath: join(process.cwd(), 'sessions-index.db'), onError: e => console.error(`[index-updater] ${e.message}`) })
      log.attachSink(line => { store.append(line); indexUpdater.record(log.sessionId, line, store.path) })
      // 1.4-S5：插件工具收集（ToolReg 全量进 Map——执行面与声明面同一对象，声明面=授权面红线）；
      // setSystemPrompt 收集（last-wins，D-17）
      const hostTools: any[] = []
      let pluginSystemPrompt: string | null = null
      ctx.plugin({ name: plugin.manifest.name, apply: (c) => {
        plugin.bindCore({
          registerTool: (t) => { hostTools.push(t); c.provide('tool:' + t.name, t) },
          getRegisteredTools: () => hostTools,
          setSystemPrompt: (text) => { pluginSystemPrompt = text },
        })
        if (isDemo) {
          // --demo 演示流专属脚手架（真路径不注入——1.1 规划登记的 demo_tool 撞名边缘就此出清）
          plugin.api.registerTool({
            name: 'demo_tool', run: async () => 'demo-ok',
          })
        }
      } })
      console.log(`[1/5 装配] OK（${Date.now() - t0}ms，工具: ${hostTools.map(t => t.name).join(', ') || '无'}）`)
      // 环节 2-3：沙箱探测 + 事件运行 + 停止收口
      const probe = await probeCapabilities()
      const sandbox = new SandboxExecutor({ probe, audit: () => {}, workspace: process.cwd() })
      console.log(`[2/5 沙箱] ${probe.degraded ? `降级（${probe.reason}）——Q-04 约束生效` : 'Landlock 就绪'}`)
      // 工具执行面 Map（T-22 收口：declaredSideEffect 缺省 write）
      const toolsMap = new Map<string, any>(hostTools.map(t => [t.name, {
        declaredSideEffect: t.declaredSideEffect ?? 'write',
        run: t.run,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      }]))
      // 取消信号（SIGINT → 中断在途流；runTurn 既有收口落 turnEnd aborted）
      const signal = { aborted: false }
      const onSigint = () => { signal.aborted = true; console.error('\n[取消] SIGINT——正在中断当前 turn…') }
      process.once('SIGINT', onSigint)
      // 1.4-S6：遥测门面（CAR_OTEL_ENDPOINT env 通道；缺省关 = noop 零出站）——turn/step span 挂装配层
      const otel = createTelemetryFacade(telemetryConfigFromEnv())
      const tracer = new TurnTracer(otel)
      let r: Awaited<ReturnType<typeof runTurn>>
      if (isDemo) {
        // --demo：stub 演示流（无模型可跑——五环节叙事与既有测试/CI 承载）
        log.append('user', 'user', 'T0', '请调用 demo_tool 并汇报')
        r = await runTurn({
          log, turnId: 'T0',
          preset: { mode: 'confirm', authorize: async () => { console.log('[授权] 确认模式：放行 demo_tool'); return true } },
          tools: new Map([['demo_tool', { declaredSideEffect: 'write', run: async () => 'demo-ok' } as any]]),
          model: async () => ({ stopReason: 'toolUse' as const, toolCalls: [{ id: 'c1', tool: 'demo_tool', args: {} }] }),
        })
      } else {
        // 真路径：模型配置解析（D-16 优先级 flag > env > config）+ 装配 RuntimeCore
        const cfgLlm = loadCarConfig({ explicitPath: flagValue(rest, '--config') })
        if (cfgLlm.error) { console.error(cfgLlm.error); return 2 }
        const mtFlag = flagValue(rest, '--max-tokens')
        const llm = mergeLlmConfig(process.env, cfgLlm.config, {
          baseUrl: flagValue(rest, '--base-url'),
          model: flagValue(rest, '--model'),
          adapterId: flagValue(rest, '--adapter-id'),
          ...(mtFlag !== undefined ? { maxTokens: Number(mtFlag) } : {}),
        })
        const prompt = flagValue(rest, '--prompt')
        if (!llm.baseUrl || !llm.model || prompt === undefined) {
          console.error('CAR-E-LLM-CONFIG: 真实模型路径需要 baseUrl + model + --prompt——')
          console.error('  配置：car.config.ts（export default）或 car.config.json {"llm":{"baseUrl":"https://…","model":"…"}} / env CAR_LLM_BASE_URL+CAR_LLM_MODEL / flag --base-url --model --prompt')
          console.error('  anthropic：llm.adapterId "anthropic"（或 --adapter-id anthropic）+ baseUrl https://api.anthropic.com；凭据 ANTHROPIC_API_KEY')
          console.error('  凭据：OPENAI_API_KEY / ANTHROPIC_API_KEY（env fallback 需 CAR_ALLOW_ENV_CREDENTIALS=1 或 llm.allowEnvFallback）或 keychain；诊断：car doctor')
          console.error('  （无模型演示流：--demo）')
          return 2
        }
        const modelName = llm.model
        const credService = new CredentialService()
        const core = new RuntimeCore(credService)
        core.bindContext(ctx)
        // 适配器经根作用域 effect 可逆注册（bindContext 必须先于 register——否则走非可逆直注册分支）；
        // 1.5-S1（D-20）：adapterId='anthropic' → anthropic 适配器（Messages API）；缺省 openai-compat 不变
        core.registerLlmAdapter(llm.adapterId === 'anthropic'
          ? createAnthropicAdapter({ baseUrl: llm.baseUrl, credentials: credService, provider: 'anthropic' })
          : createOpenAICompatAdapter({
              baseUrl: llm.baseUrl,
              credentials: credService,
              provider: 'openai-compat',
            }), { default: true })
        // MCP 工具进 turn（D-18）：--mcp <serverId>（可重复；server 启动规格在 car.config.json mcp.servers 登记）
        const mcpIds: string[] = []
        // 1.8-D29：活跃 turn span 句柄（startTurn 后赋值——MCP 工具闭包运行期取 client span 挂链面）
        let activeTurn: TurnSpanHandle | null = null
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--mcp') {
            const id = rest[++i]
            if (!id) { console.error('缺少 --mcp serverId'); return 2 }
            mcpIds.push(id)
          }
        }
        const mcpTransports: import('./mcp/gateway.ts').ClientTransport[] = []
        if (mcpIds.length) {
          const { McpGateway } = await import('./mcp/gateway.ts')
          const { createStdioClientTransport } = await import('./mcp/stdioClient.ts')
          const { createHttpMcpTransport, resolveMcpHeaders } = await import('./mcp/httpClient.ts')
          const gw = new McpGateway()
          for (const id of mcpIds) {
            const spec = cfgLlm.config.mcp?.servers?.[id]
            if (!spec) { console.error(`CAR-E-MCP: server "${id}" 未在配置 mcp.servers 登记`); return 2 }
            // 1.5-S2（D-21）：url = 远程 Streamable HTTP（懒 initialize + 会话头）；command = stdio 本地进程
            const transport = spec.url
              ? createHttpMcpTransport({ url: spec.url, headers: resolveMcpHeaders(spec.headers ?? {}) })
              : createStdioClientTransport({ command: spec.command!, args: spec.args })
            mcpTransports.push(transport)
            const mcpTools = await gw.register({ serverId: id, transport, env: spec.env })
            for (const t of mcpTools) {
              const modelName = `mcp_${id}_${t.name}`
              if (toolsMap.has(modelName)) { console.error(`CAR-E-MCP: 工具名冲突 ${modelName}（跨源同名禁静默覆盖）`); return 1 }
              toolsMap.set(modelName, {
                declaredSideEffect: t.declaredSideEffect ?? 'write',
                // 1.8-D29：client span（car.mcp.tool 挂 turn）+ traceparent 注入 _meta——
                // noop 门面 traceparent='' → 不注入（线上 JSON-RPC 字节面不变）
                run: async (args: any) => {
                  const span = activeTurn?.mcpToolSpan(id, t.name)
                  const tp = span?.traceparent ?? ''
                  try {
                    const r = await gw.callTool(id, t.name, args, tp ? { traceparent: tp } : {})
                    if (!r.ok) throw new Error(r.error ?? 'mcp call failed')
                    span?.end('ok')
                    return r.result
                  } catch (e) {
                    span?.recordException(e)
                    span?.end('error')
                    throw e
                  }
                },
                ...(t.description !== undefined ? { description: t.description } : {}),
                ...(t.inputSchema !== undefined ? { parameters: t.inputSchema } : {}),
              })
            }
            console.log(`[MCP] ${id}: ${mcpTools.length} 工具入声明面`)
          }
        }
        // PTC 进真实 turn（--ptc）：插件工具 Map 即 ToolBridge（声明面=授权面同源快照）；
        // run_code 进工具 Map（强制 write）；SDK 声明块独立 system 事件（D-17）
        let sdkBlock: string | null = null
        if (rest.includes('--ptc')) {
          const { makePtcToolDefinition, runCode } = await import('./ptc/runCode.ts')
          void runCode
          const { renderSdkFromRegistry } = await import('./ptc/sdk.ts')
          const registry = new Map([...toolsMap].map(([name, t]) => [name, { run: t.run, description: t.description, inputSchema: t.parameters }]))
          sdkBlock = renderSdkFromRegistry(registry)
          const ptc = makePtcToolDefinition({ tools: registry, audit: () => {}, spanBridge: () => activeTurn?.ptcRelay() ?? null })
          toolsMap.set(ptc.name, ptc)
          console.log(`[PTC] run_code 入工具面（桥接 ${registry.size} 工具；SDK 声明块进 system）`)
        }
        // system prompt 落链（D-17）：--system flag > 插件 setSystemPrompt（last-wins）；SDK 块独立追加
        const systemText = flagValue(rest, '--system') ?? pluginSystemPrompt
        if (systemText) log.append('runtime', 'system', 'system', systemText)
        if (sdkBlock) log.append('runtime', 'system', 'system', sdkBlock)
        log.append('user', 'user', 'T0', prompt)
        const turn = tracer.startTurn('T0')
        activeTurn = turn // 1.8-D29/D-31：MCP 工具闭包 / PTC spanBridge 运行期取挂链面
        let stepNo = 0
        r = await runTurn({
          log, turnId: 'T0',
          preset: { mode: 'confirm', authorize: async (call) => { console.log(`[授权] 确认模式：放行 ${call.tool}`); return true } },
          tools: toolsMap,
          signal,
          model: () => {
            // 1.4-S6：step span 挂每次 model() 调用（parent = turn span；同 turn 共享 traceId）
            const step = turn.stepSpan(++stepNo)
            return chatStep({
              core, log, turnId: 'T0',
              model: modelName,
              tools: toToolDefinitions(toolsMap),
              ...(llm.maxTokens !== undefined ? { maxTokens: llm.maxTokens } : {}),
              ...(llm.adapterId ? { adapterId: llm.adapterId } : {}),
              signal,
            }).then(
              res => { step.end(res.stopReason); return res },
              e => { step.recordException(e); step.end('error'); throw e },
            )
          },
        })
        turn.end(r.reason)
      }
      process.removeListener('SIGINT', onSigint)
      console.log(`[3/5 收口] turnEnd=${r.reason}（steps=${r.steps}）`)
      // 1.4-S6：遥测收口 flush（显式开路径；缺省关 = 空转）
      if (otel.enabled) {
        await otel.shutdown()
        console.error(`[otel] stats=${JSON.stringify(otel.stats())}`)
      }
      // 环节 4：落盘收口（全程逐事件 fsync 已发生，此处仅关句柄核对 + 索引 pending 落盘）
      store.close()
      await indexUpdater.close()
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
      // 1.4-S3 增强：模型就绪行（baseUrl/model / 凭据通道 / envFallback；值不打印）
      const mr = doctorModelReadiness({ cwd: process.cwd(), configPath: flagValue(rest, '--config') })
      console.log(`model: ${mr.detail}`)
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
        else if (a === '--out' || a === '--db' || a === '--session') flags[a.slice(2)] = args[++i] ?? ''
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
      // 1.2-S1 W3-1：--session <id> 经索引定位会话文件（与位置路径互斥，显式拒绝歧义）。
      // db 缺省取 cwd sessions-index.db（缺文件 = CAR-E-INDEX 显式报错提示 rebuild-index）；
      // 索引未收录 = 显式报错（「可索引 = 可验证」：断链/坏格式会话不入索引）。
      const sessionFlag = flags.session as string | undefined
      let file = positional[0]
      if (sessionFlag) {
        if (file) { console.error('文件路径与 --session 互斥——请二选一'); return 2 }
        const dbPath = (flags.db as string) || join(process.cwd(), 'sessions-index.db')
        let row: SessionIndexRow | null
        try { row = await lookupSession(dbPath, sessionFlag) } catch (e) { console.error((e as Error).message); return 2 }
        if (!row) { console.error(`会话 "${sessionFlag}" 未收录索引（可索引 = 可验证；断链/坏格式会话不入索引）——可先 car session rebuild-index`); return 2 }
        file = row.file
        console.log(`[index] ${sessionFlag} → ${file}（events=${row.eventCount} encoding=${row.encoding}）`)
      }
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
      // 1.6-S2（D-25）宿主工具面透传接线：插件工具 Map 注入 RuntimeFacade——tool_list 出声明面
      // （declaredSideEffect 不出站：权限面只进权限门红线）、tool_call 经权限门（write 类 policy
      // 拒绝/readonly 执行）+ 成对落链；跨源同名 CAR-E-DUP fail-closed（1.4-S1 纪律同款）。
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
      // 1.2-S3 W3-3：OTel 门面经 env 通道（CAR_OTEL_ENDPOINT 唯一开关；缺省关 = noop 零出站）+
      // S17 counters **双写桥**——快照面（登记表兜底通道）不变，meter 出站为加法通道；
      // labels 为零内容枚举（metrics.ts AllowedLabels），出站同口径
      const otel = createTelemetryFacade(telemetryConfigFromEnv())
      const counters = createCounters()
      const onCount = (name: CounterName, labels?: AllowedLabels): void => {
        counters.onCount(name, labels)
        if (otel.enabled) otel.getMeter().createCounter(name).add(1, labels as Record<string, string> | undefined)
      }
      // 1.6-S2：hostTools 提升到块外——跨源同名查重与 toolMap 装配在装载块之后统一收口
      const hostTools: Array<{ name: string; description?: string; parameters?: unknown; declaredSideEffect?: 'readonly' | 'write'; run: (args: Record<string, unknown>) => Promise<unknown> }> = []
      if (pluginsArg.sources.length) {
        const { loadPlugins, formatLoadReport } = await import('./load/report.ts')
        const { Context } = await import('./kernel/context.ts')
        const ctx = new Context()
        for (const src of pluginsArg.sources) {
          const result = await loadPlugins({ source: src, signature: { ...sig.options, onCount: (n, l) => onCount(n, l) } })
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
          console.error(`[car mcp-serve] plugins loaded: ${names}（tools: ${hostTools.map(t => t.name).join(', ') || '无'}；装载+工具面透传已接线——1.6-S2）`)
        }
      }
      const { HostGateway } = await import('./host/hostGateway.ts')
      const { createRuntimeFacade } = await import('./host/facade.ts')
      const { createStdioServer } = await import('./host/stdio.ts')
      const profiles = new Map(HOST_MAPPINGS.map(h => [h.hostId, h]))
      // 1.6-S2：跨源同名显式报错（禁静默覆盖——last-wins Map 语义下同名即歧义，fail-closed 启动中止）
      const dupTool = hostTools.find((t, i) => hostTools.findIndex(x => x.name === t.name) !== i)
      if (dupTool) { console.error(`CAR-E-DUP: 工具 "${dupTool.name}" 跨源同名——禁静默覆盖（mcp-serve fail-closed 启动中止）`); return 1 }
      const toolMap = new Map(hostTools.map(t => [t.name as string, t]))
      const facade = createRuntimeFacade({ profiles, ...(toolMap.size ? { tools: toolMap } : {}) })
      const gw = new HostGateway({ facade, audit: e => onCount('car_registry_decision', { source: 'registry' }) })
      for (const h of HOST_MAPPINGS) gw.registerHost({ hostId: h.hostId, profile: h, transport: {} as never })
      // 1.7-S3（D-28）：sessionTurn 挂 turn 级 span（无 step span——mcp-serve 无 model() 循环）。
      // 挂点在装配层（1.4-S6 纪律同款）；facade 内部自增派生 turnId（T{n}）——调用前不可知，
      // 经 setTurnId 回填；outcome = 归一化 turnEnd reason（枚举面零内容）。缺省关 = noop 句柄零出站。
      const tracer = new TurnTracer(otel)
      const server = createStdioServer(async (tool, args, meta) => {
        if (tool !== 'session_turn') return gw.handle(hostId, tool, args)
        // 1.8-D30：远端挂链——_meta.traceparent 合法 → turn span 加入宿主 trace
        // （traceId 复用 + parentSpanId=远端 spanId；畸形 fail-open 新 trace——遥测禁 fail-hard）
        const parent = otel.enabled && meta?.traceparent ? parseTraceparent(meta.traceparent) : null
        const turn = parent
          ? tracer.startTurn('', { trace: { traceId: parent.traceId, parentSpanId: parent.parentSpanId } })
          : tracer.startTurn('')
        try {
          const r = await gw.handle(hostId, tool, args)
          if (!r.ok) {
            // handle 层吞错为 {ok:false}（显式错误结果不抛出）——span 面以 error 收口留痕
            turn.recordException(new Error(r.error ?? 'host call failed'))
            turn.end('error')
            return r
          }
          const payload = (r.result ?? {}) as { reason?: string; steps?: number }
          turn.setTurnId(`T${payload.steps ?? 0}`)
          turn.end(String(payload.reason ?? 'completed'))
          return r
        } catch (e) {
          turn.recordException(e)
          turn.end('error')
          throw e
        }
      })
      const n = await server.serve(process.stdin, process.stdout)
      // 采集窗口收口（登记表兜底通道）：快照写 stderr（stdout 为协议通道不可污染）
      const snap = counters.snapshot()
      console.error(`[car mcp-serve] host=${hostId} requests=${n} snapshot=${JSON.stringify(snap)} zeroContent=${assertZeroContent(snap)}`)
      // 1.2-S3：OTel 显式开路径收口 flush（shutdown = flush + 停 interval；缺省关为空转）
      if (otel.enabled) {
        await otel.shutdown()
        console.error(`[car mcp-serve] otel=enabled stats=${JSON.stringify(otel.stats())}`)
      }
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
