/**
 * 1.6-S3 · jiti 载体（S38）：car.config.ts 经 jiti 自包含转译（D-24）
 *
 * 覆盖：
 *  - 非可擦除语法（enum）真载——1.5 D-22 原生类型剥离不可表达的 transform-only 形态，
 *    erasable-only 预检登记项随之出清（被取代）
 *  - strip-only spawn 差分（1.6-GO-5 生产调用点）：`--experimental-strip-types`（无 transform）
 *    下 enum 配置经 jiti 真载成功 + 原生 import 同文件失败（负控——证明语法确属非可擦除、
 *    jiti 是载体）；同进程实测首载时延（登记口径，无硬门禁，CI 宽上界防抖）
 *  - CLI 真路径：car run 于 enum 配置目录——配置经 jiti 装载生效（CAR-E-LLM-CONFIG 引导 =
 *    配置解析通过、模型未配；若配置载体失败应为 CAR-E-CONFIG）
 *  - s35 存量零改动全量回归 = 载体迁移验收线（interoptDefault 显式关：jiti 缺省 true 会把
 *    无 default 模块的 exports 整体当 default，「缺 default export」校验即失效）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { warmCarConfig, loadCarConfig } from '../src/load/config.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')
const SRC_CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'load', 'config.ts')

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s38-${name}-`))
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

test('S38: 非可擦除语法（enum）经 jiti 真载——D-22 原生类型剥离不可表达形态', async () => {
  await withTempDir('enum', async dir => {
    writeFileSync(join(dir, 'car.config.ts'), [
      `export enum LlmMode { full = 'full-model' }`,
      `export default { llm: { model: LlmMode.full } }`,
    ].join('\n'))
    await warmCarConfig({ cwd: dir })
    const r = loadCarConfig({ cwd: dir })
    assert.equal(r.error, undefined)
    assert.equal(r.config.llm?.model, 'full-model', 'enum 值经 jiti 转译进配置')
  })
})

test('S38: strip-only spawn 差分——原生 import enum 载体失败（负控）+ jiti 真载成功 + 首载时延实测', async () => {
  await withTempDir('strip', async dir => {
    const configPath = join(dir, 'car.config.ts')
    writeFileSync(configPath, [
      `export enum LlmMode { full = 'strip-model' }`,
      `export default { llm: { model: LlmMode.full } }`,
    ].join('\n'))
    // 夹具自身仅可擦除语法（strip-only 可载）；非可擦除只出现在被测配置里
    const fixture = join(dir, 'fixture.ts')
    writeFileSync(fixture, [
      `import { warmCarConfig, loadCarConfig } from ${JSON.stringify(pathToFileURL(SRC_CONFIG).href)}`,
      `import { pathToFileURL as toURL } from 'node:url'`,
      `const configPath = process.argv[2]!`,
      `let nativeError = ''`,
      `try { await import(toURL(configPath).href) } catch (e) { nativeError = String((e as Error).message) }`,
      `if (!nativeError) { console.log('NATIVE_UNEXPECTEDLY_OK'); process.exit(1) }`,
      `const t0 = performance.now()`,
      `await warmCarConfig({ explicitPath: configPath })`,
      `const elapsed = Math.round(performance.now() - t0)`,
      `const r = loadCarConfig({ explicitPath: configPath })`,
      `if (r.error) { console.log('JITI_FAIL ' + r.error); process.exit(1) }`,
      `console.log('OK model=' + r.config.llm?.model + ' firstLoadMs=' + elapsed + ' nativeRejected=' + nativeError.slice(0, 60).replace(/\\n/g, ' '))`,
    ].join('\n'))
    // --experimental-strip-types：仅类型剥离无转译（22.19+ 可用；enum 属 transform-only 形态）
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>(resolve => {
      const child = spawn(process.execPath, ['--experimental-strip-types', fixture, configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.on('exit', c => resolve({ code: c, stdout: out }))
    })
    assert.equal(code, 0, 'strip-only 环境下 jiti 真载 enum 配置')
    const m = /OK model=(\S+) firstLoadMs=(\d+) nativeRejected=(.+)/.exec(stdout.trim())!
    assert.equal(m[1], 'strip-model')
    assert.ok(m[2] !== undefined, '首载时延实测出值')
    console.log(`    [登记] car.config.ts jiti 首载时延（spawn 冷启，本机实跑）：${m[2]} ms`)
    assert.ok(Number(m[2]) < 15_000, '首载时延宽上界（CI 防抖；真实数值进收口报告）')
    assert.ok(m[3]!.length > 0, '负控：原生 import 对非可擦除语法显式失败——jiti 是载体而非原生剥离')
  })
})

test('S38: CLI 真路径——car run 于 enum 配置目录：配置经 jiti 装载生效（模型未配引导而非配置报错）', async () => {
  await withTempDir('cli', async dir => {
    writeFileSync(join(dir, 'car.config.ts'), [
      `export enum LlmMode { full = 'full-model' }`,
      `export default { llm: { model: LlmMode.full } }`,
    ].join('\n'))
    const plugin = join(dir, 'noop.ts')
    writeFileSync(plugin, [
      `export const manifest = { name: "s38p", version: "1.0.0" }`,
      `export default function apply(api) { api.registerTool({ name: "noop", declaredSideEffect: "readonly", run: async () => "ok" }) }`,
    ].join('\n'))
    const { code, output } = await new Promise<{ code: number | null; output: string }>(resolve => {
      const child = spawn(process.execPath, ['--experimental-transform-types', CLI, 'run', plugin], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { out += d })
      child.on('exit', c => resolve({ code: c, output: out }))
    })
    assert.equal(code, 2, 'D-13：无凭据/端点 → exit 2 显式引导')
    assert.match(output, /CAR-E-LLM-CONFIG/, '配置经 jiti 解析通过（enum 值进 llm.model）走到模型就绪检查')
    assert.doesNotMatch(output, /CAR-E-CONFIG/, '配置载体本身零错误')
  })
})
