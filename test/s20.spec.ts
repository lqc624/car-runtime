import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlugins, renderLoadReport, ReloadManager, formatLoadReport, newInstallId } from '../src/load/report.ts'
import { doctorCredentials, doctorConnectivity } from '../src/dx/doctor.ts'
import type { LoadReportVO } from '../src/load/report.ts'

// ==================== fixture 工具（红线 8：清理 try/catch 容错） ====================

const PLUGIN_BODY = (tool: string) =>
  `export default function apply(api) {\n  api.registerTool({ name: '${tool}', run: async () => 'ok' })\n}\n`

function makePlugin(dir: string, file: string, manifest: Record<string, unknown>, tool: string): string {
  const p = join(dir, file)
  writeFileSync(p, `export const manifest = ${JSON.stringify(manifest)}\n${PLUGIN_BODY(tool)}\n`)
  return p
}

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s20-${name}-`))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 红线 8：safe-delete 拦截容错 */ } })
}

const stageOf = (r: LoadReportVO, s: string) => r.stages.find(x => x.stage === s)!
const stageNames = (r: LoadReportVO) => r.stages.map(s => `${s.stage}:${s.status}`)

// ==================== 五阶段加载报告 ====================

test('M6: 五阶段成功路径——全 PASS + LoadReportVO 结构对齐 §3.2.M6.3 + 拓扑序装配', async () => {
  await withTempDir('ok', async (dir) => {
    makePlugin(dir, 'dep-p.ts', { name: 'dep-p', version: '1.0.0' }, 'dep-tool')
    makePlugin(dir, 'consumer.ts', { name: 'consumer', version: '2.0.0', peers: [{ peer: 'dep-p', range: '^1.0.0' }] }, 'con-tool')
    const { report, plugins, order } = await loadPlugins({ source: dir })
    // 结构逐字对齐：installId / startedTime(ISO) / durationMs / stages×5 / warnings
    assert.match(report.installId, /^car-install-/)
    assert.equal(Number.isNaN(Date.parse(report.startedTime)), false)
    assert.equal(typeof report.durationMs, 'number')
    assert.ok(report.durationMs >= 0)
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS',
    ])
    assert.ok(Array.isArray(report.warnings))
    // 拓扑序：provider（dep-p）先于 consumer
    assert.deepEqual(order.map(m => m.name), ['dep-p', 'consumer'])
    assert.equal(plugins.length, 2)
    // FAIL 阶段不存在 conflicts/error；PASS 报告无 error 定位
    for (const s of report.stages) { assert.equal(s.conflicts, undefined); assert.equal(s.error, undefined) }
  })
})

test('M6: manifest 失败短路——parse FAIL + 文件定位 + 后续阶段 SKIPPED', async () => {
  await withTempDir('bad-manifest', async (dir) => {
    makePlugin(dir, 'good.ts', { name: 'good', version: '1.0.0' }, 't1')
    makePlugin(dir, 'broken.ts', { name: 'broken', version: '^1.0.0' }, 't2') // 非精确 semver
    const { report } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'parse:FAIL', 'validate:SKIPPED', 'topo:SKIPPED', 'register:SKIPPED',
    ])
    const parse = stageOf(report, 'parse')
    assert.match(parse.error!.file, /broken\.ts$/)
    assert.match(parse.error!.reason, /CAR-E-MANIFEST.*exact semver/)
  })
})

test('M6: peer 冲突链定位——validate FAIL 附 conflicts（文件/区间/实际版本/依赖路径）', async () => {
  await withTempDir('peer-conflict', async (dir) => {
    makePlugin(dir, 'dep-p.ts', { name: 'dep-p', version: '1.0.0' }, 't1')
    makePlugin(dir, 'consumer.ts', { name: 'consumer', version: '2.0.0', peers: [{ peer: 'dep-p', range: '^2.0.0' }] }, 't2')
    const { report } = await loadPlugins({ source: dir })
    assert.deepEqual(stageNames(report), [
      'discover:PASS', 'parse:PASS', 'validate:FAIL', 'topo:SKIPPED', 'register:SKIPPED',
    ])
    const conflicts = stageOf(report, 'validate').conflicts!
    assert.equal(conflicts.length, 1)
    const c = conflicts[0]!
    assert.match(c.file, /consumer\.ts$/)
    assert.equal(c.peer, 'dep-p')
    assert.equal(c.range, '^2.0.0')
    assert.equal(c.installed, '1.0.0')
    assert.equal(c.path, 'manifest.peers')
  })
})

test('M6: 警告——git 直载来源 CAR-W-GIT-DIRECT（E-03）+ peer 豁免 CAR-W-PEER-EXEMPT', async () => {
  await withTempDir('warnings', async (dir) => {
    // git 工作树直载：目录内含 .git 即产生告警（不失败）
    mkdirSync(join(dir, '.git'))
    makePlugin(dir, 'p.ts', { name: 'p', version: '1.0.0' }, 't')
    const { report: r1 } = await loadPlugins({ source: dir })
    assert.equal(stageOf(r1, 'discover').status, 'PASS')
    assert.ok(r1.warnings.some(w => w.startsWith('CAR-W-GIT-DIRECT')), 'git 直载告警')
    // git URL 来源同样告警
    const { report: r2 } = await loadPlugins({ source: dir, gitDirect: false })
    void r2
    const urlRes = await loadPlugins({ source: 'git+https://example.com/repo.git' })
    assert.ok(urlRes.report.warnings.some(w => w.startsWith('CAR-W-GIT-DIRECT')))
    // peer 豁免：relaxed + reason → 放行 + 告警留痕
    const dir2 = mkdtempSync(join(tmpdir(), 'car-s20-exempt-'))
    try {
      makePlugin(dir2, 'dep-p.ts', { name: 'dep-p', version: '1.0.0' }, 't1')
      makePlugin(dir2, 'consumer.ts', {
        name: 'consumer', version: '2.0.0',
        peers: [{ peer: 'dep-p', range: '^2.0.0' }],
        peerPolicyOverride: { relaxed: true, reason: '临时对齐中，下版本收紧' },
      })
      const { report } = await loadPlugins({ source: dir2 })
      assert.equal(stageOf(report, 'validate').status, 'PASS')
      assert.ok(report.warnings.some(w => w.startsWith('CAR-W-PEER-EXEMPT')))
    } finally { try { rmSync(dir2, { recursive: true, force: true }) } catch {} }
  })
})

test('M6: renderLoadReport 纯函数口径——plan + 阶段结果 → VO（规格签名）', () => {
  const startedAtMs = Date.now() - 5
  const plan = {
    installId: newInstallId(), source: '/x', startedTime: new Date(startedAtMs).toISOString(),
    startedAtMs, files: [], warnings: ['w1'],
  }
  const vo = renderLoadReport(plan, [{ stage: 'discover', status: 'PASS' }, { stage: 'parse', status: 'SKIPPED' }])
  assert.deepEqual(vo.warnings, ['w1'])
  assert.equal(vo.stages.length, 2)
  assert.ok(vo.durationMs >= 5)
  // 计划不可变：传入数组后续修改不泄漏进 VO（冻结语义）
  plan.warnings.push('w2')
  assert.deepEqual(vo.warnings, ['w1'])
})

// ==================== 热重载（SQ-05） ====================

test('M6: 热重载——epoch 递增、旧句柄 invalidate 后报 CAR-INVALIDATED、新实例可用', async () => {
  await withTempDir('reload', async (dir) => {
    const file = join(dir, 'hot.ts')
    writeFileSync(file, `export const manifest = { name: 'hot', version: '1.0.0' }\n${PLUGIN_BODY('tool-v1')}`)
    const mgr = new ReloadManager()
    assert.equal(mgr.epoch, 0)
    const r1 = await mgr.reload(file)
    assert.equal(mgr.epoch, 1)
    assert.deepEqual(stageNames(r1.report), ['discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS'])
    assert.equal(r1.plugins[0]!.manifest.version, '1.0.0')
    const host1: Array<{ name: string }> = []
    r1.plugins[0]!.bindCore({ registerTool: t => { host1.push(t) }, getRegisteredTools: () => host1 })
    assert.deepEqual(r1.plugins[0]!.api.getRegisteredTools().map(t => t.name), ['tool-v1'])
    // 重写源文件 → reload → epoch+1 击穿缓存，新代码生效
    writeFileSync(file, `export const manifest = { name: 'hot', version: '1.1.0' }\n${PLUGIN_BODY('tool-v2')}`)
    const r2 = await mgr.reload(file)
    assert.equal(mgr.epoch, 2)
    assert.equal(r2.plugins[0]!.manifest.version, '1.1.0')
    const host2: Array<{ name: string }> = []
    r2.plugins[0]!.bindCore({ registerTool: t => { host2.push(t) }, getRegisteredTools: () => host2 })
    assert.deepEqual(r2.plugins[0]!.api.getRegisteredTools().map(t => t.name), ['tool-v2'])
    // 旧句柄 invalidate 后访问显式报错（Stub 语义，防 stale context 误用）
    assert.throws(() => r1.plugins[0]!.api.getRegisteredTools(), /CAR-INVALIDATED/)
    // reload 报告留痕
    assert.equal(mgr.history.length, 2)
  })
})

test('M6: reload 失败路径——FAIL 报告含定位，管理器不静默回退', async () => {
  await withTempDir('reload-fail', async (dir) => {
    const file = join(dir, 'hot.ts')
    writeFileSync(file, `export const manifest = { name: 'hot', version: '1.0.0' }\n${PLUGIN_BODY('t')}`)
    const mgr = new ReloadManager()
    await mgr.reload(file)
    writeFileSync(file, `export const manifest = { name: 'hot', version: 'not-semver' }\n${PLUGIN_BODY('t')}`)
    const { report, plugins } = await mgr.reload(file)
    assert.equal(stageOf(report, 'parse').status, 'FAIL')
    assert.match(stageOf(report, 'parse').error!.reason, /exact semver/)
    assert.equal(plugins.length, 0, '失败重载不残留新实例')
  })
})

// ==================== car doctor（离线可过） ====================

test('M6: doctor 凭据检查——只报存在性、不打印值；离线连通性 SKIPPED 不失败', async () => {
  const creds = doctorCredentials({ CAR_TOKEN: 'secret-value-should-never-appear' } as NodeJS.ProcessEnv)
  assert.equal(creds.length, 2)
  const carTok = creds.find(c => c.envVar === 'CAR_TOKEN')!
  assert.equal(carTok.present, true)
  const npmTok = creds.find(c => c.envVar === 'NPM_TOKEN')!
  assert.equal(npmTok.present, false)
  // 红线：凭据检查输出永不包含值
  const rendered = JSON.stringify(creds)
  assert.equal(rendered.includes('secret-value-should-never-appear'), false)
  // 显式跳过 = SKIPPED
  const skipped = await doctorConnectivity({ skip: true })
  assert.equal(skipped.status, 'SKIPPED')
  // 不可达 = SKIPPED 而非 FAIL（离线环境 doctor 整体 PASS 口径）
  const unreachable = await doctorConnectivity({ registryUrl: 'http://127.0.0.1:1/-/ping', timeoutMs: 800 })
  assert.equal(unreachable.status, 'SKIPPED')
  assert.match(unreachable.detail, /显式跳过|不可达/)
})

// ==================== QS-05 加载基线（P95 ≤ 800ms，纯本地 mock 插件） ====================

test('QS-05: 加载耗时基线——P95 ≤ 800ms（20 轮热重载五插件，缓存击穿口径）', async () => {
  await withTempDir('p95', async (dir) => {
    const N = 5
    for (let i = 1; i <= N; i++) makePlugin(dir, `p${i}.ts`, { name: `p${i}`, version: '1.0.0' }, `tool-${i}`)
    const mgr = new ReloadManager()
    const runs = 20
    const durations: number[] = []
    for (let i = 0; i < runs; i++) {
      const { report } = await mgr.reload(dir)
      assert.deepEqual(stageNames(report), ['discover:PASS', 'parse:PASS', 'validate:PASS', 'topo:PASS', 'register:PASS'])
      durations.push(report.durationMs)
    }
    durations.sort((a, b) => a - b)
    // 最近邻秩 P95（n=20 → 第 19 位，1-based）
    const p95 = durations[Math.ceil(0.95 * runs) - 1]!
    assert.ok(p95 <= 800, `P95=${p95}ms 应 ≤ 800ms（QS-05）；全量=${JSON.stringify(durations)}`)
  })
})

// ==================== CLI 报告渲染（formatLoadReport 纯文本出口） ====================

test('M6: formatLoadReport——PASS 摘要 + FAIL 定位 + 耗时/告警行', () => {
  const vo: LoadReportVO = {
    installId: 'car-install-x',
    startedTime: new Date(0).toISOString(),
    durationMs: 42,
    stages: [
      { stage: 'discover', status: 'PASS' },
      { stage: 'parse', status: 'FAIL', error: { file: '/a/b.ts', reason: 'CAR-E-MANIFEST: boom' } },
      { stage: 'validate', status: 'SKIPPED' },
      { stage: 'topo', status: 'SKIPPED' },
      { stage: 'register', status: 'SKIPPED' },
    ],
    warnings: ['CAR-W-GIT-DIRECT: demo'],
  }
  const lines = formatLoadReport(vo)
  const all = lines.join('\n')
  assert.match(all, /installId=car-install-x/)
  assert.match(all, /\[parse\s*\] FAIL — CAR-E-MANIFEST: boom \(file: \/a\/b\.ts\)/)
  assert.match(all, /\[validate\] SKIPPED/)
  assert.match(all, /durationMs=42 warnings=1/)
  assert.match(all, /CAR-W-GIT-DIRECT: demo/)
})
