/**
 * 1.15-S1 · K-MEM-1 白盒记忆面（S55，D-46）
 *
 * 覆盖（红线背书优先）：
 *  - 链不可变双断言：CRUD/rollback 前后 verifyChain() 均 null；已落链事件逐字节不变（只追加）
 *  - 审计链同源：memory/write·edit·delete·rollback 事件形态（kind='memory'，actor='user'，
 *    turnId='memory'，payload.type 四态 + before/after 全文——链即版本库）
 *  - rollback 单步时间回退：edit 后回退恢复 before；delete 后回退 undelete；rollback 后再
 *    回退恢复该 rollback 的 before；连续回退逐版本走链；初始版/链外写入 CAR-E-MEM-NOREV
 *  - 投影隔离：memory 事件不进 deriveMessages（model_visible=0——注入走宿主 system ctx 行）；
 *    N1 快照自洽不受 memory 事件影响
 *  - 注入装载：确定性拼装（updatedAt 降序全量——禁静默选择性）；字符近似预算门控
 *    CAR-E-MEM-BUDGET fail-visible 不静默截断；空记忆正常态
 *  - 工作区分片：不同 dir 的 store 互不可见
 *  - fail-visible：NOCHAIN（无会话上下文显式拒绝）/ EXISTS / NOENT / EMPTY / ID 路径穿越
 *  - 零凭据路径：凭据 env 全清前后行为一致（无 env 读取行为断言）
 *  - 兼容线：无 memory 调用时投影与链形态与 1.14.1 逐字节一致（显式对拍）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '../src/session/log.ts'
import { MemoryStore, loadMemoryForInjection } from '../src/memory/store.ts'

function buildSession(): SessionLog {
  const log = new SessionLog('S-s55')
  log.append('user', 'system', 'sys', 'You are CAR.')
  log.append('user', 'user', 'T1', '用户问题 1')
  log.append('model', 'assistant', 'T1', '回答 1')
  log.append('runtime', 'turnEnd', 'T1', null, { reason: 'completed' })
  return log
}

function tmpStore(opts: { now?: () => number } = {}): { store: MemoryStore; dir: string; cleanup: () => void } {
  const dir = join(mkdtempSync(join(tmpdir(), 'car-mem-s55-')), 'memory')
  const store = new MemoryStore(dir, opts)
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ==================== 链不可变（红线） ====================

test('S55-1 红线：CRUD 前后 verifyChain 均 null + 已落链事件逐字节不变（只追加补偿事件）', () => {
  const log = buildSession()
  const { store, cleanup } = tmpStore()
  try {
    const before = log.events.map(e => JSON.stringify(e))
    assert.equal(log.verifyChain(), null)

    store.write(log, { id: 'm1', text: '第一版', tags: ['a'] })
    store.edit(log, 'm1', '第二版')
    store.remove(log, 'm1')
    store.rollback(log, 'm1') // undelete

    assert.equal(log.verifyChain(), null, '全操作序列后链校验仍 PASS')
    const after = log.events.map(e => JSON.stringify(e))
    assert.equal(after.length, before.length + 4, '只新增 4 条 memory 事件（write/edit/delete/rollback）')
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i], before[i], `事件 seq=${i} 逐字节不变`)
    }
    assert.equal(store.get('m1')!.text, '第二版', 'delete 后 rollback = undelete 恢复 delete 前正文（单步回退语义）')
    assert.equal(store.rollback(log, 'm1')!.text, '第一版', '继续回退 → 初始版')
    assert.throws(() => store.rollback(log, 'm1'), /CAR-E-MEM-NOREV/, '栈底唯一无更早状态 → fail-visible')
  } finally {
    cleanup()
  }
})

test('S55-2 事件形态：kind=memory / actor=user / turnId=memory / payload.type 四态 + before-after 全文（链即版本库）', () => {
  const log = buildSession()
  const { store, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: 'v1' })
    store.edit(log, 'm1', 'v2')
    store.remove(log, 'm1')
    store.rollback(log, 'm1')

    const memEvents = log.events.filter(e => e.kind === 'memory')
    assert.equal(memEvents.length, 4)
    assert.deepEqual(
      memEvents.map(e => (e.payload as { type: string }).type),
      ['write', 'edit', 'delete', 'rollback'],
    )
    for (const e of memEvents) {
      assert.equal(e.actor, 'user', 'actor=user（宿主代理用户操作）')
      assert.equal(e.turnId, 'memory', "turnId='memory'（会话级能力面，同 compaction 先例）")
    }
    const [w, ed, del, rb] = memEvents as Array<{ payload: Record<string, unknown> }>
    assert.equal(w.payload.text, 'v1')
    assert.equal(ed.payload.before, 'v1', 'edit 携带 before 全文')
    assert.equal(ed.payload.text, 'v2', 'edit 携带操作后正文（text = after-state 统一口径）')
    assert.equal(del.payload.before, 'v2', 'delete 携带被删正文（rollback 恢复数据源）')
    assert.equal(rb.payload.text, 'v2', 'rollback 携带恢复正文')
    assert.equal(typeof rb.payload.fromSeq, 'number', 'rollback 溯源 fromSeq')
  } finally {
    cleanup()
  }
})

test('S55-3 rollback 单步时间回退：edit 链逐版本走链 + 初始版 CAR-E-MEM-NOREV + 链外写入 CAR-E-MEM-NOREV', () => {
  const log = buildSession()
  const { store, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: 'v1' })
    store.edit(log, 'm1', 'v2')
    store.edit(log, 'm1', 'v3')
    assert.equal(store.get('m1')!.text, 'v3')

    store.rollback(log, 'm1')
    assert.equal(store.get('m1')!.text, 'v2', '第一次回退 → v2')
    store.rollback(log, 'm1')
    assert.equal(store.get('m1')!.text, 'v1', '第二次回退 → v1（逐版本走链）')
    assert.equal(log.verifyChain(), null)
    assert.throws(() => store.rollback(log, 'm1'), /CAR-E-MEM-NOREV/, '初始版无更早状态 → fail-visible')
    assert.equal(store.get('m1')!.text, 'v1', 'NOREV 后条目原样')

    // 链外写入（绕过 CRUD 直写文件）无链上历史 → rollback 拒绝（链即版本库，fail-visible）
    const { store: store2, cleanup: cleanup2 } = tmpStore()
    try {
      store2.write(new SessionLog('S-other'), { id: 'ghost', text: '幽灵' }) // 写在别的链上
      assert.throws(() => store.rollback(log, 'ghost'), /CAR-E-MEM-NOREV/, '本链无该 id 历史 → NOREV（文件在别的 store，get 也不可见——分片隔离兜底）')
      assert.throws(() => store2.rollback(new SessionLog('S-empty'), 'ghost'), /CAR-E-MEM-NOREV/, '换空链 rollback → NOREV（链外写入不可回退，禁静默）')
    } finally {
      cleanup2()
    }
  } finally {
    cleanup()
  }
})

test('S55-4 rollback 穿越删除态：delete 后重建 → 回退到删除态（null）→ 再回退 undelete 初始版', () => {
  const log = buildSession()
  const { store, dir, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: 'v1' })
    store.remove(log, 'm1')
    store.write(log, { id: 'm1', text: 'v2' }) // 删除后同 id 重建（get 不可见 → write 放行）
    assert.equal(store.get('m1')!.text, 'v2')

    const r1 = store.rollback(log, 'm1') // 栈 [v1, absent, v2] → target = absent（删除态）
    assert.equal(r1, null, '回退到删除态返回 null')
    assert.equal(store.get('m1'), undefined, '回退到删除态 = 条目移除')
    assert.equal(existsSync(join(dir, 'm1.json')), false)

    const r2 = store.rollback(log, 'm1') // 栈 [v1, absent] → target = v1（undelete 穿越删除态）
    assert.equal(r2!.text, 'v1', '再回退 undelete 恢复初始版')
    assert.equal(log.verifyChain(), null, '穿越删除态的回退链校验仍 PASS')
    assert.throws(() => store.rollback(log, 'm1'), /CAR-E-MEM-NOREV/, '栈底唯一 → NOREV')
  } finally {
    cleanup()
  }
})

// ==================== 投影隔离（model_visible=0） ====================

test('S55-5 投影隔离：memory 事件不进 deriveMessages + N1 快照自洽 + memory 事件 turnId 不污染 usage 聚合面', () => {
  const log = buildSession()
  const { store, cleanup } = tmpStore()
  try {
    const before = log.deriveMessages()
    store.write(log, { id: 'm1', text: '注入候选记忆' })
    const after = log.deriveMessages()
    assert.deepEqual(after, before, 'memory 事件零投影（投影逐字节不变——model_visible=0）')
    assert.equal(log.verifyChain(), null)

    // N1 自洽：memory 事件 append 前登记的快照投影不受影响
    const snap = log.snapshotModelRequest()
    store.edit(log, 'm1', 'v2')
    assert.equal(log.assertModelVisibleLogged().ok, true, '快照断言 PASS（memory 事件在快照边界后）')
    assert.equal(log.deriveMessages(snap.atSeq).length, before.length, '快照边界投影不含 memory 事件')
  } finally {
    cleanup()
  }
})

// ==================== 注入装载（预算门控） ====================

test('S55-6 注入装载：确定性拼装 updatedAt 降序全量 + 预算门控 CAR-E-MEM-BUDGET 不静默截断 + 空记忆正常态', () => {
  const log = buildSession()
  // 受控时钟（1.15.2 缝）：CI 快 runner 上 write(new) 与 edit(old) 可能同毫秒——updatedAt 相等时
  // 稳定排序保持插入序导致降序断言竞态（linux/macos CI 实证）；时钟注入消除时间精度耦合
  let tick = 0
  const { store, cleanup } = tmpStore({ now: () => ++tick * 1000 })
  try {
    // 空记忆 = 正常态（宿主跳过注入行），非错误
    const empty = loadMemoryForInjection(store, { budgetChars: 1000 })
    assert.deepEqual(empty, { count: 0, totalChars: 0, rendered: '' })

    store.write(log, { id: 'old', text: '旧记忆' })
    store.write(log, { id: 'new', text: '新记忆' })
    store.edit(log, 'old', '旧记忆（已维护）')

    const r1 = loadMemoryForInjection(store, { budgetChars: 100000 })
    assert.equal(r1.count, 2, '全量装入')
    assert.match(r1.rendered, /^\[CAR 记忆注入\] 共 2 条：/)
    assert.ok(r1.rendered.indexOf('[old]') < r1.rendered.indexOf('[new]'), 'updatedAt 降序（最近维护在前——受控时钟下 edit(old) 时间戳 > write(new)）')
    const r2 = loadMemoryForInjection(store, { budgetChars: 100000 })
    assert.equal(r1.rendered, r2.rendered, '确定性拼装（同状态同输出）')

    assert.throws(() => loadMemoryForInjection(store, { budgetChars: 10 }), /CAR-E-MEM-BUDGET/, '超预算 fail-visible')
    assert.equal(r1.totalChars, r1.rendered.length, 'totalChars = rendered 实长（字符近似口径）')
    assert.throws(() => loadMemoryForInjection(store, { budgetChars: 0 }), /CAR-E-MEM-BUDGET/, '非正预算 = 形态拒绝')
    assert.throws(() => loadMemoryForInjection(store, { budgetChars: -5 }), /CAR-E-MEM-BUDGET/)
    assert.throws(() => loadMemoryForInjection(store, undefined as never), /CAR-E-MEM-BUDGET/)
  } finally {
    cleanup()
  }
})

// ==================== 工作区分片 / fail-visible 面 ====================

test('S55-7 工作区分片隔离：不同 dir 的 store 互不可见', () => {
  const log = buildSession()
  const a = tmpStore()
  const b = tmpStore()
  try {
    a.store.write(log, { id: 'only-a', text: 'A 工作区记忆' })
    assert.equal(a.store.get('only-a')!.text, 'A 工作区记忆')
    assert.equal(b.store.get('only-a'), undefined, 'B 分片不可见 A 条目')
    assert.equal(b.store.list().length, 0)
    assert.throws(() => b.store.edit(log, 'only-a', 'x'), /CAR-E-MEM-NOENT/, '跨分片 edit = NOENT（无跨区泄漏）')
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

test('S55-8 fail-visible：NOCHAIN / EXISTS / NOENT / EMPTY / ID 路径穿越', () => {
  const log = buildSession()
  const { store, cleanup } = tmpStore()
  try {
    assert.throws(() => store.write(undefined as never, { text: 'x' }), /CAR-E-MEM-NOCHAIN/, '无会话上下文显式拒绝（D-46 ②）')
    assert.throws(() => store.write(null as never, { text: 'x' }), /CAR-E-MEM-NOCHAIN/)
    assert.throws(() => store.edit({} as never, 'm', 'x'), /CAR-E-MEM-NOCHAIN/)
    assert.throws(() => store.remove({} as never, 'm'), /CAR-E-MEM-NOCHAIN/)
    assert.throws(() => store.rollback({} as never, 'm'), /CAR-E-MEM-NOCHAIN/)

    store.write(log, { id: 'm1', text: 'v1' })
    assert.throws(() => store.write(log, { id: 'm1', text: 'v2' }), /CAR-E-MEM-EXISTS/, 'write 冲突 fail-visible')
    assert.throws(() => store.edit(log, 'nope', 'x'), /CAR-E-MEM-NOENT/)
    assert.throws(() => store.remove(log, 'nope'), /CAR-E-MEM-NOENT/)
    assert.throws(() => store.write(log, { text: '' }), /CAR-E-MEM-EMPTY/, '空正文拒绝')
    assert.throws(() => store.edit(log, 'm1', '   '), /CAR-E-MEM-EMPTY/, '纯空白 = 空')
    for (const bad of ['../evil', 'a/b', '.hidden', '..dots', '']) {
      assert.throws(() => store.write(log, { id: bad, text: 'x' }), /CAR-E-MEM-ID/, `非法 id "${bad}" 拒绝（路径穿越/形态）`)
      assert.throws(() => store.get(bad), /CAR-E-MEM-ID/)
    }
    assert.equal(log.verifyChain(), null, '全部拒绝路径零落链（fail-visible 不产生半包事件）')
  } finally {
    cleanup()
  }
})

// ==================== 零凭据路径 ====================

test('S55-9 零凭据路径：凭据 env 全清前后 CRUD 行为一致（无 env 读取）', () => {
  const log = buildSession()
  const { store, cleanup } = tmpStore()
  const saved = { k: process.env.ANTHROPIC_API_KEY, a: process.env.CAR_ALLOW_ENV_CREDENTIALS, o: process.env.OPENAI_API_KEY }
  try {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CAR_ALLOW_ENV_CREDENTIALS
    delete process.env.OPENAI_API_KEY
    const e1 = store.write(log, { id: 'm1', text: '凭据清零态写入' })
    const r1 = loadMemoryForInjection(store, { budgetChars: 10000 })
    process.env.ANTHROPIC_API_KEY = 'sk-restored-for-behavior-parity'
    process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
    const e2 = store.edit(log, 'm1', '凭据恢复态写入')
    const r2 = loadMemoryForInjection(store, { budgetChars: 10000 })
    assert.equal(e1.text, '凭据清零态写入')
    assert.equal(e2.text, '凭据恢复态写入')
    assert.equal(r1.count, 1)
    assert.equal(r2.count, 1)
    assert.equal(log.verifyChain(), null, '两态下链均完整——CRUD 全程零凭据路径（D-46 零凭据口径行为断言）')
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved.k
    if (saved.a === undefined) delete process.env.CAR_ALLOW_ENV_CREDENTIALS
    else process.env.CAR_ALLOW_ENV_CREDENTIALS = saved.a
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.o
    cleanup()
  }
})

// ==================== 兼容线 / 盘面形态 ====================

test('S55-10 兼容线：无 memory 调用时投影与 1.14.1 逐字节一致 + 盘面白盒形态（逐条 JSON 原子落盘）', () => {
  // 无 memory 调用的日志投影——与 1.14.1 形态显式对拍（无新 kind 时零变化）
  const log = buildSession()
  const expected = [
    { role: 'system', content: 'You are CAR.' },
    { role: 'user', content: '用户问题 1' },
    { role: 'assistant', content: '回答 1' },
  ]
  assert.deepEqual(log.deriveMessages(), expected, '1.14.1 兼容线：投影逐字节一致')
  assert.equal(log.verifyChain(), null)

  const { store, dir, cleanup } = tmpStore()
  try {
    store.write(log, { id: 'm1', text: '白盒正文', tags: ['t1'], sourceSession: 'S-s55' })
    const raw = JSON.parse(readFileSync(join(dir, 'm1.json'), 'utf8')) as Record<string, unknown>
    assert.equal(raw.id, 'm1')
    assert.equal(raw.text, '白盒正文')
    assert.equal(raw.tags?.[0], 't1')
    assert.equal(raw.sourceSession, 'S-s55')
    assert.equal(typeof raw.createdAt, 'number')
    assert.equal(existsSync(join(dir, 'm1.json.tmp')), false, 'rename 原子写无残留 tmp')
    assert.deepEqual(store.list().map(e => e.id), ['m1'], '盘面与 list 一致')
  } finally {
    cleanup()
  }
})
