/**
 * 1.5-S3 · 配置完整形态（S35）：car.config.ts + zod（D-22）
 *
 * 覆盖：
 *  - zod 校验层 JSON 键位兼容（存量锚点）：未知键 fail-visible（llm.temperature）/ 类型错
 *    （llm.maxTokens 必须为正整数）/ sandbox 扁平渲染 / 坏 JSON / 顶层非对象
 *  - car.config.ts 载体：发现序 ts > json（并存 = ts 胜出）/ 显式 --config *.ts /
 *    未预热显式报错（禁静默回退 json）/ epoch 缓存击穿（热改重预热取新内容）
 *  - TS 形态校验：缺 default export / 非 object default / 坏 TS（Node 不支持时引导文案）
 *  - mcp url/headers 键位经 zod（s34 锚点：恰好其一 / http(s) URL / 通道专属键）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCarConfig, warmCarConfig } from '../src/load/config.ts'
import { mergeSignatureGate, mergeLlmConfig } from '../src/load/config.ts'

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `car-s35-${name}-`))
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

// ==================== zod 校验层（JSON 键位兼容） ====================

test('S35: zod 校验层——存量锚点全过（未知键/类型错/坏 JSON/顶层非对象/扁平渲染）', () => {
  withTempDir('zod-compat', dir => {
    // s31 锚点：未知键 llm.temperature / maxTokens 类型错
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ llm: { temperature: 0.7 } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'a.json') }).error!, /未知键 llm\.temperature/)
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ llm: { maxTokens: 1.5 } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'b.json') }).error!, /llm\.maxTokens 必须为正整数/)
    // 坏 JSON / 顶层非对象（CAR-E-CONFIG 前缀）
    writeFileSync(join(dir, 'c.json'), '{ sandbox: {')
    assert.match(loadCarConfig({ explicitPath: join(dir, 'c.json') }).error!, /CAR-E-CONFIG/)
    writeFileSync(join(dir, 'd.json'), '[]')
    assert.match(loadCarConfig({ explicitPath: join(dir, 'd.json') }).error!, /CAR-E-CONFIG/)
    // 未知顶层键 / 未知嵌套键（unrecognized_keys 渲染）
    writeFileSync(join(dir, 'e.json'), JSON.stringify({ plugins: [] }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'e.json') }).error!, /未知顶层键 "plugins"/)
    writeFileSync(join(dir, 'f.json'), JSON.stringify({ sandbox: { unsigned: { allow: true, extra: 1 } } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'f.json') }).error!, /未知键 sandbox\.unsigned\.extra/)
    // 有效配置：扁平渲染（mergeSignatureGate 消费形态不变，s26 锚点）
    writeFileSync(join(dir, 'g.json'), JSON.stringify({ sandbox: { unsigned: { allow: true }, sig: { enforce: true, trustRoot: 'PUBKEY' } }, llm: { baseUrl: 'https://x/v1', model: 'm' } }))
    const ok = loadCarConfig({ explicitPath: join(dir, 'g.json') })
    assert.equal(ok.error, undefined)
    assert.deepEqual(ok.config.sandbox, { unsignedAllow: true, sigEnforce: true, sigTrustRoot: 'PUBKEY' })
    assert.deepEqual(ok.config.llm, { baseUrl: 'https://x/v1', model: 'm' })
    // mcp url/headers 键位经 zod（s34 锚点）
    writeFileSync(join(dir, 'h.json'), JSON.stringify({ mcp: { servers: { a: { command: 'node', url: 'https://x' } } } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'h.json') }).error!, /恰好其一/)
    writeFileSync(join(dir, 'i.json'), JSON.stringify({ mcp: { servers: { a: { command: 'node', headers: { h: 'v' } } } } }))
    assert.match(loadCarConfig({ explicitPath: join(dir, 'i.json') }).error!, /headers 仅远程通道/)
    writeFileSync(join(dir, 'j.json'), JSON.stringify({ mcp: { servers: { a: { url: 'https://x/mcp', headers: { authorization: 'Bearer ${T}' } } } } }))
    const ok2 = loadCarConfig({ explicitPath: join(dir, 'j.json') })
    assert.equal(ok2.error, undefined)
    assert.deepEqual(ok2.config.mcp?.servers?.a, { url: 'https://x/mcp', headers: { authorization: 'Bearer ${T}' } })
  })
})

// ==================== car.config.ts 载体 ====================

test('S35: car.config.ts 载体——发现序 ts > json（并存 ts 胜出）+ 显式 --config *.ts + merge 全链', async () => {
  await withTempDir('ts-carrier', async dir => {
    writeFileSync(join(dir, 'car.config.ts'), `export default {\n  llm: { baseUrl: 'https://ts.example/v1', model: 'ts-model', maxTokens: 512 },\n  mcp: { servers: { remote: { url: 'https://mcp.example/mcp' } } },\n}\n`)
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({ llm: { baseUrl: 'https://json.example/v1', model: 'json-model' } }))
    await warmCarConfig({ cwd: dir })
    const r = loadCarConfig({ cwd: dir })
    assert.equal(r.error, undefined)
    assert.match(r.path!, /car\.config\.ts$/, '发现序 ts > json：并存时 ts 胜出')
    assert.equal(r.config.llm?.baseUrl, 'https://ts.example/v1')
    assert.deepEqual(r.config.mcp?.servers?.remote, { url: 'https://mcp.example/mcp' }, 'ts 载体携带 1.5 新键位')
    // merge 全链（D-16 优先级）不变
    const merged = mergeLlmConfig({}, r.config)
    assert.equal(merged.model, 'ts-model')
    assert.equal(merged.maxTokens, 512)
    // 显式 --config *.ts
    await warmCarConfig({ explicitPath: join(dir, 'car.config.ts'), cwd: dir })
    const r2 = loadCarConfig({ explicitPath: join(dir, 'car.config.ts'), cwd: dir })
    assert.equal(r2.error, undefined)
    assert.equal(r2.config.llm?.model, 'ts-model')
    // 纯 json 目录不受影响（回归口径：无 ts 载体 = 原行为）
    await withTempDir('json-only', async dir2 => {
      writeFileSync(join(dir2, 'car.config.json'), JSON.stringify({ sandbox: { sig: { enforce: true } } }))
      const r3 = loadCarConfig({ cwd: dir2 })
      assert.equal(r3.error, undefined)
      assert.equal(mergeSignatureGate({}, r3.config).mode, 'enforce')
    })
  })
})

test('S35: car.config.ts 未预热显式报错（禁静默回退 json）+ epoch 缓存击穿（热改重预热取新内容）', async () => {
  await withTempDir('warm-protocol', async dir => {
    writeFileSync(join(dir, 'car.config.ts'), `export default { llm: { model: 'v1' } }\n`)
    writeFileSync(join(dir, 'car.config.json'), JSON.stringify({ llm: { model: 'json-fallback' } }))
    // 未预热：显式报错（不静默回退 json——「配置写了但不生效」漂移面显式化）
    const cold = loadCarConfig({ cwd: dir })
    assert.match(cold.error!, /car\.config\.ts 未预热/)
    assert.match(cold.error!, /warmCarConfig/)
    // 预热后取 ts 内容
    await warmCarConfig({ cwd: dir })
    assert.equal(loadCarConfig({ cwd: dir }).config.llm?.model, 'v1')
    // 热改：同路径重写 → 重预热（epoch 查询串击穿模块缓存）→ 新内容
    writeFileSync(join(dir, 'car.config.ts'), `export default { llm: { model: 'v2' } }\n`)
    await warmCarConfig({ cwd: dir })
    assert.equal(loadCarConfig({ cwd: dir }).config.llm?.model, 'v2', 'epoch 击穿缓存')
  })
})

test('S35: TS 形态校验——缺 default / 非 object default / 坏 TS fail-visible', async () => {
  await withTempDir('ts-shape', async dir => {
    writeFileSync(join(dir, 'car.config.ts'), `export const config = { llm: { model: 'x' } }\n`)
    await warmCarConfig({ cwd: dir })
    assert.match(loadCarConfig({ cwd: dir }).error!, /缺 default export/)

    await withTempDir('ts-shape2', async dir2 => {
      writeFileSync(join(dir2, 'car.config.ts'), `export default ['not', 'an', 'object']\n`)
      await warmCarConfig({ cwd: dir2 })
      assert.match(loadCarConfig({ cwd: dir2 }).error!, /default export 必须为对象/)
    })

    await withTempDir('ts-broken', async dir3 => {
      writeFileSync(join(dir3, 'car.config.ts'), `export default { llm: ((( }\n`)
      await warmCarConfig({ cwd: dir3 })
      const r = loadCarConfig({ cwd: dir3 })
      assert.match(r.error!, /CAR-E-CONFIG: car\.config\.ts 载入失败/)
    })

    await withTempDir('ts-zod-invalid', async dir4 => {
      writeFileSync(join(dir4, 'car.config.ts'), `export default { llm: { temperature: 0.9 } }\n`)
      await warmCarConfig({ cwd: dir4 })
      assert.match(loadCarConfig({ cwd: dir4 }).error!, /未知键 llm\.temperature/, 'ts 载体与 json 同一 zod 校验层')
    })
  })
})
