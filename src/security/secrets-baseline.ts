/**
 * E-5 · 万级 secrets 基准集（M2 退出标准 #4 落地；D-3 可验证交付）
 *
 * 口径（M2 安全设计增补 D-3）：基准集 1:9 正负比 = 1000 正 + 9000 负；
 * 判据：漏报率 <1.5%、FPR ≤5%、precision ≥80%。
 * 生成确定性（mulberry32 固定种子）——同版本代码跑出的结果可复现、可 diff。
 *
 * 负样本四类对抗面（逐类映射三层检测的一个防误报机制）：
 *   N1 泛良性（无 L1 前缀交叠，纯稀释面）
 *   N2 低熵/占位前缀近似（测 L2 熵过滤：sk-/ghp_/AKIA/AWS/AccountKey 等后接低熵或占位串）
 *   N3 注释行无键名真形（测 L3 注释降级；「注释+键名」按 D-3 设计语义 2+1-1=2 应命中，不属负样本）
 *   N4 文档风连接串占位值（结构化模式无熵过滤——已知 FP 高危族，如实计量）
 *   N5 低熵 kv（password/api_key 后接弱值）
 *
 * 红线：不输出任何样本原文；报告只含计数与聚合指标。
 */

import { scanSecrets } from './secrets.ts'

// ── 确定性 RNG（mulberry32） ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER36 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const B64CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function randFrom(rnd: () => number, alphabet: string, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]
  return s
}
const randAlnum = (rnd: () => number, n: number) => randFrom(rnd, ALNUM, n)
const randB64 = (rnd: () => number, n: number) => randFrom(rnd, B64CH, n)

/** 不放回采样（n ≤ |alphabet|）：全异字符 → 经验熵 = log2(n)，稳定越过 L2 硬门槛 */
function sampleDistinct(rnd: () => number, alphabet: string, n: number): string {
  const pool = alphabet.split('')
  let s = ''
  for (let i = 0; i < n; i++) s += pool.splice(Math.floor(rnd() * pool.length), 1)[0]
  return s
}

export interface BaselineSample { label: 'pos' | 'neg'; cls: string; text: string }

// ── 正样本生成器（25 族 × 40 = 1000；语境为赋值/配置，非注释） ──
type PosMaker = (rnd: () => number) => string

const POS_MAKERS: Array<[string, PosMaker]> = [
  ['openai', r => `const OPENAI_API_KEY = "sk-${randAlnum(r, 45)}"`],
  ['anthropic', r => `anthropic_key: "sk-ant-${randAlnum(r, 45)}"`],
  ['github-pat', r => `GITHUB_TOKEN=ghp_${randAlnum(r, 36)}`],
  ['slack', r => `SLACK_BOT_TOKEN=xoxb-${randAlnum(r, 12)}-${randAlnum(r, 12)}`],
  ['aws-akia', r => `aws_access_key_id = AKIA${sampleDistinct(r, UPPER36, 16)}`],
  ['stripe', r => `stripe.secret_key = "sk_live_${randAlnum(r, 24)}"`],
  ['npm', r => `npm_token: npm_${randAlnum(r, 32)}`],
  ['pem-rsa', r => `-----BEGIN RSA PRIVATE KEY-----\n${randB64(r, 64)}\n${randB64(r, 64)}\n-----END RSA PRIVATE KEY-----`],
  ['pem-ec', r => `-----BEGIN EC PRIVATE KEY-----\n${randB64(r, 64)}\n-----END EC PRIVATE KEY-----`],
  ['pem-openssh', r => `-----BEGIN OPENSSH PRIVATE KEY-----\n${randB64(r, 64)}\n-----END OPENSSH PRIVATE KEY-----`],
  ['pem-pkcs8', r => `-----BEGIN PRIVATE KEY-----\n${randB64(r, 64)}\n-----END PRIVATE KEY-----`],
  ['putty-ppk', r => `PuTTY-User-Key-File-2: ssh-rsa\nEncryption: aes256-cbc\nComment: ${randAlnum(r, 8)}-key`],
  ['conn-postgres', r => `DATABASE_URL=postgresql://app_svc:${randAlnum(r, 20)}@db.internal:5432/prod`],
  ['conn-mysql', r => `mysql://root:${randAlnum(r, 18)}@127.0.0.1:3306/app`],
  ['conn-mongo', r => `MONGO_URI=mongodb+srv://svc:${randAlnum(r, 22)}@cluster0.mongodb.net/db`],
  ['conn-redis', r => `REDIS_URL=redis://:${randAlnum(r, 24)}@cache.internal:6379`],
  ['conn-jdbc', r => `jdbc:mysql://svc:${randAlnum(r, 20)}@db.internal:3306/core`],
  ['aws-secret', r => `aws_secret_access_key = ${randB64(r, 40)}`],
  ['gcp-sa', r => `{"type": "service_account", "project_id": "proj-${randAlnum(r, 6)}", "private_key": "-----BEGIN PRIVATE KEY-----"}`],
  ['azure-conn', r => `DefaultEndpointsProtocol=https;AccountName=st01;AccountKey=${randB64(r, 88)}`],
  ['jwt', r => `token=${'eyJ' + randAlnum(r, 30)}.${'eyJ' + randAlnum(r, 30)}.${randAlnum(r, 43)}`],
  ['bearer', r => `fetch(url, { headers: { Authorization: 'Bearer ${randAlnum(r, 32)}' } })`],
  ['api-key-kv', r => `api_key: "${sampleDistinct(r, ALNUM, 20)}"`],
  ['client-secret-kv', r => `"client_secret": "${sampleDistinct(r, ALNUM, 16)}"`],
  ['password-kv', r => `password = "${sampleDistinct(r, ALNUM, 24)}"`],
]

export function genPositives(n: number, seed = 20260918): BaselineSample[] {
  const rnd = mulberry32(seed)
  const out: BaselineSample[] = []
  const per = Math.floor(n / POS_MAKERS.length)
  for (const [cls, maker] of POS_MAKERS) {
    for (let i = 0; i < per; i++) out.push({ label: 'pos', cls, text: maker(rnd) })
  }
  for (let i = 0; out.length < n; i++) out.push({ label: 'pos', cls: POS_MAKERS[0][0], text: POS_MAKERS[0][1](rnd) })
  return out
}

// ── 负样本生成器（四类对抗面） ──
type NegMaker = { cls: string; make: (r: () => number) => string }

const NEG_MAKERS: NegMaker[] = [
  // N1 泛良性（无 L1 交叠）
  { cls: 'N1-generic', make: r => `const id = "${randAlnum(r, 8)}-${randAlnum(r, 4)}"; // internal ref` },
  { cls: 'N1-uuid', make: r => `${randAlnum(r, 8)}-${randAlnum(r, 4)}-4${randAlnum(r, 3)}-a${randAlnum(r, 3)}-${randAlnum(r, 12)}` },
  { cls: 'N1-sha', make: r => `commit ${randFrom(r, '0123456789abcdef', 40)}` },
  { cls: 'N1-b64img', make: r => `data:image/png;base64,${randB64(r, 60)}` },
  { cls: 'N1-url', make: r => `https://registry.example.com/@scope/pkg/-/pkg-1.${Math.floor(r() * 9)}.${Math.floor(r() * 9)}.tgz` },
  { cls: 'N1-config', make: r => `max_retries=${Math.floor(r() * 9)}\ntimeout_ms=${Math.floor(r() * 9000)}\nregion=cn-north-1` },
  // N2 低熵/占位前缀近似（L2 应过滤）
  { cls: 'N2-lowent-openai', make: () => `const K = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"` },
  { cls: 'N2-lowent-ghp', make: () => `GITHUB_TOKEN=ghp_1234123412341234123412341234123412` },
  { cls: 'N2-lowent-npm', make: () => `npm_token: npm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` },
  { cls: 'N2-lowent-slack', make: () => `SLACK_TOKEN=xoxb-0000000000-0000000000` },
  { cls: 'N2-lowent-akia', make: () => `aws_access_key_id = AKIA0123012301230123` },
  { cls: 'N2-lowent-awssecret', make: () => `aws_secret_access_key = ${'1234567890'.repeat(4)}` },
  { cls: 'N2-lowent-azure', make: () => `AccountKey=${'A'.repeat(80)}` },
  { cls: 'N2-lowent-stripe', make: () => `stripe_key = "sk_live_test0000000000000000000"` },
  { cls: 'N2-placeholder', make: () => `openai.api_key = "sk-your-key-here-xxxxxxxxxxxx"` },
  // N3 注释行无键名真形（L3 注释降级应压到 1 → 仅候选）
  { cls: 'N3-comment-token1', make: r => `// sk-${randAlnum(r, 45)}` },
  { cls: 'N3-comment-token2', make: r => `# ghp_${randAlnum(r, 36)}` },
  { cls: 'N3-comment-token3', make: r => `* xoxb-${randAlnum(r, 12)}-${randAlnum(r, 12)}` },
  { cls: 'N3-comment-token4', make: r => `// redis://:${randAlnum(r, 16)}@cache.internal:6379` },
  // N4 文档风连接串占位值（结构化模式无熵过滤——FP 高危族，如实计量）
  { cls: 'N4-docs-pg', make: () => `postgres://user:password@localhost:5432/mydb` },
  { cls: 'N4-docs-pg2', make: () => `postgresql://demo:demo@db.example.com/demo` },
  { cls: 'N4-docs-mysql', make: () => `mysql://root:changeme@127.0.0.1:3306/app` },
  { cls: 'N4-docs-mongo', make: () => `mongodb://admin:example@cluster0.sample.mongodb.net/test` },
  { cls: 'N4-docs-redis', make: () => `redis://:default@localhost:6379/0` },
  { cls: 'N4-docs-jdbc', make: () => `jdbc:mysql://dev:pass@db.local:3306/sample` },
  // N5 低熵 kv（L2 应过滤）
  { cls: 'N5-lowent-password', make: () => `password = "12345678"` },
  { cls: 'N5-lowent-password2', make: () => `password: "abcd1234"` },
  { cls: 'N5-lowent-apikey', make: () => `api_key: "aaaaaaaaaaaaaaaa"` },
  { cls: 'N5-empty-secret', make: () => `client_secret: ""` },
  { cls: 'N5-short-token', make: () => `access_token: "tok_123"` },
]

export function genNegatives(n: number, seed = 20260919): BaselineSample[] {
  const rnd = mulberry32(seed)
  const out: BaselineSample[] = []
  // 权重：N1 30% / N2 20% / N3 7% / N4 13% / N5 30%（N4≈1170 条如实暴露占位连接串 FP 面）
  const weights: Record<string, number> = { N1: 0.30, N2: 0.20, N3: 0.07, N4: 0.13, N5: 0.30 }
  const bucketTarget = Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, Math.round(w * n)]))
  let i = 0
  while (out.length < n) {
    const m = NEG_MAKERS[i % NEG_MAKERS.length]
    const bucket = m.cls.split('-')[0]
    if ((bucketTarget[bucket] ?? 0) > 0 || out.length + NEG_MAKERS.length >= n) {
      out.push({ label: 'neg', cls: m.cls, text: m.make(rnd) })
      if (bucketTarget[bucket] !== undefined) bucketTarget[bucket]--
    }
    i++
  }
  return out
}

// ── 度量 ──
export interface BaselineResult {
  posTotal: number; negTotal: number
  tp: number; fn: number; fp: number; tn: number
  missRate: number      // 漏报率 = FN/pos
  fpr: number           // FPR = FP/neg
  precision: number     // TP/(TP+FP)
  fpByClass: Record<string, number>
  missByClass: Record<string, number>
  criteria: { missRateLt: number; fprLe: number; precisionGe: number }
  pass: boolean
}

export function runBaseline(posN = 1000, negN = 9000): BaselineResult {
  const pos = genPositives(posN)
  const neg = genNegatives(negN)
  let tp = 0, fn = 0, fp = 0, tn = 0
  const fpByClass: Record<string, number> = {}
  const missByClass: Record<string, number> = {}
  for (const s of pos) {
    const { hits } = scanSecrets(s.text)
    if (hits.length > 0) tp++; else { fn++; missByClass[s.cls] = (missByClass[s.cls] ?? 0) + 1 }
  }
  for (const s of neg) {
    const { hits } = scanSecrets(s.text)
    if (hits.length > 0) { fp++; fpByClass[s.cls] = (fpByClass[s.cls] ?? 0) + 1 } else tn++
  }
  const missRate = fn / pos.length
  const fpr = fp / neg.length
  const precision = tp / Math.max(1, tp + fp)
  const pass = missRate < 0.015 && fpr <= 0.05 && precision >= 0.80
  return {
    posTotal: pos.length, negTotal: neg.length, tp, fn, fp, tn,
    missRate, fpr, precision, fpByClass, missByClass,
    criteria: { missRateLt: 0.015, fprLe: 0.05, precisionGe: 0.80 }, pass,
  }
}
