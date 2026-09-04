/**
 * F12 · secrets 检测（完整版，M2-S7 实装加载期；运行期输出期挂点预留）
 *
 * 口径（M2 安全设计增补 T-6 + D-3 裁决）：
 *  - 模式库 6 类（api-key 前缀族 / 私钥块 / 连接串 / 云凭据 / token-Bearer / 自定义正则）；
 *  - 三层检测降误报：L1 精确前缀（Aho-Corasick 等价的朴素扫描，规模小不构成瓶颈）
 *    → L2 Shannon 熵（≥3.5 才升级候选，排除 'aaaa' 类低熵误报）
 *    → L3 上下文打分（键名共现 +1、代码引号内 +0、注释 -1；总分 ≥2 判命中）；
 *  - 可验证交付（D-3）：漏报率 <1.5%、FPR ≤5%、precision ≥80%——基准集 1:9 正负比、CI 标定；
 *  - 检测不可静默关闭：disable 仅允许显式配置且留痕（本层不提供总开关，红线 §6.3）。
 */

export type SecretCategory = 'api-key' | 'private-key' | 'connection-string' | 'cloud-credential' | 'bearer-token' | 'custom'

export interface SecretPattern { category: SecretCategory; name: string; re: RegExp; /** 键名共现提示 */ keyHints?: string[] }

/** 6 类模式库（v1：30 条精选；自定义正则经 manifest 注入需过安全评审，M3） */
export const PATTERN_LIBRARY: SecretPattern[] = [
  // ── api-key 前缀族 ──
  { category: 'api-key', name: 'OpenAI', re: /sk-[A-Za-z0-9_-]{20,}/g, keyHints: ['openai', 'OPENAI_API_KEY'] },
  { category: 'api-key', name: 'Anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, keyHints: ['anthropic'] },
  { category: 'api-key', name: 'GitHub PAT', re: /gh[pousr]_[A-Za-z0-9]{30,}/g, keyHints: ['github', 'GITHUB_TOKEN'] },
  { category: 'api-key', name: 'Slack', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, keyHints: ['slack'] },
  { category: 'api-key', name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/g, keyHints: ['aws'] },
  { category: 'api-key', name: 'Stripe', re: /[sr]k_(live|test)_[A-Za-z0-9]{20,}/g, keyHints: ['stripe'] },
  { category: 'api-key', name: 'npm', re: /npm_[A-Za-z0-9]{30,}/g, keyHints: ['npm_token'] },
  // ── 私钥块 ──
  { category: 'private-key', name: 'PEM RSA/EC', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { category: 'private-key', name: 'PKCS8', re: /-----BEGIN PRIVATE KEY-----/g },
  { category: 'private-key', name: 'PuTTY PPK', re: /PuTTY-User-Key-File-2:/g },
  // ── 连接串 ──
  { category: 'connection-string', name: 'postgres', re: /postgres(ql)?:\/\/[^:\s"']+:[^@\s"']+@[^\s"']+/g, keyHints: ['database_url'] },
  { category: 'connection-string', name: 'mysql', re: /mysql:\/\/[^:\s"']+:[^@\s"']+@[^\s"']+/g },
  { category: 'connection-string', name: 'mongodb', re: /mongodb(\+srv)?:\/\/[^:\s"']+:[^@\s"']+@[^\s"']+/g, keyHints: ['mongo'] },
  { category: 'connection-string', name: 'redis', re: /redis:\/\/:[^@\s"']+@[^\s"']+/g },
  { category: 'connection-string', name: 'jdbc', re: /jdbc:[a-z0-9]+:\/\/[^:\s"']+:[^@\s"']+@/g },
  // ── 云凭据 ──
  { category: 'cloud-credential', name: 'AWS Secret', re: /aws(.{0,20})?(secret|secretaccesskey)(.{0,10})?[':= ]+[A-Za-z0-9/+=]{40}/gi },
  { category: 'cloud-credential', name: 'GCP service account', re: /"type":\s*"service_account"/g },
  { category: 'cloud-credential', name: 'Azure conn', re: /AccountKey=[A-Za-z0-9+/=]{60,}/g },
  { category: 'cloud-credential', name: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, keyHints: ['token', 'jwt'] },
  // ── token-Bearer ──
  { category: 'bearer-token', name: 'Authorization header', re: /Authorization['":= ]+Bearer\s+[A-Za-z0-9._-]{15,}/gi, keyHints: ['authorization'] },
  { category: 'bearer-token', name: 'api_key kv', re: /['"]?api[_-]?key['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{16,}['"]/gi, keyHints: ['api_key'] },
  { category: 'bearer-token', name: 'secret kv', re: /['"]?(client[_-]?secret|access[_-]?token)['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{12,}['"]/gi },
  { category: 'bearer-token', name: 'password kv', re: /['"]?password['"]?\s*[:=]\s*['"][^\s'"]{8,}['"]/gi },
]

/** Shannon 熵（bit/char） */
export function shannonEntropy(s: string): number {
  if (!s.length) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p) }
  return h
}

export interface ScanHit { category: SecretCategory; name: string; start: number; end: number; /** 命中摘要（全遮蔽，保留首尾 ≤4） */ masked: string; score: number }

const ENTROPY_FLOOR = 3.5

function maskToken(t: string): string {
  if (t.length <= 8) return '*'.repeat(t.length)
  return t.slice(0, 4) + '****' + t.slice(-4)
}

/**
 * 三层检测：前缀命中 → 熵过滤 → 上下文打分。
 * 返回确认命中（score ≥2）；低分候选不返回但可通过 returnCandidates 观察（标定用）。
 */
export function scanSecrets(text: string, opts: { returnCandidates?: boolean } = {}): { hits: ScanHit[]; candidates: ScanHit[] } {
  const hits: ScanHit[] = []
  const candidates: ScanHit[] = []
  for (const p of PATTERN_LIBRARY) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(text)) !== null) {
      const token = m[0]
      // L2 熵过滤：私钥块/连接串结构化模式豁免熵检查；其余需 ≥3.5
      const structured = p.category === 'private-key' || p.category === 'connection-string' || (p.category === 'cloud-credential' && p.name === 'GCP service account')
      const ent = shannonEntropy(token)
      if (!structured && ent < ENTROPY_FLOOR) continue
      // L3 上下文打分：L1 前缀 + L2 熵双过 = 高精度（基础 2）；上下文仅加成/降级
      let score = 2
      const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase()
      if (p.keyHints?.some(h => before.includes(h.toLowerCase()))) score += 1
      if (/\b(const|let|var|return|echo|export)\b/.test(before)) score += 1 // 赋值/输出语境
      if (/^\s*(\/\/|#|\*)/.test(text.slice(0, m.index).split('\n').pop() ?? '')) score -= 1 // 注释行降级
      const hit: ScanHit = { category: p.category, name: p.name, start: m.index, end: m.index + token.length, masked: maskToken(token), score }
      if (score >= 2) hits.push(hit)
      else if (opts.returnCandidates) candidates.push(hit)
      if (m.index === p.re.lastIndex) p.re.lastIndex++ // 防零宽死循环
    }
  }
  hits.sort((a, b) => a.start - b.start)
  return { hits, candidates }
}

/** 脱敏钩子：确认命中全遮蔽后返回新文本（M8 redact 的 F12 升级实现） */
export function redactSecrets(text: string): { text: string; redacted: number } {
  const { hits } = scanSecrets(text)
  let out = ''
  let cursor = 0
  for (const h of hits) {
    out += text.slice(cursor, h.start) + h.masked
    cursor = h.end
  }
  out += text.slice(cursor)
  return { text: out, redacted: hits.length }
}
