/**
 * S6 验签器（ADR-003 双轨实装）：minisign 离线轨（node:crypto ed25519）+ Sigstore 接口预留
 *
 * fail-closed 分级（D-2 裁决）：
 *  - 校验失败（有签名但不对）= 硬拒绝，不可配置放行
 *  - 签名缺失 = warn 模式告警放行（manifestHash 兜底）→ enforce 模式硬拒绝
 *  - Sigstore 轨不可达 = 回退静态轨；双轨皆败按缺失处理
 */
import { verify, createPublicKey } from 'node:crypto'

export interface SignatureBundle {
  /** minisign 式离线轨：对 manifestHash 的 ed25519 签名（base64） */
  minisig?: string
  /** Sigstore keyless 主轨：离线 bundle（S6 接口预留——bundle 校验需生态依赖，M3/沙箱外实装） */
  sigstoreBundle?: string
}

export interface VerifyResult { ok: boolean; track: 'minisign' | 'sigstore' | 'none'; error?: string }

export interface VerifierDeps {
  /** 信任锚公钥（ed25519，base64；内置根 pinning 或 trustRoot 替换点） */
  trustRootPublicKey: string
  /** D-2：S6-S9 = warn，S10 起 = enforce */
  mode: 'warn' | 'enforce'
  /** Sigstore 主轨探针（骨架期返回 false → 回退静态轨，复现 ADR-003 回退语义） */
  sigstoreAvailable?: () => boolean
}

/** 静态轨：ed25519 验证 manifestHash 签名 */
export function verifyMinisig(manifestHash: string, minisig: string, trustRootPublicKey: string): { ok: boolean; error?: string } {
  try {
    const key = createPublicKey({ key: Buffer.from(trustRootPublicKey, 'base64'), format: 'der', type: 'spki' })
    const ok = verify(null, Buffer.from(manifestHash), key, Buffer.from(minisig, 'base64'))
    return ok ? { ok: true } : { ok: false, error: 'signature mismatch' }
  } catch (e) {
    return { ok: false, error: `verify error: ${String(e)}` }
  }
}

/**
 * 验签入口（装载前调用，A010001 之前的供应链第一道门）：
 * 返回 { allowed, warning? }——warning 非空时调用方必须告警放行并留痕（enforce 前过渡期）
 */
export function enforceSignature(manifestHash: string, sig: SignatureBundle | undefined, deps: VerifierDeps, onCount?: (name: 'car_unsigned_confirmed', labels: { confirmed: 'yes' | 'no' }) => void): { allowed: boolean; warning?: string; error?: string } {
  // 主轨探针：可用则先走 Sigstore（S6 骨架期默认不可用 → 回退静态轨）
  if (deps.sigstoreAvailable?.()) {
    if (sig?.sigstoreBundle) {
      // bundle 校验需生态依赖（@sigstore/verify），骨架期视为不可达 → 回退静态轨（ADR-003 回退语义）
    } else if (deps.mode === 'enforce') {
      return { allowed: false, error: 'CAR-E-SIG: sigstore bundle missing (enforce mode)' }
    }
  }
  // 静态轨
  if (sig?.minisig) {
    const r = verifyMinisig(manifestHash, sig.minisig, deps.trustRootPublicKey)
    if (r.ok) return { allowed: true }
    // 有签名但校验失败 = 硬拒绝（不可配置放行——ADR-003 fail-closed 第一级）
    return { allowed: false, error: `CAR-E-SIG: signature verification FAILED: ${r.error}（不可配置放行）` }
  }
  // 签名缺失
  if (deps.mode === 'enforce') {
    return { allowed: false, error: 'CAR-E-SIG: signature missing (enforce mode)——manifestHash 指纹兜底不替代签名' }
  }
  // S17 采集面：unsigned 路径计数（零内容 labels；confirmed=no=未确认 warn / yes=显式确认豁免动作）
  onCount?.('car_unsigned_confirmed', { confirmed: 'no' })
  return { allowed: true, warning: 'CAR-W-SIG: unsigned plugin（warn 过渡期放行，manifestHash 指纹兜底；enforce 切换见 D-2 终局条件）' }
}
