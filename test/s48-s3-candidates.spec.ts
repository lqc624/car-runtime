/**
 * s48 · 1.13.0 加法批行为证明（桌面 S3 治理面前置——S3 迭代规划 D-S3-1 / 文件安全设计 §7 / 安全中心设计 K-SC-1）
 *
 * 八候选逐项：
 *  - K-FS-1 runTurn preset.authorizeAll：缺省 false 零行为变化（readonly 类 bypass 不变）；
 *    confirm + authorizeAll=true → readonly 类同门（approve 放行 / deny authorization-denied）；
 *    readonly 模式契约不变（写类一律拒、只读类照常放行不弹 authorize）；full 整体旁路。
 *  - K-FS-2 AuthzService.decideByRule：policy 双向直判 + reason 保真落链 + 同 id 幂等。
 *  - K-FS-3 Capability 加法 'fs-read'|'fs-delete'：fs-delete 归写类（readonly 模式拒）、fs-read 只读类；
 *    K-SC-1 SandboxExecutor.exec authorizeAll：缺省零变化 / confirm+authorizeAll → 只读 argv 同门。
 *  - K-S3-1/2 loadSessionLog + fromEvents（恢复面零登记确认——M5 DEC-4 已在产）：载入→verifyChain 完整 →
 *    续 append 链不分叉（seq 连续 + prevHash 接原尾 + 导出字节前缀一致）→ 断链注入 brokenAt 定位。
 *  - K-S3-3 exportForensicsBundle/verifyBundle：seam 消费形态冒烟（断链即中止 + 读回重验）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog, loadSessionLog } from '../src/session/log.ts'
import { exportForensicsBundle, verifyBundle } from '../src/session/export.ts'
import { runTurn, type ModelStep, type ToolDef, type ToolCall } from '../src/loop/stop.ts'
import { AuthzService } from '../src/authz/authz.ts'
import { SandboxExecutor, type SandboxAuditSink } from '../src/sandbox/sandbox.ts'

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s48-${name}-`))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8 */ } })
}

// ==================== K-FS-1：runTurn preset.authorizeAll ====================

function readonlyTool(): ToolDef {
  return { declaredSideEffect: 'readonly', run: async () => ({ ok: true }) }
}
function writeTool(): ToolDef {
  return { declaredSideEffect: 'write', run: async () => ({ ok: true }) }
}
function oneCallModel(tool: string): { model: () => Promise<ModelStep>; calls: ToolCall[] } {
  const calls: ToolCall[] = [{ id: 'c1', tool, args: {} }]
  let step = 0
  return {
    calls,
    model: async () => {
      if (step === 0) { step++; return { stopReason: 'toolUse', toolCalls: [calls[0]] } }
      return { stopReason: 'stop' }
    },
  }
}
const toolResults = (log: SessionLog) => log.events.filter(e => e.kind === 'toolResult') as Array<{ seq: number; payload: Record<string, unknown> }>

test('K-FS-1: 缺省（authorizeAll 缺省）零行为变化——confirm 下 readonly 类 bypass 不进 authorize', async () => {
  const log = new SessionLog('s48-fs1-default')
  let authorizeCalls = 0
  const { model } = oneCallModel('fs_read')
  const r = await runTurn({
    log, turnId: 'T1', model,
    tools: new Map([['fs_read', readonlyTool()]]),
    preset: { mode: 'confirm', authorize: async () => { authorizeCalls++; return true } },
  })
  assert.equal(r.reason, 'completed')
  assert.equal(authorizeCalls, 0, 'readonly 类不进门（既有行为）')
  const results = toolResults(log)
  assert.equal(results.length, 1, '仅执行结果一条 toolResult（无 authorization-denied 中间记录）')
  assert.equal(results[0].payload.error, undefined)
})

test('K-FS-1: confirm + authorizeAll=true → readonly 类同门（approve 放行）', async () => {
  const log = new SessionLog('s48-fs1-approve')
  let authorizeCalls = 0
  const { model } = oneCallModel('fs_read')
  const r = await runTurn({
    log, turnId: 'T1', model,
    tools: new Map([['fs_read', readonlyTool()]]),
    preset: { mode: 'confirm', authorizeAll: true, authorize: async () => { authorizeCalls++; return true } },
  })
  assert.equal(r.reason, 'completed')
  assert.equal(authorizeCalls, 1, 'readonly 类进门（规则轴读取面可达）')
  const results = toolResults(log)
  assert.equal(results.length, 2, '先 authorization-denied 记录（granted=true）后执行结果——内核留痕形态不变')
  assert.equal(results[0].payload.error, 'authorization-denied')
  assert.equal(results[0].payload.granted, true)
  assert.equal(results[1].payload.error, undefined)
})

test('K-FS-1: confirm + authorizeAll=true → readonly 类 deny → authorization-denied 不执行', async () => {
  const log = new SessionLog('s48-fs1-deny')
  const { model } = oneCallModel('fs_read')
  const r = await runTurn({
    log, turnId: 'T1', model,
    tools: new Map([['fs_read', readonlyTool()]]),
    preset: { mode: 'confirm', authorizeAll: true, authorize: async () => false },
  })
  assert.equal(r.reason, 'completed', 'deny 非收口（模型继续调整——F13 blockOnDeny 才收口）')
  const results = toolResults(log)
  assert.equal(results.length, 1)
  assert.equal(results[0].payload.error, 'authorization-denied')
  assert.equal(results[0].payload.granted, false)
})

test('K-FS-1: readonly 模式契约不变——authorizeAll=true 下写类一律拒、只读类照常放行不弹 authorize', async () => {
  const log = new SessionLog('s48-fs1-ro')
  let authorizeCalls = 0
  const authorize = async (): Promise<boolean> => { authorizeCalls++; return true }
  const { model: mRead } = oneCallModel('fs_read')
  await runTurn({
    log, turnId: 'T1', model: mRead,
    tools: new Map([['fs_read', readonlyTool()]]),
    preset: { mode: 'readonly', authorizeAll: true, authorize },
  })
  const { model: mWrite } = oneCallModel('fs_write')
  await runTurn({
    log, turnId: 'T2', model: mWrite,
    tools: new Map([['fs_write', writeTool()]]),
    preset: { mode: 'readonly', authorizeAll: true, authorize },
  })
  assert.equal(authorizeCalls, 0, 'readonly 模式零 authorize 调用（契约不变）')
  const all = toolResults(log)
  assert.equal(all.length, 2)
  assert.equal(all[0].payload.error, undefined, '只读类放行执行')
  assert.equal(all[1].payload.granted, false, '写类一律拒')
})

test('K-FS-1: full 模式整体旁路（authorizeAll=true 亦不进门）', async () => {
  const log = new SessionLog('s48-fs1-full')
  let authorizeCalls = 0
  const { model } = oneCallModel('fs_read')
  await runTurn({
    log, turnId: 'T1', model,
    tools: new Map([['fs_read', readonlyTool()]]),
    preset: { mode: 'full', authorizeAll: true, authorize: async () => { authorizeCalls++; return true } },
  })
  assert.equal(authorizeCalls, 0)
  assert.equal(toolResults(log).length, 1)
})

// ==================== K-FS-2：AuthzService.decideByRule ====================

test('K-FS-2: decideByRule 双向直判——reason 保真落链 + 同 authorizationId 幂等', () => {
  withTempDir('fs2', (dir) => {
    const file = join(dir, 'session-s48-fs2.jsonl')
    const log = new SessionLog('s48-fs2')
    const lines: string[] = []
    log.attachSink((line) => { lines.push(line); writeFileSync(file, lines.join('\n') + '\n', 'utf8') })
    const authz = new AuthzService({ log })
    const allow = authz.decideByRule(
      { authorizationId: 'S:rule:r-1:allow', actor: 'user', capability: 'fs-read', resource: 'C:/Users/lqc/.ssh/id_ed25519' },
      { decision: 'APPROVED', reason: 'file-rule:r-1 allow read' },
    )
    assert.equal(allow.decision, 'APPROVED')
    assert.equal(allow.decidedBy, 'policy')
    const deny = authz.decideByRule(
      { authorizationId: 'S:rule:r-7:deny', actor: 'user', capability: 'fs-delete', resource: 'D:/ws/.car/sessions' },
      { decision: 'DENIED', reason: 'file-rule:r-7 deny delete' },
    )
    assert.equal(deny.decision, 'DENIED')
    // 幂等：同 id 返回同一决策对象
    const again = authz.decideByRule(
      { authorizationId: 'S:rule:r-1:allow', actor: 'user', capability: 'fs-read', resource: 'x' },
      { decision: 'DENIED', reason: '试图改判' },
    )
    assert.equal(again.hash, allow.hash, '同 id 幂等（改判无效）')
    // 落链 reason 保真：审计可回答「为什么没问人」
    const authzEvents = log.events.filter(e => e.kind === 'turnEnd' && String(e.turnId).startsWith('authz:'))
    assert.equal(authzEvents.length, 2)
    const reasons = authzEvents.map(e => (e.meta as Record<string, unknown>).reason)
    assert.ok(reasons.includes('file-rule:r-1 allow read'))
    assert.ok(reasons.includes('file-rule:r-7 deny delete'))
    assert.equal(log.verifyChain(), null)
  })
})

// ==================== K-FS-3 + K-SC-1：Capability 加法 + exec authorizeAll ====================

function degradedExecutor(audit: SandboxAuditSink): SandboxExecutor {
  return new SandboxExecutor({
    probe: { platform: 'win32', landlock: false, seccomp: false, degraded: true, reason: 's48-test-degraded' },
    audit,
    workspace: tmpdir(),
  })
}
const nodeExit0 = [process.execPath, '-e', 'process.exit(0)']

test('K-FS-3: fs-delete 归写类——readonly permissionMode 一律拒（不 spawn）；fs-read 只读类不拒', async () => {
  const audit: unknown[] = []
  const ex = degradedExecutor(e => audit.push(e))
  const del = await ex.exec({ argv: nodeExit0, capabilities: ['fs-delete'], mode: 'read-only', permissionMode: 'readonly' })
  assert.equal(del.ok, false)
  assert.equal(del.denied, 'authorization-denied', 'fs-delete 写类在 readonly 一律拒（Q-04 同款）')
  const rd = await ex.exec({ argv: nodeExit0, capabilities: ['fs-read'], mode: 'read-only', permissionMode: 'readonly' })
  assert.equal(rd.ok, true, 'fs-read 只读类放行（readonly 契约不变）')
})

test('K-SC-1: exec 缺省零变化——confirm 下 fs-read 不进门；authorizeAll=true → 进门（approve/deny 双向）', async () => {
  let calls = 0
  const audit: unknown[] = []
  const ex = degradedExecutor(e => audit.push(e))
  const req = { argv: nodeExit0, capabilities: ['fs-read' as const], mode: 'read-only' as const, permissionMode: 'confirm' as const }
  const bypass = await ex.exec({ ...req, authorize: async () => { calls++; return true } })
  assert.equal(bypass.ok, true)
  assert.equal(calls, 0, '缺省（authorizeAll 缺省）fs-read 不进门')
  const approved = await ex.exec({ ...req, authorizeAll: true, authorize: async () => { calls++; return true } })
  assert.equal(approved.ok, true)
  assert.ok(calls >= 1, 'authorizeAll=true 只读 argv 进门且批准放行')
  const denied = await ex.exec({ ...req, authorizeAll: true, authorize: async () => false })
  assert.equal(denied.ok, false)
  assert.equal(denied.denied, 'authorization-denied')
  assert.ok(audit.some(e => (e as { kind: string }).kind === 'sandbox-denied'), '拒绝留痕（审计 sink）')
})

// ==================== K-S3-1/2：loadSessionLog + fromEvents 恢复面（D-S2-6 前提修正） ====================

test('K-S3-1/2: 载入→verifyChain 完整→续 append 链不分叉（seq 连续 + prevHash 接原尾 + 导出字节前缀一致）', () => {
  withTempDir('resume', (dir) => {
    const file = join(dir, 'session-s48-resume.jsonl')
    const log = new SessionLog('s48-resume')
    const lines: string[] = []
    log.attachSink((line) => { lines.push(line) })
    log.append('user', 'user', 'T1', '第一轮任务输入（跨运行前）')
    log.append('model', 'assistant', 'T1', '第一轮回复')
    log.append('user', 'user', 'T2', '第二轮任务输入')
    const original = lines.join('\n') + '\n'
    writeFileSync(file, original, 'utf8')

    const loaded = loadSessionLog(file)
    assert.equal(loaded.brokenAt, null, '载入链完整')
    assert.equal(loaded.log.events.length, 3)
    assert.equal(loaded.encoding, 'plain')
    assert.equal(loaded.log.exportJSONL(), original, '载入后导出与原链逐字节一致')

    // 恢复面（fromEvents 随 loadSessionLog 已重建 #tail）：跨运行续写
    const resumed = loaded.log
    const e = resumed.append('model', 'assistant', 'T2', '跨运行续写的回复')
    assert.equal(e.seq, 3, 'seq 连续')
    const lastOriginal = JSON.parse(lines[lines.length - 1]) as { hash: string }
    assert.equal(e.prevHash, lastOriginal.hash, 'prevHash 接原链尾')
    assert.equal(resumed.verifyChain(), null, '续写后链完整')
    assert.ok(resumed.exportJSONL().startsWith(original), '续写导出 = 原链字节前缀 + 新事件（历史零漂移）')
  })
})

test('K-S3-1: 断链注入 → brokenAt 定位到被篡改事件 seq（审计页断链定位内核真值）', () => {
  withTempDir('broken', (dir) => {
    const file = join(dir, 'session-s48-broken.jsonl')
    const log = new SessionLog('s48-broken')
    log.append('user', 'user', 'T1', 'a')
    log.append('model', 'assistant', 'T1', 'b')
    log.append('user', 'user', 'T2', 'c')
    const lines = log.exportJSONL().trim().split('\n')
    const tampered = JSON.parse(lines[1]) as Record<string, unknown>
    tampered.payload = '篡改后的内容' // 改载荷不改 hash → hash 校验失败
    lines[1] = JSON.stringify(tampered)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    const loaded = loadSessionLog(file)
    assert.equal(loaded.brokenAt, 1, '断链定位到 seq=1')
  })
})

// ==================== K-S3-3：exportForensicsBundle / verifyBundle（seam 消费形态冒烟） ====================

test('K-S3-3: 取证包导出 + 读回重验 PASS；篡改文件 → brokenFile 定位；断链即中止', () => {
  withTempDir('export', (dir) => {
    const file = join(dir, 'session-s48-export.jsonl')
    const log = new SessionLog('s48-export')
    log.append('user', 'user', 'T1', '取证对象事件一（含中文与引号"ok"）')
    log.append('model', 'assistant', 'T1', '取证对象事件二')
    writeFileSync(file, log.exportJSONL(), 'utf8')

    const loaded = loadSessionLog(file)
    const meta = { sessionId: 's48-export', exportedBy: 'lqc', exportedAt: new Date().toISOString(), runtimeVersion: '1.13.0', sessionRange: { fromSeq: 0, toSeq: 1 } }
    const bundle = exportForensicsBundle(loaded.log, meta)
    assert.equal(bundle.manifest.verifyChainAtExport, 'PASS')
    assert.equal(verifyBundle(bundle).ok, true, '读回重验通过')
    // 篡改：改事件内容不动 files[].sha256 → brokenFile 定位
    const tampered = { files: [{ ...bundle.files[0], content: bundle.files[0].content.replace('一', '二') }], manifest: bundle.manifest }
    const v = verifyBundle(tampered)
    assert.equal(v.ok, false)
    assert.equal(v.brokenFile, bundle.files[0].name)
    // 断链即中止：断链日志导出抛 CAR-E-EXPORT
    const brokenLines = (loaded.log.exportJSONL().trim().split('\n').map((l, i) => i === 0 ? l.replace('一', '三') : l)).join('\n') + '\n'
    const brokenFile = join(dir, 'broken.jsonl')
    writeFileSync(brokenFile, brokenLines, 'utf8')
    const brokenLog = loadSessionLog(brokenFile)
    assert.notEqual(brokenLog.brokenAt, null)
    assert.throws(() => exportForensicsBundle(brokenLog.log, meta), /CAR-E-EXPORT/, '断链中止导出（禁止带病审计包外流）')
    // 读回的文件字节与载入面一致性（取证包内容 = 盘面事实）
    assert.equal(readFileSync(file, 'utf8'), loaded.log.exportJSONL())
  })
})
