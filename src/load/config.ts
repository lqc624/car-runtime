/**
 * 1.1-S3 · 签名配置文件通道（sandbox.* 键位空间；部署设计 §4.5.5 载体落地）
 *
 * 口径：
 *  - 载体 = car.config.json（D-11a ①，2026-09-27 裁决：零依赖 / 免代码求值 / fail-visible 简单；
 *    系统设计 §3.2 的 car.config.ts + zod configLoader 完整形态登记后续，届时迁移并保持键位兼容）
 *  - 键位空间（嵌套 JSON 渲染点分键名）：
 *      sandbox.unsigned.allow  （部署设计 §4.5.5 冻结键；= CAR_UNSIGNED_ALLOW 等价通道）
 *      sandbox.sig.enforce     （= CAR_SIG_ENFORCE）
 *      sandbox.sig.trustRoot   （= CAR_TRUST_ROOT；ed25519 公钥非凭据——CR-05「凭据禁入配置明文」不破）
 *    未登记键 / 类型错 / 坏 JSON 一律 CAR-E-CONFIG 显式拒绝（fail-visible，禁静默忽略——
 *    防拼写漂移导致的「配置写了但不生效」）
 *  - 优先级（1.1 规划 §3 S3）：flag > env > 配置文件 > 缺省。env 已定义即为显式意见
 *    （CAR_SIG_ENFORCE 非 '1' = 显式 warn，可压过配置 enforce；未定义才落到配置层）。
 *    无配置文件 + 无 env 时行为与 1.0 完全一致（warn / 无信任根 / 不豁免）。
 *  - 本模块只读配置与合并优先级；门禁判定在 sigGate/verifier。发现序：显式路径 > cwd car.config.json。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { SignatureGateOptions } from './sigGate.ts'

export const CONFIG_FILENAME = 'car.config.json'

export interface SandboxSigConfig {
  unsignedAllow?: boolean
  sigEnforce?: boolean
  sigTrustRoot?: string
}

export interface CarConfig {
  sandbox?: SandboxSigConfig
}

export interface ConfigLoadResult {
  /** 实际读取的配置文件路径（cwd 未发现时缺省——未发现是正常态非错误） */
  path?: string
  config: CarConfig
  /** fail-visible：显式路径不存在 / 坏 JSON / 未登记键 / 类型错的原因（非空 = 调用方必须中止） */
  error?: string
}

/** 加载配置：显式路径（必须存在，否则报错）或 cwd 发现（未发现 = 正常态返回空配置） */
export function loadCarConfig(opts: { explicitPath?: string; cwd?: string } = {}): ConfigLoadResult {
  let path: string | undefined
  if (opts.explicitPath) {
    path = isAbsolute(opts.explicitPath) ? opts.explicitPath : join(opts.cwd ?? process.cwd(), opts.explicitPath)
    if (!existsSync(path)) {
      return { path, config: {}, error: `CAR-E-CONFIG: 配置文件不存在：${path}（--config 显式指定的路径必须存在）` }
    }
  } else {
    path = join(opts.cwd ?? process.cwd(), CONFIG_FILENAME)
    if (!existsSync(path)) return { config: {} }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    return { path, config: {}, error: `CAR-E-CONFIG: 配置文件解析失败（${(e as Error).message}）——坏 JSON 显式拒绝，不静默忽略` }
  }
  const v = validate(raw)
  return v.error ? { path, config: {}, error: v.error } : { path, config: v.config }
}

/** 手写校验（fail-visible；零依赖红线——不引 zod，D-11a ①） */
function validate(raw: unknown): { config: CarConfig; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: {}, error: 'CAR-E-CONFIG: 配置顶层必须为 JSON 对象' }
  }
  const out: CarConfig = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== 'sandbox') {
      return { config: {}, error: `CAR-E-CONFIG: 未知顶层键 "${k}"（1.1 登记键位空间仅 sandbox.*）` }
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { config: {}, error: 'CAR-E-CONFIG: sandbox 必须为对象' }
    }
    const sb: SandboxSigConfig = {}
    for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
      if (sk === 'unsigned') {
        if (typeof sv !== 'object' || sv === null || Array.isArray(sv)) return { config: {}, error: 'CAR-E-CONFIG: sandbox.unsigned 必须为对象' }
        for (const [uk, uv] of Object.entries(sv as Record<string, unknown>)) {
          if (uk !== 'allow') return { config: {}, error: `CAR-E-CONFIG: 未知键 sandbox.unsigned.${uk}（登记键位：sandbox.unsigned.allow）` }
          if (typeof uv !== 'boolean') return { config: {}, error: 'CAR-E-CONFIG: sandbox.unsigned.allow 必须为布尔' }
          sb.unsignedAllow = uv
        }
      } else if (sk === 'sig') {
        if (typeof sv !== 'object' || sv === null || Array.isArray(sv)) return { config: {}, error: 'CAR-E-CONFIG: sandbox.sig 必须为对象' }
        for (const [gk, gv] of Object.entries(sv as Record<string, unknown>)) {
          if (gk === 'enforce') {
            if (typeof gv !== 'boolean') return { config: {}, error: 'CAR-E-CONFIG: sandbox.sig.enforce 必须为布尔' }
            sb.sigEnforce = gv
          } else if (gk === 'trustRoot') {
            if (typeof gv !== 'string' || !gv.trim()) return { config: {}, error: 'CAR-E-CONFIG: sandbox.sig.trustRoot 必须为非空字符串（ed25519 spki base64）' }
            sb.sigTrustRoot = gv.trim()
          } else {
            return { config: {}, error: `CAR-E-CONFIG: 未知键 sandbox.sig.${gk}（登记键位：sandbox.sig.enforce / sandbox.sig.trustRoot）` }
          }
        }
      } else {
        return { config: {}, error: `CAR-E-CONFIG: 未知 sandbox 键 "${sk}"（1.1 登记键位：sandbox.unsigned.* / sandbox.sig.*）` }
      }
    }
    out.sandbox = sb
  }
  return { config: out }
}

/** 合并产出（mode/unsignedAllow 恒有值——比 SignatureGateOptions 的可选字段更窄，doctor 等消费方免缺省分支） */
export interface ResolvedSignatureGate {
  mode: 'warn' | 'enforce'
  trustRootPublicKey?: string
  unsignedAllow: boolean
}

/**
 * 优先级合并（flag > env > 配置 > 缺省）：产出装载签名门选项。
 * flagEnforce = CLI --sig-enforce；env 已定义即为显式意见（压过配置），未定义落配置层。
 */
export function mergeSignatureGate(env: NodeJS.ProcessEnv, cfg: CarConfig, flagEnforce?: boolean): ResolvedSignatureGate {
  // cfg 为校验器产出的扁平形状（sandbox.{unsignedAllow,sigEnforce,sigTrustRoot}，JSON 嵌套键已拍平）
  let mode: 'warn' | 'enforce' = cfg.sandbox?.sigEnforce === true ? 'enforce' : 'warn'
  if (env.CAR_SIG_ENFORCE !== undefined) mode = env.CAR_SIG_ENFORCE === '1' ? 'enforce' : 'warn'
  if (flagEnforce) mode = 'enforce'
  let trustRootPublicKey = cfg.sandbox?.sigTrustRoot
  if (env.CAR_TRUST_ROOT) trustRootPublicKey = env.CAR_TRUST_ROOT
  let unsignedAllow = cfg.sandbox?.unsignedAllow === true
  if (env.CAR_UNSIGNED_ALLOW !== undefined) unsignedAllow = env.CAR_UNSIGNED_ALLOW === '1'
  return { mode, trustRootPublicKey: trustRootPublicKey || undefined, unsignedAllow }
}
