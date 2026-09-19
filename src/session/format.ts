/**
 * 会话日志格式层（§3.2.M7.1 第 4 点——M7 存储增强选项落地）
 *
 * 口径（dsh format.ts:210-240 源码级已核实，对齐其「可选 zstd + 撕裂尾截断容错」语义）：
 *  - 三种读取失败语义互斥可判：
 *      撕裂尾 = 末尾无换行的残留（崩溃半行）→ 显式丢弃并报告（不静默、不算断链、不算格式错误）；
 *      格式错误 = 完整行 JSON 解析失败 → CAR-E-FORMAT 拒绝装载（防带病日志静默收缩）；
 *      断链     = 完整行哈希不连续 → brokenAt（既有语义不变，loadSessionLog 返回）。
 *  - 物理编码 layout-blind：按 zstd magic bytes 嗅探解码，读取方不感知 .jsonl / .jsonl.zstd；
 *    zstd 能力随 Node 版本漂移（22.15+ 需 --experimental-zstd / 23.8+ 原生），不可用 = 显式报错非静默。
 *  - 运行时热路径恒为明文 append + fsync（fail-fast 优先，见 store.ts）；zstd 定位 = 归档/导出压缩。
 */
import * as zlib from 'node:zlib'

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** zstd 编解码能力探测（版本碎片显式化：CI 22.19 经 NODE_OPTIONS 打开，23.8+ 原生） */
export function zstdAvailable(): boolean {
  return typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'
}

function requireZstd(): void {
  if (!zstdAvailable()) {
    throw new Error('CAR-E-ZSTD: 当前 Node 无 zstd 编解码能力（22.15+ 需 --experimental-zstd，23.8+ 原生）——显式拒绝，不静默降级')
  }
}

/** 全量压缩（单 frame；取证包/归档全量口径，append 热路径不用——见文件头口径） */
export function compressJsonlZstd(text: string): Buffer {
  requireZstd()
  return zlib.zstdCompressSync!(Buffer.from(text, 'utf-8'))
}

/** 物理解码：按 magic 嗅探，读取方不感知文件后缀（layout-blind） */
export function decodeLogBuffer(buf: Buffer): { text: string; encoding: 'plain' | 'zstd' } {
  if (buf.length >= ZSTD_MAGIC.length && buf.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
    requireZstd()
    return { text: zlib.zstdDecompressSync!(buf).toString('utf-8'), encoding: 'zstd' }
  }
  return { text: buf.toString('utf-8'), encoding: 'plain' }
}

export interface SplitJsonlResult {
  lines: string[]
  tornTail: boolean
  tornTailBytes: number
}

/**
 * 撕裂尾切分：写入方契约 = 每事件一行且行尾 '\n'（store.ts 单 write 原子）。
 * 末段无 '\n' 结尾 = 撕裂尾（崩溃半行），无论其内容是否恰为合法 JSON——显式格式校验语义，
 * 统一按「写入方契约未达成」处理，丢弃并报告字节数。
 */
export function splitJsonlLines(text: string): SplitJsonlResult {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const parts = body.split('\n')
  const tornTail = !text.endsWith('\n') && parts[parts.length - 1] !== ''
  const tail = tornTail ? parts.pop()! : ''
  const lines = parts.filter(l => l.trim() !== '')
  return { lines, tornTail, tornTailBytes: tornTail ? Buffer.byteLength(tail, 'utf-8') : 0 }
}
