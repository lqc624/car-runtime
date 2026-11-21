/**
 * 1.27.0 · Q-D1 第二步 E-2（D-QD1-3）：OutputLedger——REPL 打印流字节预算
 *
 * 口径（DSH 输出账本 CAR 化）：
 *  - 文本/字节共享单预算（maxPrintedBytes，缺省 64KB——PtcBudget.maxPrintedBytes 收敛同 fail-closed）；
 *  - 超限 = 保留可容纳前缀 + 显式 truncated 标注，**绝不静默截断**（字节边界不劈代理对——
 *    回退到最近完整 UTF-8 序列边界）；
 *  - 审计同源核验（D-QD1-3）：ledger 快照 = REPL 结果面 printed = 模型实见内容——Model-visible ≡ logged。
 */
export class OutputLedger {
  #buf = ''
  #bytes = 0
  #truncated = false
  readonly #max: number

  constructor(maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error(`CAR-E-PTC-REPL: maxPrintedBytes 非法（${String(maxBytes)}）——须为正数`)
    this.#max = maxBytes
  }

  get limit(): number {
    return this.#max
  }

  get truncated(): boolean {
    return this.#truncated
  }

  get bytes(): number {
    return this.#bytes
  }

  /** 追加打印流——超限截到可容纳前缀（UTF-8 完整序列边界）+ truncated 标注（禁静默：截断必可见） */
  append(text: string): void {
    if (this.#truncated) return
    const remaining = this.#max - this.#bytes
    if (remaining <= 0) {
      this.#truncated = true
      return
    }
    const buf = Buffer.from(text, 'utf8')
    if (buf.length <= remaining) {
      this.#buf += text
      this.#bytes += buf.length
      return
    }
    // 截到可容纳前缀——回退 UTF-8 完整序列边界（不劈代理对/多字节字符）
    let cut = remaining
    while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut-- // 续字节（10xxxxxx）回退
    this.#buf += buf.subarray(0, cut).toString('utf8')
    this.#bytes += cut
    this.#truncated = true
  }

  snapshot(): { text: string; bytes: number; truncated: boolean; limit: number } {
    return { text: this.#buf, bytes: this.#bytes, truncated: this.#truncated, limit: this.#max }
  }
}
