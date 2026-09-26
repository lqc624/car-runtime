/**
 * M8 · 脱敏钩子（redact ——《系统设计》§3.2.M8.2 脱敏行 / SQ-07 输出敏感扫描 / O-14）
 *
 * 口径：
 *  - 检测器单一权威：本层只做 M8 面（RedactionResult 形态 + 流式 hold-back），
 *    模式库/三层检测/遮蔽口径全部委托 F12 scanSecrets（security/secrets.ts）——
 *    双实现必然漂移，S15 已确立「回填前强制 redact」先例；
 *  - 遮蔽口径（§3.2.M8.3 字段表）：API Key 形如 sk-****（保留首尾 ≤4 字符）= F12 maskToken；
 *  - 流式扫描（StreamRedactor）：delta 直发会造成跨 chunk 命中逃逸——hold-back 窗口
 *    「从最早疑似锚点起驻留」，命中补齐即遮蔽放行，finishReason 收口时 flush 全量扫描；
 *    结构标记类模式（GCP service_account 等）的匹配起点先于锚点，流式模式不保证完整遮蔽
 *    （登记为流式已知边界；非流式 redact() 为权威口径）。
 */
import { scanSecrets, type ScanHit } from '../security/secrets.ts'

export interface RedactionResult {
  /** 脱敏后文本（§3.2.M8.3 字段表口径：RedactionResult.redacted） */
  redacted: string
  /** 命中遮蔽次数 */
  redactedCount: number
  /** 命中明细（审计留痕用；不含原文） */
  hits: Array<Pick<ScanHit, 'category' | 'name' | 'start' | 'end' | 'masked' | 'score'>>
}

/** 非流式脱敏钩子（§3.2.M8.2：redact(text): RedactionResult，天然幂等） */
export function redact(text: string): RedactionResult {
  const { hits } = scanSecrets(text)
  let out = ''
  let cursor = 0
  for (const h of hits) {
    out += text.slice(cursor, h.start) + h.masked
    cursor = h.end
  }
  out += text.slice(cursor)
  return { redacted: out, redactedCount: hits.length, hits }
}

/**
 * 疑似锚点：所有模式匹配串的起始字面量（大小写不敏感）。
 * 命中检测必然先经过锚点——锚点之后的字节才需要驻留等待命中补齐。
 */
const ANCHOR_RE = /(sk[-_]|gh[pousr]_|xox|akia|rk_|npm_|-----begin|postgres|mysql|mongodb|redis|jdbc:|aws|service_account|accountkey|eyJ|authorization|bearer|api[_-]?key|client[_-]?secret|access[_-]?token|password)/i

/** 无锚点时的尾部驻留长度（≥ 最长锚点 15，防锚点跨 chunk 拼合逃逸） */
const TRAILING_HOLD = 16

/**
 * 流式脱敏器：push() 返回「当前可安全放行」的文本（已遮蔽），flush() 收口全量扫描。
 * 语义：不泄漏（任何已放行字节不可能成为命中的一部分）、不误遮（锚点未补齐成命中时
 * 原文放行）、粒度换正确性（疑似锚点驻留直到命中补齐或 flush——长行含假锚点时
 * 流式粒度退化到收口时点，登记为已接受折衷）。
 */
export class StreamRedactor {
  #pending = ''

  /** 追加 delta，返回可安全放行的文本（可能为空串） */
  push(text: string): string {
    this.#pending += text
    let out = ''
    // 1) 命中补齐：从前往后逐个遮蔽（遮蔽后重扫——遮蔽串不会再命中）
    for (;;) {
      const { hits } = scanSecrets(this.#pending)
      const h = hits[0]
      if (!h) break
      out += this.#pending.slice(0, h.start) + h.masked
      this.#pending = this.#pending.slice(h.end)
    }
    // 2) 无完整命中：从最早疑似锚点起驻留
    const m = ANCHOR_RE.exec(this.#pending)
    if (m && m.index !== undefined) {
      out += this.#pending.slice(0, m.index)
      this.#pending = this.#pending.slice(m.index)
      return out
    }
    // 3) 无锚点：放行除尾部驻留窗外的全部（尾窗防锚点跨 chunk 拼合）
    if (this.#pending.length > TRAILING_HOLD) {
      out += this.#pending.slice(0, this.#pending.length - TRAILING_HOLD)
      this.#pending = this.#pending.slice(-TRAILING_HOLD)
    }
    return out
  }

  /** 收口（finishReason 时点）：全量扫描遮蔽剩余驻留 */
  flush(): string {
    const r = redact(this.#pending)
    this.#pending = ''
    return r.redacted
  }

  /** 已遮蔽计数口径（测试/审计观察面）：flush 前的累计放行不含命中原文 */
  get pendingLength(): number {
    return this.#pending.length
  }
}
