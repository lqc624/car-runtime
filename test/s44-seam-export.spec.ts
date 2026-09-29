/**
 * s44 · KernelSeam 导出面测试（1.10.0 加法）
 *
 * 断言：①src/seam.ts 符号面完整（20 符号）；②dist 构建产物在库根存在时（CI j01 build 后/本地 build），
 * dist/seam.js 可独立装载且符号一致 + SessionLog 可用（平台层消费形态 = node_modules 内纯 JS，无 type-stripping 依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEAM_SYMBOLS = [
  'SessionLog', 'SessionFileStore', 'runTurn', 'chatStep',
  'RuntimeCore', 'createOpenAICompatAdapter', 'createAnthropicAdapter', 'CredentialService',
  'mountPlugin', 'Context', 'loadCarConfig', 'mergeLlmConfig', 'mergeSignatureGate', 'warmCarConfig',
  'probeCapabilities', 'SandboxExecutor', 'createTelemetryFacade', 'telemetryConfigFromEnv', 'TurnTracer',
] as const

test('src/seam.ts 导出面完整（19 符号）', async () => {
  const seam = await import('../src/seam.ts')
  const missing = SEAM_SYMBOLS.filter((n) => (seam as Record<string, unknown>)[n] === undefined)
  assert.deepEqual(missing, [], `缺符号: ${missing.join(',')}`)
})

test('dist/seam.js（构建产物）：可独立装载 + 符号一致 + SessionLog 冒烟', { skip: !existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'seam.js')) ? 'dist 未构建（npm run build 后有效——CI j01/发布链承载）' : false }, async () => {
  const dist = await import('../dist/seam.js')
  const missing = SEAM_SYMBOLS.filter((n) => (dist as Record<string, unknown>)[n] === undefined)
  assert.deepEqual(missing, [], `dist 缺符号: ${missing.join(',')}`)
  const log = new dist.SessionLog('s44-dist-probe')
  const e = log.append('user', 'user', 'T0', { text: 'hi' })
  assert.equal(e.seq, 0)
  assert.equal(e.hash.length, 64)
  // 纯 JS 产物：node_modules 内可装载（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING 规避面）
  const src = await import('../src/seam.ts')
  for (const n of SEAM_SYMBOLS) assert.equal(typeof (dist as Record<string, unknown>)[n], typeof (src as Record<string, unknown>)[n], `符号类型漂移: ${n}`)
})
