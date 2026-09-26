/**
 * M5-S28 · 装载签名门（sigGate）：verifier 的装载接线层（fs 层；verifier 保持纯验签、无 I/O）
 *
 * 口径：
 *  - 被签物锚定：manifestHash = sha256(插件入口 .ts 文件裸字节) 的 hex 串。manifest 是运行时对象
 *    （parse 阶段 import() 后才存在），无独立 manifest 文件字节可签——对入口文件整字节求哈希
 *    同时覆盖 manifest 声明与全部代码，即宽限文本承诺的「manifestHash 指纹」。被签消息 =
 *    hex 字符串的 UTF-8 字节（verifyMinisig Buffer.from(manifestHash) 口径；registry-e2e
 *    run-e2e.ts「对制品原始字节求 sha256 再签 hex 串」先例同源）。哈希对裸字节求
 *    （release-pipeline G-11 教训：禁止对编码文本求哈希）。
 *  - 签名载体：sidecar `<file>.minisig`（ed25519 签名 base64，唯一实装轨）；sigstore 主轨
 *    维持 verifier 骨架期预留（SignatureBundle.sigstoreBundle），sidecar 命名随主轨实装再登记。
 *  - 门禁语义（ADR-003 / DEC-1 ②，2026-09-26 裁决）：缺省 mode=warn——缺签=横幅放行+指纹兜底
 *    +计数 confirmed=no；mode=enforce——缺签硬拒绝；有签名但验签失败=硬拒绝（不可配置放行，
 *    unsignedAllow 亦不豁免）。
 *  - unsignedAllow（S20 §4 路径②：workspace 显式声明豁免）：仅作用于 warn 缺签路径——
 *    计数改写 confirmed=yes（S20 §1 口径：yes=显式确认豁免动作后），横幅保留不消失。
 *  - 信任根交付：CAR_TRUST_ROOT env（ed25519 spki，base64）或显式入参。缺省无信任根 =
 *    全部插件按 unsigned 处理（warn 下横幅显式可见；enforce 下全部拒绝属 fail-closed，非静默）。
 *  - 计数桥：onCount 采用 metrics.ts 宽签名（CounterName）；对 verifier 的窄回调参数做
 *    适配包装（宽回调不能直接赋给 verifier 的窄参数位——strictFunctionTypes 逆变）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { enforceSignature, type VerifierDeps } from './verifier.ts'
import type { AllowedLabels, CounterName } from '../telemetry/metrics.ts'

export interface SignatureGateOptions {
  /** 缺省 'warn'（DEC-1 ②：1.0 以 warn 发布，宽限期到期翻转为 enforce = 计划内默认值变更） */
  mode?: 'warn' | 'enforce'
  /** 信任锚公钥（ed25519 spki base64）；缺省走 CAR_TRUST_ROOT env，无则全部按 unsigned 处理 */
  trustRootPublicKey?: string
  /** S20 §4 路径②：显式声明豁免（workspace 生效；warn 缺签路径计数 confirmed=yes，横幅保留） */
  unsignedAllow?: boolean
  /** 零内容计数桥（metrics.ts Counters.onCount 兼容；labels 仅枚举，禁路径/内容） */
  onCount?: (name: CounterName, labels?: AllowedLabels) => void
}

export interface SigGateResult {
  allowed: boolean
  warning?: string
  error?: string
  /** 入口文件裸字节 sha256 hex（读取失败时缺省）——横幅指纹与审计留痕用 */
  manifestHash?: string
}

/** env 配置通道（与 CAR_OFFLINE/CAR_REGISTRY_URL 同为先例）：CAR_SIG_ENFORCE/CAR_TRUST_ROOT/CAR_UNSIGNED_ALLOW */
export function gateDepsFromEnv(env: NodeJS.ProcessEnv = process.env): SignatureGateOptions {
  return {
    mode: env.CAR_SIG_ENFORCE === '1' ? 'enforce' : 'warn',
    trustRootPublicKey: env.CAR_TRUST_ROOT || undefined,
    unsignedAllow: env.CAR_UNSIGNED_ALLOW === '1',
  }
}

/** 单插件文件签名门：读文件算指纹 → 读 sidecar → verifier 判定（装载前三段第一道，先于任何模块执行） */
export function verifyPluginFile(file: string, opts: SignatureGateOptions = {}): SigGateResult {
  let manifestHash: string
  try {
    manifestHash = createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (e) {
    return { allowed: false, error: `CAR-E-SIG: plugin file unreadable — ${(e as Error).message}` }
  }
  let minisig: string | undefined
  const sidecar = `${file}.minisig`
  if (existsSync(sidecar)) {
    try {
      const raw = readFileSync(sidecar, 'utf-8').trim()
      if (raw) minisig = raw
    } catch (e) {
      // sidecar 存在但不可读 = 环境失败，fail-closed 显式拒绝（不静默降级为 unsigned）
      return { allowed: false, manifestHash, error: `CAR-E-SIG: sidecar unreadable — ${(e as Error).message}` }
    }
  }
  // 显式豁免改写：S20 §1 confirmed=yes = 显式确认豁免动作后（仅 warn 缺签路径会被 verifier 计数）
  const onCount = opts.unsignedAllow
    ? (name: 'car_unsigned_confirmed', labels: { confirmed: 'yes' | 'no' }) => opts.onCount?.(name, { ...labels, confirmed: 'yes' })
    : (name: 'car_unsigned_confirmed', labels: { confirmed: 'yes' | 'no' }) => opts.onCount?.(name, labels)
  const deps: VerifierDeps = {
    trustRootPublicKey: opts.trustRootPublicKey ?? '',
    mode: opts.mode ?? 'warn',
  }
  const r = enforceSignature(manifestHash, minisig ? { minisig } : undefined, deps, onCount)
  // 横幅附指纹前缀：宽限文本承诺的「manifestHash 指纹兜底」在告警面可见（前 12 hex 位）
  const warning = r.warning ? `${r.warning} [fp:${manifestHash.slice(0, 12)}]` : undefined
  return { allowed: r.allowed, warning, error: r.error, manifestHash }
}
