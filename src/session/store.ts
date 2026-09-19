/**
 * C-01 落盘存储层（§3.2.M7.5 Step 1-2 兑现——「先落日志后放行」的物理承载）
 *
 * 口径：
 *  - 单行原子：O_APPEND 句柄上单 write 系统调用写完整一行（事件 JSON + '\n'），杜绝交错与半行交错面；
 *  - fsync 同步刷盘：append 返回 = 该事件已过掉电窗口，kill -9 不丢已返回事件；
 *  - fail-fast：任何写失败向上 throw → 调用方（agent loop）当前 turn 以 error 收口，
 *    禁止继续产生模型可见内容（防不变量破坏，L0 不降级——SessionLog.attachSink 的 throw 传播即此语义）；
 *  - 物理编码恒明文 JSONL（zstd 属归档/导出压缩，见 format.ts 文件头口径）。
 */
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'

export class SessionFileStore {
  #fd: number = -1
  readonly path: string

  constructor(path: string) {
    this.path = path
    this.#fd = openSync(path, 'a')
  }

  /** 唯一写入路径：单 write 原子 + fsync；失败即 throw（fail-fast，事件不入内存） */
  append(line: string): void {
    if (this.#fd < 0) throw new Error(`CAR-E-STORE: store 已关闭（${this.path}）——fail-fast 拒绝续写`)
    const buf = Buffer.from(line.endsWith('\n') ? line : line + '\n', 'utf-8')
    let off = 0
    while (off < buf.length) off += writeSync(this.#fd, buf, off)
    fsyncSync(this.#fd)
  }

  /** 收口关闭（幂等）；关闭后续写 = CAR-E-STORE 拒绝 */
  close(): void {
    if (this.#fd >= 0) {
      const fd = this.#fd
      this.#fd = -1
      closeSync(fd)
    }
  }
}
