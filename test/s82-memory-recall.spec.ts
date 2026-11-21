/**
 * s82 · 1.25.0 记忆召回层（Z-5 / Q-Z1 裁决 / D-Z5-1~9，《内核1.25-记忆召回层-迭代规划.md》）
 *
 * 覆盖（规划 §五）：
 *  - 索引三态（D-Z5-1）：首建（缺文件→建+写盘 driftRepaired='absent'）/ 对拍命中零动作
 *    （driftRepaired 缺席）/ 漂移三形态（手改行、updatedAt 不一致、条目外部删除残留）→ 重建
 *    driftRepaired='drift'——全文件逐字节对拍，任何手改皆漂移；索引重建不落链
 *  - 索引行形态：type 有/无、description 有/无（fallback 首行截断 ≤80）、多行正文单行化、
 *    updatedAt 降序、注入面不含 u token / 文件面含 u token + 文件头注记
 *  - CRUD 同步重写：write/edit/remove/rollback 后 index.md 即新（再装载零 drift）
 *  - 数据模型（D-Z5-9）：write/edit 携带三键落链（payload memType/description/keywords——
 *    payload.type 为操作判别符故记忆类型键名 = memType，规划同名键表述以此勘误）；edit meta
 *    语义（undefined=不变/显式=设置/null·''·[]=清空）；rollback 链重放恢复三字段；type 注册表
 *    校验 CAR-E-MEM-TYPE；存量条目（无三字段）索引/召回字节兼容
 *  - 召回算法（D-Z5-2）：tag 命中 / keywords 命中 / 并集去重 / ≥2 字符门槛（1 字符键不参与）/
 *    无键条目不命中（正文含词≠匹配——匹配键面 = tags ∪ keywords）/ 多条命中 updatedAt 降序 /
 *    matchedKeys 字面正确
 *  - 预算双门（D-Z5-5）：索引超预算 fail-visible（最小不可再分面）/ 召回后仍超才拒 / 零命中
 *    空返回 / 预算非法值 fail-visible
 *  - 落链形态（D-Z5-4）：宿主 append meta injection='memory-index'/'memory-recall' + hits 形态
 *    + deriveMessages 字符串形态投影（Model-visible means logged 由构造保证）+ verifyChain null
 *    + EventKind 零新增（链上 kind 面与 1.24.3 同域）
 *  - legacy 回归：loadMemoryForInjection 行为逐字节不变（s55 断言全绿之外的字节面锚点）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '../src/session/log.ts'
import { MemoryStore, MEMORY_TYPES, buildMemoryIndex, recallMemories, loadMemoryForInjection } from '../src/memory/store.ts'

function buildSession(): SessionLog {
  const log = new SessionLog('S-s82')
  log.append('user', 'system', 'sys', 'You are CAR.')
  log.append('user', 'user', 'T1', '用户问题 1')
  log.append('model', 'assistant', 'T1', '回答 1')
  log.append('runtime', 'turnEnd', 'T1', null, { reason: 'completed' })
  return log
}

/** 受控时钟：每次调用 +1000——updatedAt 可控（排序断言消除同毫秒竞态，s55 同款缝） */
function tmpStore(): { store: MemoryStore; dir: string; log: SessionLog; cleanup: () => void } {
  let t = 0
  const dir = join(mkdtempSync(join(tmpdir(), 'car-mem-s82-')), 'memory')
  const store = new MemoryStore(dir, { now: () => (t += 1000) })
  return { store, dir, log: buildSession(), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const INDEX_HEADER = '# CAR 记忆索引（派生面——CRUD 自动重写；手改/漂移在读时对拍修复，勿手编）'

test('S82-1 索引三态：缺席重建 absent / 对拍命中零动作 / 空库首建', () => {
  const { store, dir, log, cleanup } = tmpStore()
  try {
    // 缺席重建：CRUD 已同步写索引，外部删 index.md 模拟索引缺席（前置于索引的存量条目同形态）→ 重建 + 'absent'
    store.write(log, { id: 'm1', text: '部署视图已发版', tags: ['部署'], type: 'project' })
    rmSync(join(dir, 'index.md'))
    const r1 = buildMemoryIndex(store)
    assert.equal(r1.driftRepaired, 'absent')
    assert.ok(existsSync(join(dir, 'index.md')))
    assert.equal(r1.count, 1)
    // 对拍命中：零动作（driftRepaired 缺席 + 文件内容不变）
    const before = readFileSync(join(dir, 'index.md'), 'utf8')
    const r2 = buildMemoryIndex(store)
    assert.equal(r2.driftRepaired, undefined)
    assert.equal(readFileSync(join(dir, 'index.md'), 'utf8'), before, '对拍命中零重写')
    // 空库首建（先清空盘面再另建 store——index.md 仅头行）
    rmSync(dir, { recursive: true, force: true })
    const empty = new MemoryStore(dir, { now: () => 1 })
    const r3 = buildMemoryIndex(empty)
    assert.equal(r3.count, 0)
    assert.equal(r3.rendered, '')
    assert.equal(r3.driftRepaired, 'absent')
    assert.equal(readFileSync(join(dir, 'index.md'), 'utf8'), `${INDEX_HEADER}\n`, '空库索引 = 仅头行')
  } finally {
    cleanup()
  }
})

test('S82-2 索引漂移三形态：手改行 / updatedAt 不一致 / 条目外部删除残留 → 重建 drift', () => {
  const { store, dir, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '部署视图已发版', tags: ['部署'], type: 'project' })
    store.write(log, { id: 'm2', text: '用户偏好简洁回复', type: 'feedback', description: '回复风格偏好' })
    buildMemoryIndex(store)
    const good = readFileSync(join(dir, 'index.md'), 'utf8')
    // 形态一：手改行（索引说 A 正文改 B 的白盒模拟——描述漂移）
    writeFileSync(join(dir, 'index.md'), good.replace('回复风格偏好', '被手改的描述'), 'utf8')
    const r1 = buildMemoryIndex(store)
    assert.equal(r1.driftRepaired, 'drift')
    assert.equal(readFileSync(join(dir, 'index.md'), 'utf8'), good, '漂移即重建回期望投影')
    // 形态二：updatedAt token 不一致
    writeFileSync(join(dir, 'index.md'), good.replace(/u[0-9a-z]+/, 'udeadbeef'), 'utf8')
    const r2 = buildMemoryIndex(store)
    assert.equal(r2.driftRepaired, 'drift')
    // 形态三：条目被外部直接删除（绕过 CRUD——索引残留该行）
    rmSync(join(dir, 'm1.json'))
    const r3 = buildMemoryIndex(store)
    assert.equal(r3.driftRepaired, 'drift')
    assert.equal(r3.count, 1, '索引随事实源收敛（m1 已删仅剩 m2）')
    assert.ok(!readFileSync(join(dir, 'index.md'), 'utf8').includes('m1'))
  } finally {
    cleanup()
  }
})

test('S82-3 索引行形态：type 有无 / description fallback 首行截断 / 多行单行化 / 降序 / 注入面无 u token', () => {
  const { store, dir, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '部署视图已发版', tags: ['部署'], type: 'project' })
    store.write(log, { id: 'm2', text: '第一行很长的偏好描述'.repeat(10) + '\n第二行不进索引', type: 'feedback' })
    // edit m1 刷新 updatedAt → 降序 m1 在前（受控时钟：write m1=1000, write m2=2000, edit m1=3000）
    store.edit(log, 'm1', '部署视图已发版（v0.10）')
    const file = readFileSync(join(dir, 'index.md'), 'utf8')
    assert.ok(file.startsWith(INDEX_HEADER), '文件头注记在场')
    assert.match(file, /- \[m1\] \[project\] u[0-9a-z]+ 部署视图已发版（v0\.10）/, '文件面：type 标签 + u token + description')
    assert.match(file, /- \[m2\] \[feedback\] u[0-9a-z]+ 第一行很长的偏好描述第一行很长的偏好描述/, '文件面：无 description = 正文首行 fallback')
    assert.ok(!file.includes('第二行'), '多行正文单行化（仅首行）')
    assert.ok(file.indexOf('- [m1]') < file.indexOf('- [m2]'), 'updatedAt 降序（最近维护在前）')
    const r = buildMemoryIndex(store)
    assert.equal(r.driftRepaired, undefined)
    assert.ok(!r.rendered.includes('u1'), '注入面不含 u token')
    assert.ok(r.rendered.startsWith('[CAR 记忆索引] 共 2 条（正文按召回注入、依据落链）：'), '注入面拼装头')
    // fallback 截断 ≤80：单行 >80 字符截到 80
    store.write(log, { id: 'm3', text: '长'.repeat(200) })
    const r2 = buildMemoryIndex(store)
    assert.ok(!r2.driftRepaired)
    const m3Line = r2.rendered.split('\n').find((l) => l.includes('[m3]'))!
    const desc = m3Line.slice(m3Line.indexOf('长'))
    assert.ok(desc.length <= 80, `fallback 截断 ≤80（got ${desc.length}）`)
  } finally {
    cleanup()
  }
})

test('S82-4 CRUD 同步重写：四操作后索引即新（再装载零 drift）+ 无 tmp 残留', () => {
  const { store, dir, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '部署视图已发版', tags: ['部署'], type: 'project' })
    assert.equal(buildMemoryIndex(store).driftRepaired, undefined, 'write 后索引即新')
    store.edit(log, 'm1', '部署视图已发版（v0.10）', ['部署', '浏览器'], { description: 'v0.10 浏览器簇' })
    assert.equal(buildMemoryIndex(store).driftRepaired, undefined, 'edit 后索引即新')
    assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /v0\.10 浏览器簇/, 'edit 的 description 进索引行')
    store.remove(log, 'm1')
    const r = buildMemoryIndex(store)
    assert.equal(r.count, 0)
    assert.equal(r.driftRepaired, undefined, 'remove 后索引即新（空库）')
    // rollback undelete：恢复 m1 → 索引恢复该行
    const back = store.rollback(log, 'm1')
    assert.equal(back?.id, 'm1')
    assert.equal(buildMemoryIndex(store).driftRepaired, undefined, 'rollback 后索引即新')
    const tmps = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(tmps, [], '原子写无残留 tmp（索引与条目同纪律）')
  } finally {
    cleanup()
  }
})

test('S82-5 数据模型：三键落链 payload + edit meta 语义（不变/设置/清空）', () => {
  const { store, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '部署视图已发版', tags: ['部署'], type: 'project', description: 'v0.10', keywords: ['浏览器'] })
    const w = log.events.filter((e) => e.kind === 'memory').at(-1)!.payload as Record<string, unknown>
    assert.equal(w['memType'], 'project', 'payload 记忆类型键 = memType（payload.type 为操作判别符——规划同名键表述勘误）')
    assert.equal(w['description'], 'v0.10')
    assert.deepEqual(w['keywords'], ['浏览器'])
    // 全不触碰：三字段不变
    store.edit(log, 'm1', '部署视图 v0.10 已发版')
    const e1 = store.get('m1')!
    assert.equal(e1.type, 'project')
    assert.equal(e1.description, 'v0.10')
    assert.deepEqual(e1.keywords, ['浏览器'])
    // 显式设置：type 换档；description/keywords 不触碰不变
    store.edit(log, 'm1', '部署视图 v0.10 已发版', undefined, { type: 'reference' })
    const e2 = store.get('m1')!
    assert.equal(e2.type, 'reference')
    assert.equal(e2.description, 'v0.10')
    assert.deepEqual(e2.keywords, ['浏览器'])
    const e2p = log.events.filter((e) => e.kind === 'memory').at(-1)!.payload as Record<string, unknown>
    assert.equal(e2p['memType'], 'reference', '显式键 payload 恒带')
    assert.equal(e2p['description'], undefined, '未触碰键 payload 缺席（禁带键/缺键二义）')
    // 清空形态：null / '' / [] 恒带键
    store.edit(log, 'm1', '部署视图 v0.10 已发版', undefined, { type: null, description: '', keywords: [] })
    const e3 = store.get('m1')!
    assert.equal(e3.type, undefined)
    assert.equal(e3.description, undefined)
    assert.equal(e3.keywords, undefined)
    const e3p = log.events.filter((e) => e.kind === 'memory').at(-1)!.payload as Record<string, unknown>
    assert.equal(e3p['memType'], null, '清空 payload = null（与未触碰缺席二义禁令）')
    assert.equal(e3p['description'], '')
    assert.deepEqual(e3p['keywords'], [])
  } finally {
    cleanup()
  }
})

test('S82-6 rollback 链重放恢复三字段（D-Z5-9 rebuildStates 消费）', () => {
  const { store, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: 'v1', tags: ['a'], type: 'user', description: 'd1', keywords: ['k1'] })
    store.edit(log, 'm1', 'v2', ['b'], { type: 'project', description: 'd2', keywords: ['k2'] })
    const back1 = store.rollback(log, 'm1')! // → write 态（v1 + 三字段初始值）
    assert.equal(back1.text, 'v1')
    assert.deepEqual(back1.tags, ['a'])
    assert.equal(back1.type, 'user')
    assert.equal(back1.description, 'd1')
    assert.deepEqual(back1.keywords, ['k1'])
    const back2 = store.rollback(log, 'm1')! // → 回退到删除态？否——栈底 write 不可再回，回退目标是更早 absent？write 为栈底 → NOREV
    assert.fail('栈底 write 不可回退——上一行应抛 NOREV')
  } catch (e) {
    assert.match((e as Error).message, /CAR-E-MEM-NOREV/, '仅剩 write 初始版 = NOREV（s55 语义保持）')
  } finally {
    cleanup()
  }
})

test('S82-7 type 注册表校验：非法值 CAR-E-MEM-TYPE fail-visible + MEMORY_TYPES 四型可裁剪', () => {
  const { store, log, cleanup } = tmpStore()
  try {
    assert.deepEqual([...MEMORY_TYPES], ['user', 'feedback', 'project', 'reference'])
    assert.throws(() => store.write(log, { id: 'm1', text: 'x', type: 'team' as never }), /CAR-E-MEM-TYPE/, 'write 非法类型拒绝')
    store.write(log, { id: 'm1', text: 'x', type: 'user' })
    assert.throws(() => store.edit(log, 'm1', 'y', undefined, { type: 'secret' as never }), /CAR-E-MEM-TYPE/, 'edit 非法类型拒绝')
    assert.equal(store.get('m1')!.type, 'user', '拒绝后存量不变')
  } finally {
    cleanup()
  }
})

test('S82-8 存量条目兼容：无三字段 legacy JSON → 索引 fallback + 召回 tags 键照常', () => {
  const { store, dir, log, cleanup } = tmpStore()
  try {
    // 绕过 CRUD 直写 legacy 条目（1.15 形态——无 type/description/keywords）
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ id: 'old', text: '旧条目正文\n第二行', tags: ['旧键'], createdAt: 1, updatedAt: 500 }) + '\n', 'utf8')
    const idx = buildMemoryIndex(store)
    assert.equal(idx.driftRepaired, 'absent')
    assert.match(idx.rendered, /- \[old\] 旧条目正文/, 'legacy 条目索引行（无 type 标签 + 首行 fallback，注入面无 u token）')
    assert.ok(!idx.rendered.includes('第二行'))
    // 索引重建不改写条目文件（纯投影）+ 文件面 u token / 注入面无 token 两形态
    assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /- \[old\] u[0-9a-z]+ 旧条目正文/, '文件面带 u token')
    assert.ok(!idx.rendered.includes(' u'), '注入面无 u token')
    const raw = readFileSync(join(dir, 'old.json'), 'utf8')
    buildMemoryIndex(store)
    assert.equal(readFileSync(join(dir, 'old.json'), 'utf8'), raw, '索引维护零触碰条目文件')
    // 召回：legacy tags 键照常命中
    const rec = recallMemories(store, '关于旧键的事', { budgetChars: 8000 })
    assert.deepEqual(rec.hits, [{ id: 'old', matchedKeys: ['旧键'] }])
  } finally {
    cleanup()
  }
})

test('S82-9 召回算法：tag/keywords 命中、并集去重、≥2 门槛、无键不命中、多命中降序、matchedKeys 字面', () => {
  const { store, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '部署视图文档', tags: ['部署', '浏览器'] }) // 受控时钟 t=1000
    // m2：tags+keywords 同键去重 + 1 字符键不参与（t=2000）
    store.write(log, { id: 'm2', text: '回归测试笔记', tags: ['部署'], keywords: ['部署', '图'] })
    const r = recallMemories(store, '帮我看下部署视图和浏览器的问题', { budgetChars: 100000 })
    assert.deepEqual(r.hits.map((h) => h.id), ['m2', 'm1'], '多命中 updatedAt 降序（m2=2000 > m1=1000）')
    const m2 = r.hits.find((h) => h.id === 'm2')!
    assert.deepEqual(m2.matchedKeys, ['部署'], 'tags ∪ keywords 并集去重（部署只出现一次）；1 字符「图」不参与')
    const m1 = r.hits.find((h) => h.id === 'm1')!
    assert.deepEqual(m1.matchedKeys, ['部署', '浏览器'], 'matchedKeys = 命中键字面')
    assert.match(r.rendered, /- \[m1\]（命中: 部署\|浏览器）部署视图文档/, '召回行含命中括注 + 正文全文')
    // 无键条目不命中：正文含「部署」但无 tags/keywords（t=3000）
    store.write(log, { id: 'm3', text: '部署相关的纯文本条目' })
    const r2 = recallMemories(store, '部署', { budgetChars: 100000 })
    assert.deepEqual(r2.hits.map((h) => h.id), ['m2', 'm1'], '匹配键面 = tags ∪ keywords（正文含词≠命中）')
    // 零命中空返回
    const r3 = recallMemories(store, '完全无关的查询串', { budgetChars: 100000 })
    assert.deepEqual(r3, { hits: [], count: 0, totalChars: 0, rendered: '' })
  } finally {
    cleanup()
  }
})

test('S82-10 预算双门：索引超预算 fail-visible / 召回后仍超才拒 / 非法预算 fail-visible', () => {
  const { store, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '部署视图已发版'.repeat(50), tags: ['部署'] })
    // 索引门：一行一记忆超预算
    assert.throws(() => buildMemoryIndex(store, { budgetChars: 30 }), /CAR-E-MEM-BUDGET: 记忆索引超预算/, '索引超预算 fail-visible（最小不可再分面）')
    assert.doesNotThrow(() => buildMemoryIndex(store, { budgetChars: 100000 }))
    // 召回门：命中筛选后仍超
    assert.throws(() => recallMemories(store, '部署', { budgetChars: 50 }), /CAR-E-MEM-BUDGET: 召回注入超预算.*召回后仍超/, '召回后仍超才拒（D-46 修订语义）')
    const ok = recallMemories(store, '部署', { budgetChars: 100000 })
    assert.equal(ok.count, 1)
    // 非法预算
    assert.throws(() => recallMemories(store, '部署', { budgetChars: 0 }), /CAR-E-MEM-BUDGET: 召回预算非法/)
    assert.throws(() => buildMemoryIndex(store, { budgetChars: -1 }), /CAR-E-MEM-BUDGET: 索引预算非法/)
    // query 非字符串显式拒绝
    assert.throws(() => recallMemories(store, 42 as never, { budgetChars: 100 }), /CAR-E-MEM-QUERY/)
  } finally {
    cleanup()
  }
})

test('S82-11 落链形态：meta injection=memory-index/memory-recall + hits + 字符串投影 + EventKind 零新增 + 链完好', () => {
  const { store, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '部署视图已发版', tags: ['部署'], type: 'project' })
    // 宿主装配层接线形态（session-handle 消费批同构——kernel 侧以同 append 形态验证）
    const idx = buildMemoryIndex(store)
    log.append('user', 'system', 'system', idx.rendered, { injection: 'memory-index', count: idx.count, chars: idx.totalChars })
    const rec = recallMemories(store, '看下部署', { budgetChars: 8000 })
    log.append('user', 'system', 'system', rec.rendered, { injection: 'memory-recall', hits: rec.hits, count: rec.count, chars: rec.totalChars })
    // meta 形态（「有据可查」的落链面）
    const systems = log.events.filter((e) => e.kind === 'system')
    const recEv = systems.at(-1)!
    assert.equal((recEv.meta as Record<string, unknown>)['injection'], 'memory-recall')
    assert.deepEqual((recEv.meta as Record<string, unknown>)['hits'], [{ id: 'm1', matchedKeys: ['部署'] }])
    assert.equal(recEv.payload, rec.rendered, '字符串形态 payload（s80 投影前提）')
    // 投影：两条注入行进模型上下文（Model-visible means logged 由构造保证）
    const msgs = log.deriveMessages()
    const sysContents = msgs.filter((m) => m.role === 'system').map((m) => m.content as string)
    assert.ok(sysContents.includes(idx.rendered), '索引行投影')
    assert.ok(sysContents.includes(rec.rendered), '召回行投影')
    // EventKind 零新增：本链 kind 全域恰 = 1.24.3 既有面（buildSession 四事件 + memory/write + 两注入行）
    const kinds = new Set(log.events.map((e) => e.kind))
    assert.deepEqual([...kinds].sort(), ['assistant', 'memory', 'system', 'turnEnd', 'user'], '无新 EventKind（索引/召回行复用 system——eventmap golden 不动前提）')
    assert.equal(log.verifyChain(), null, '链完好（含 memory CRUD + 注入行）')
  } finally {
    cleanup()
  }
})

test('S82-12 legacy 回归：loadMemoryForInjection 行为逐字节不变（D-46 修订不触全量形态）', () => {
  const { store, log, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '正文一', tags: ['t1'] })
    store.write(log, { id: 'm2', text: '正文二' })
    const r = loadMemoryForInjection(store, { budgetChars: 10000 })
    assert.equal(r.count, 2)
    assert.equal(r.rendered, '[CAR 记忆注入] 共 2 条：\n- [m2] 正文二\n- [m1] 正文一', '全量注入拼装形态逐字节（updatedAt 降序）')
    assert.throws(() => loadMemoryForInjection(store, { budgetChars: 10 }), /CAR-E-MEM-BUDGET: 记忆注入超预算/, 'legacy 预算门语义原样（超即拒——「召回后仍超才拒」仅适用于召回形态）')
    assert.throws(() => loadMemoryForInjection(store, { budgetChars: 0 }), /CAR-E-MEM-BUDGET: 注入预算非法/)
  } finally {
    cleanup()
  }
})
