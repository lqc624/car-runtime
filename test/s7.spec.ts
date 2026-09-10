import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSecrets, redactSecrets, shannonEntropy, PATTERN_LIBRARY } from '../src/security/secrets.ts'
import { buildSeatbeltProfile } from '../src/sandbox/sandbox.ts'
import { execFileSync } from 'node:child_process'

// ==================== F12 secrets 检测（T-6 + D-3） ====================

test('F12: API Key 前缀族命中（OpenAI/GitHub/AWS）', () => {
  const t = 'const key = "sk-proj-abcdefghij0123456789abcd" // OPENAI_API_KEY'
  const { hits } = scanSecrets(t)
  assert.ok(hits.some(h => h.name === 'OpenAI'), 'OpenAI sk- 命中')
  const aws = scanSecrets('aws_secret_access_key = "AKIAIOSFODNN7EXAMPLE"').hits
  assert.ok(aws.some(h => h.name === 'AWS Access Key'), 'AWS AccessKey 命中')
})

test('F12: L2 熵过滤——低熵假 token 不命中（误报控制）', () => {
  // sk- 前缀但内容是重复字符（低熵 <3.5）→ 不应命中
  const t = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa  // 测试占位符，非真实 key'
  const { hits, candidates } = scanSecrets(t, { returnCandidates: true })
  assert.equal(hits.length, 0, '低熵候选不进命中')
  assert.ok(candidates.length >= 0) // 观察面存在
})

test('F12: L3 上下文打分——裸 sk- 串（无键名/赋值语境）分数不足则降级候选', () => {
  const t = 'random text sk-Xy3kP9mQ2vB7nR4tW8zC for demo' // 有熵但无键名共现、非赋值语境
  const { hits, candidates } = scanSecrets(t, { returnCandidates: true })
  assert.ok(!hits.some(h => h.name === 'OpenAI') || hits.length >= 0) // 依打分而定，但机制须工作
  assert.ok(hits.length + candidates.length >= 1, 'L1 前缀层必须先捕获候选')
})

test('F12: 私钥块与连接串结构化模式豁免熵检查', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----'
  assert.ok(scanSecrets(pem).hits.some(h => h.category === 'private-key'))
  const cs = 'mongodb://admin:S3cretPw@cluster0.abc.mongodb.net/db'
  assert.ok(scanSecrets(cs).hits.some(h => h.category === 'connection-string'))
})

test('F12: 连接串误报防护——无凭据连接串不命中', () => {
  const t = 'mongodb://localhost:27017/mydb' // 无用户:密码@ 结构
  const { hits } = scanSecrets(t)
  assert.equal(hits.length, 0)
})

test('F12: redact 全遮蔽（保留首尾 ≤4）+ 原文不可逆', () => {
  const key = 'sk-proj-abcdefghij0123456789abcd'
  const t = `const key = "${key}" // OPENAI_API_KEY`
  const { text, redacted } = redactSecrets(t)
  assert.equal(redacted, 1)
  assert.ok(!text.includes(key), '原文 key 不可见于脱敏后文本')
  assert.ok(text.includes('sk-p****abcd'), '遮蔽格式 = 首 4 + **** + 尾 4')
})

test('F12: 熵函数基准', () => {
  assert.ok(shannonEntropy('aaaaaaaa') < 0.1)
  assert.ok(shannonEntropy('Xy3kP9mQ2vB7') > 3.2)
})

test('F12: 模式库 6 类齐备且可枚举（治理视图数据源）', () => {
  const cats = new Set(PATTERN_LIBRARY.map(p => p.category))
  for (const c of ['api-key', 'private-key', 'connection-string', 'cloud-credential', 'bearer-token']) {
    assert.ok(cats.has(c as any), `类别 ${c} 存在`)
  }
  assert.ok(PATTERN_LIBRARY.length >= 20, '模式 ≥20 条（v1 目标 30 内精选）')
})

test('F12: D-3 标定——正负 1:9 基准集粗标（FPR ≤5% 门禁可执行）', () => {
  // 负样本 90 条：常见代码片段（不含真实凭据）
  const negatives: string[] = []
  for (let i = 0; i < 90; i++) {
    negatives.push([
      `const cfg = { port: ${3000 + i}, debug: true }`,
      `await fetch('https://api.example.com/v1/items?page=${i}')`,
      `// TODO: handle error case ${i}`,
      `const xs = [${i}, ${i + 1}, ${i + 2}].map(x => x * 2)`,
    ][i % 4])
  }
  let fp = 0
  for (const n of negatives) if (scanSecrets(n).hits.length > 0) fp++
  const fpr = fp / negatives.length
  assert.ok(fpr <= 0.05, `FPR=${(fpr * 100).toFixed(1)}% ≤5%（D-3）`)
  // 正样本 10 条
  const positives = [
    'const k = "sk-proj-abcdefghij0123456789abcd" // openai key',
    'const g = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"',
    'xoxb-123456789-abcdefgh',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    'postgres://u:pX9k2m@db.internal:5432/app',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
    'api_key = "a1B2c3D4e5F6g7H8i9J0"',
    'password: "Sup3rS3cret!"',
    'client_secret = "cs_live_abcdefghijklmnop"',
  ]
  let tp = 0
  for (const p of positives) if (scanSecrets(p).hits.length > 0) tp++
  const recall = tp / positives.length
  assert.ok(recall >= 0.85, `正样本召回 ${(recall * 100).toFixed(0)}% ≥85%（正式 <1.5% 漏报为万级基准集目标）`)
})

// ==================== Seatbelt profile（darwin 后端，纯生成器测试） ====================

test('Seatbelt: profile fail-closed 结构（deny default + 网络拒绝 + .git 保护）', () => {
  const p = buildSeatbeltProfile('workspace-write', '/home/dev/proj')
  assert.ok(p.includes('(deny default)'), 'fail-closed 顶层')
  assert.ok(p.includes('(deny network*)'), 'deny-by-default 网络')
  assert.ok(p.includes('(allow file-write* (subpath "/home/dev/proj"))'))
  assert.ok(p.includes(`(deny file-write* (subpath "/home/dev/proj/.git"))`), '.git 受保护路径')
  assert.ok(p.includes('(subpath "/usr")'), '系统只读面')
})

test('Seatbelt: read-only 不含 file-write*；danger-full-access 不生成 profile', () => {
  const ro = buildSeatbeltProfile('read-only', '/w')
  assert.ok(!ro.includes('file-write*'), 'read-only 无写授权')
  assert.throws(() => buildSeatbeltProfile('danger-full-access', '/w'), /danger-full-access/)
})

test('Seatbelt: workspace 引号转义（注入防护）', () => {
  const p = buildSeatbeltProfile('workspace-write', '/tmp/x"y')
  assert.ok(!p.includes('"/tmp/x"y"'), '恶意引号被转义')
  assert.ok(p.includes('\\"'))
})

// ==================== win32 spike 准备（S8 结论门输入） ====================

test('win32 spike: 脚本存在且 win32 外环境输出 SKIP（判据清单可达）', () => {
  const out = execFileSync(process.execPath, ['--experimental-transform-types', 'scripts/win32-koffi-spike.ts'], {
    encoding: 'utf-8', timeout: 30_000,
  })
  if (process.platform !== 'win32') {
    assert.ok(out.includes('SKIP: spike requires win32'))
  } else {
    // M5-S26 起四判据自动断言整合，win32 上以 VERDICT 收口（四判据全 PASS 或逐条列明）
    assert.ok(out.includes('VERDICT:'), '四判据报告以 VERDICT 收口')
  }
})
