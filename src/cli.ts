/**
 * CAR CLI（N2 DX 基线 / US-1 / §6.5 审计触点）
 *
 * 命令（语义化退出码：0=成功，1=失败，2=用法错误）：
 *   car run <plugin.ts> [--turns N]     快速上手流：装配插件 → 跑一轮对话 → 日志落盘 → 审计摘要
 *   car session verify <events.jsonl>   哈希链完整性校验（断链即告警，审计员入口）
 *   car session replay <events.jsonl>   deriveMessages 投影回放（不依赖模型状态）
 *   car doctor                          环境自检（Node 版本/沙箱能力探测）
 */
import { writeFileSync } from 'node:fs'
import { probeCapabilities, SandboxExecutor } from './sandbox/sandbox.ts'
import { SessionLog, loadSessionLog } from './session/log.ts'
import { runTurn } from './loop/stop.ts'
import { Context } from './kernel/context.ts'
import { mountPlugin } from './load/loader.ts'

const HELP = `用法: car <command> [args]
  run <plugin.ts>       装配并运行插件（快速上手流）
  session verify <file> 哈希链完整性校验
  session replay <file> 会话回放（deriveMessages 投影）
  doctor                环境自检`

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
      const hostTools: any[] = []
      ctx.plugin({ name: plugin.manifest.name, apply: (c) => {
        plugin.bindCore({
          registerTool: (t) => { hostTools.push(t); c.provide('tool:' + t.name, t) },
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
      // 环节 4：日志落盘
      const out = `session-${log.sessionId}.jsonl`
      writeFileSync(out, log.exportJSONL())
      console.log(`[4/5 落盘] ${out}（${log.events.length} 事件，哈希链 ${log.verifyChain() === null ? '完整' : '断链!'}）`)
      // 环节 5：审计回放
      const replay = log.deriveMessages()
      console.log(`[5/5 回放] ${replay.length} 条消息投影（Model-visible means logged: ${log.assertModelVisibleLogged().ok ? 'PASS' : 'FAIL'}）`)
      console.log(`首插件跑通总耗时：${((Date.now() - t0) / 1000).toFixed(1)}s（N2 目标 ≤300s）`)
      return 0
    }
    case 'doctor': {
      const probe = await probeCapabilities()
      console.log(`node: ${process.version}（要求 ≥22.19）`)
      console.log(`sandbox: ${probe.degraded ? `DEGRADED（${probe.reason}）` : 'Landlock+seccomp 就绪'}`)
      console.log(`盘加密提示: ${process.platform === 'win32' ? '建议启用 BitLocker' : '建议启用 LUKS/FileVault'}`)
      return 0
    }
    case 'session': {
      const [sub, file] = rest
      if (!file) { console.error('缺少文件参数'); return 2 }
      const { log, brokenAt } = loadSessionLog(file)
      if (sub === 'verify') {
        if (brokenAt !== null) { console.error(`断链 @ seq=${brokenAt}（审计中止）`); return 1 }
        console.log(`哈希链完整：${log.events.length} 事件`)
        return 0
      }
      if (sub === 'replay') {
        if (brokenAt !== null) { console.error(`断链 @ seq=${brokenAt}（拒绝回放带病日志）`); return 1 }
        for (const m of log.deriveMessages()) console.log(JSON.stringify(m))
        return 0
      }
      console.error(HELP); return 2
    }
    default:
      console.log(HELP)
      return cmd ? 2 : 0
  }
}

main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1) })
