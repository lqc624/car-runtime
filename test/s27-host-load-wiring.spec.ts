/**
 * 1.1-S4 · mcp-serve 装载接线（宿主路径签名门 + car_load_total 全链采集）
 *
 * 覆盖（1.1-迭代规划 W2-4）：
 *  - --plugin 装载经六阶段流水线（verify 门先于 import()）：warn 缺签横幅放行 + 计数全链进 stderr 快照
 *  - enforce 缺签：verify FAIL → fail-closed 启动中止 exit 1（DEC-1 语义在宿主路径同权）
 *  - 装载失败不静默（warn 模式亦 fail-closed——加载期显式失败红线；CAR_PLUGINS env 通道）
 *  - 配置通道真实消费：cwd car.config.json 提供信任根 → 好签名静默装载、快照零签名计数
 *
 * 边界（防口径外推）：本 spec 断言的是「装载接线 + 采集全链」——插件 factory 执行 + bindCore
 * 冲刷注册项真实发生；sessionTurn 仍为事件批归一化（宿主会话执行插件工具属 W1 登记后续）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSigningKeypair, signPluginFile } from '../src/load/sign.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

function makePlugin(dir: string, file: string, tool: string, manifest = { name: 'p', version: '1.0.0' }): string {
  const p = join(dir, file)
  writeFileSync(p, `export const manifest = ${JSON.stringify(manifest)}\nexport default function apply(api) {\n  api.registerTool({ name: '${tool}', run: async () => 'ok' })\n}\n`)
  return p
}

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s27-${name}-`))
  try {
    const r = fn(dir)
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } }
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
    return Promise.resolve()
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ }
    throw e
  }
}

/** spawn mcp-serve 真实子进程（s18 talk 同口径，cwd/env 可注入） */
function serve(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; requests?: string[] } = {}): Promise<{ code: number; outs: any[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'mcp-serve', ...args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('exit', code => {
      try { resolve({ code: code ?? -1, outs: out.split('\n').filter(Boolean).map(l => JSON.parse(l)), stderr: err }) } catch (e) { reject(e) }
    })
    for (const r of opts.requests ?? [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_start', arguments: { hostSessionId: 's27' } } }),
    ]) child.stdin.write(r + '\n')
    child.stdin.end()
  })
}

function snapshotOf(stderr: string): Record<string, number> {
  return JSON.parse(/snapshot=(\{.*?\}) zeroContent/.exec(stderr)![1])
}

test('S27: --plugin 装载接线——warn 缺签横幅 + 工厂执行/bindCore 冲刷真实发生 + 计数全链进快照', async () => {
  await withTempDir('wired-warn', async dir => {
    makePlugin(dir, 'p.ts', 't')
    const r = await serve(['--plugin', dir], { cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    // 协议面不变：宿主 10-tool 冻结（s11 口径）
    assert.equal(r.outs[0].result.tools.length, 10)
    // 装载真实发生：factory 执行 + bindCore 冲刷注册项（非「门过了但插件丢弃」的假接线）
    assert.match(r.stderr, /plugins loaded: p@1\.0\.0/)
    assert.match(r.stderr, /tools: t/)
    // warn 缺签横幅显式可见
    assert.match(r.stderr, /CAR-W-SIG/)
    // 计数全链：loadPlugins 内生产 → counters → 会话收口 stderr 快照（宿主路径与 CLI 路径同权）
    const snap = snapshotOf(r.stderr)
    assert.equal(snap['car_load_total|result=ok'], 1)
    assert.equal(snap['car_unsigned_confirmed|confirmed=no'], 1)
    assert.match(r.stderr, /zeroContent=true/)
  })
})

test('S27: enforce 缺签——verify FAIL fail-closed 启动中止 exit 1（DEC-1 宿主路径同权）', async () => {
  await withTempDir('wired-enforce', async dir => {
    makePlugin(dir, 'p.ts', 't')
    const r = await serve(['--plugin', dir, '--sig-enforce'], { cwd: dir })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /\[verify\s*\] FAIL/)
    assert.match(r.stderr, /CAR-E-SIG: signature missing/)
    assert.match(r.stderr, /fail-closed 启动中止/)
    assert.equal(r.outs.length, 0, '协议通道零输出（未进入服务循环）')
  })
})

test('S27: 装载失败不静默——warn 模式下 parse FAIL 亦 fail-closed exit 1（CAR_PLUGINS env 通道）', async () => {
  await withTempDir('wired-parse-fail', async dir => {
    makePlugin(dir, 'bad.ts', 't', { version: '1.0.0' }) // manifest 缺 name → parse FAIL
    const r = await serve([], { cwd: dir, env: { CAR_PLUGINS: dir } })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /\[parse\s*\] FAIL/)
    assert.match(r.stderr, /CAR-E-MANIFEST/)
    assert.match(r.stderr, /fail-closed 启动中止/)
  })
})

test('S27: 配置通道真实消费——cwd car.config.json 信任根 + 好签名 → 静默装载、快照零签名计数', async () => {
  await withTempDir('wired-config-trust', async dir => {
    const kp = generateSigningKeypair()
    const f = makePlugin(dir, 'p.ts', 't')
    signPluginFile(f, kp.privateKeyDer)
    // 信任根经配置文件通道（非 env）——cwd 发现序的真实消费点（1.1-GO-5）
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({ sandbox: { sig: { trustRoot: kp.publicKeyBase64 } } }))
    const r = await serve(['--plugin', dir], { cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.outs[0].result.tools.length, 10)
    assert.match(r.stderr, /plugins loaded: p@1\.0\.0/)
    // 好签名：零签名横幅、零签名计数（S28 口径），load_total 正常
    assert.equal(/CAR-W-SIG/.test(r.stderr), false)
    const snap = snapshotOf(r.stderr)
    assert.equal(snap['car_load_total|result=ok'], 1)
    assert.equal('car_unsigned_confirmed|confirmed=no' in snap, false)
    assert.equal('car_unsigned_confirmed|confirmed=yes' in snap, false)
    assert.match(r.stderr, /zeroContent=true/)
  })
})
