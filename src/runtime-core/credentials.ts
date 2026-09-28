/**
 * M8 · 凭据门（resolveCredential ——《系统设计》§3.2.M8.2 凭据行 / SQ-07 凭据解析 / O-13）
 *
 * 口径：
 *  - 解析链：OS Keychain（C-03）→ env fallback（**需用户显式开启**——§3.2.M8.3 字段表
 *    「env 需用户显式开启 fallback」）；全落空 = CarM8Error A080001（不重试，引导 car doctor）；
 *  - Keychain 通道按平台探测（能力探测三件套：命令在场的显式探测，缺席显式降级不静默）：
 *    darwin = `security find-generic-password`、linux = `secret-tool`、
 *    win32 = 零依赖读通道缺席（cmdkey 仅列举不可读值）→ 显式降级登记；
 *  - CredentialRef 不落明文（O-13）：ref 只含 provider/source/origin；明文经 reveal() 按需取用，
 *    reveal 必须经审计回调（provider+source 留痕，值不入审计——值入日志即泄露面，secrets 红线）；
 *  - 环境变量约定：OPENAI_API_KEY（openai-compat）/ ANTHROPIC_API_KEY（anthropic）/
 *    CAR_LLM_API_KEY（通用兜底）；显式开启 = opts.allowEnvFallback 或 CAR_ALLOW_ENV_CREDENTIALS=1。
 */
import { spawnSync } from 'node:child_process'
import { CarM8Error, credentialMissing } from './errors.ts'
import type { CredentialRef, CredentialSource } from './types.ts'

export interface CredentialResolveOptions {
  /** 测试注入；缺省取 process.env */
  env?: NodeJS.ProcessEnv
  /** env fallback 显式开启（规格要求默认关；CAR_ALLOW_ENV_CREDENTIALS=1 等效） */
  allowEnvFallback?: boolean
  /**
   * keychain 读取器注入（测试替身）：入参 keychain 服务名，返回明文或 null（不存在）。
   * 缺省用平台命令真实读取；平台无读通道（win32）= 通道不可用（显式降级）。
   */
  keychainReader?: (service: string) => string | null
  /** reveal 审计回调（值不入参——审计全量留痕但零明文） */
  audit?: (event: { action: 'resolve' | 'reveal'; provider: string; source: CredentialSource; origin: string }) => void
}

/** provider → 候选 env 变量（按序检索；CAR_LLM_API_KEY 为通用兜底） */
const PROVIDER_ENV_VARS: Record<string, string[]> = {
  'openai-compat': ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
}
const GENERIC_ENV_VARS = ['CAR_LLM_API_KEY']

/** provider 候选 env 变量（doctor 存在性探测等诊断面复用；值永不打印） */
export function providerEnvVars(provider: string): string[] {
  return [...(PROVIDER_ENV_VARS[provider] ?? []), ...GENERIC_ENV_VARS]
}

/** keychain 服务名（命名空间隔离：car-runtime/<provider>） */
export function keychainService(provider: string): string {
  return `car-runtime/${provider}`
}

interface KeychainChannel { reader: ((service: string) => string | null) | null; note: string }

/** 平台 keychain 通道探测：命令在场（darwin/linux）→ 真实读取器；无读通道（win32）→ 显式 null */
export function probeKeychainChannel(platform: NodeJS.Platform = process.platform): KeychainChannel {
  if (platform === 'darwin') {
    return { reader: service => {
      const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf-8', timeout: 5000 })
      if (r.status !== 0 || r.stdout == null) return null
      return r.stdout.replace(/\r?\n$/, '') || null
    }, note: 'darwin security' }
  }
  if (platform === 'linux') {
    return { reader: service => {
      const r = spawnSync('secret-tool', ['lookup', 'service', service], { encoding: 'utf-8', timeout: 5000 })
      if (r.status !== 0 || r.stdout == null) return null
      return r.stdout.replace(/\r?\n$/, '') || null
    }, note: 'linux secret-tool' }
  }
  // win32 及其他：无零依赖读通道——显式不可用（禁静默假装有 keychain）
  return { reader: null, note: `keychain 读通道在 ${platform} 缺席（零依赖实现无 OS 凭据库读取面）——显式降级` }
}

export class CredentialService {
  readonly #channel: KeychainChannel
  readonly #platform: NodeJS.Platform

  constructor(opts: { keychainReader?: (service: string) => string | null; platform?: NodeJS.Platform } = {}) {
    this.#platform = opts.platform ?? process.platform
    this.#channel = opts.keychainReader
      ? { reader: opts.keychainReader, note: 'injected reader' }
      : probeKeychainChannel(this.#platform)
  }

  /** keychain 通道状态（doctor 展示/测试断言；缺席显式登记不静默） */
  get channelStatus(): { available: boolean; note: string } {
    return { available: this.#channel.reader !== null, note: this.#channel.note }
  }

  /**
   * 解析凭据引用（天然幂等；返回值不含明文）。
   * 检索顺序：keychain →（显式开启时）env；全落空 = A080001。
   */
  resolve(provider: string, opts: CredentialResolveOptions = {}): CredentialRef {
    const env = opts.env ?? process.env
    const searched: string[] = []
    const service = keychainService(provider)

    if (this.#channel.reader) {
      searched.push(`keychain:${service}`)
      const value = this.#channel.reader(service)
      if (value) {
        opts.audit?.({ action: 'resolve', provider, source: 'keychain', origin: service })
        return { provider, source: 'keychain', origin: service }
      }
    } else {
      searched.push(`keychain:${service}(通道缺席)`)
    }

    const allowEnv = opts.allowEnvFallback === true || env.CAR_ALLOW_ENV_CREDENTIALS === '1'
    if (allowEnv) {
      const candidates = providerEnvVars(provider)
      for (const name of candidates) {
        searched.push(`env:${name}`)
        if (env[name]) {
          opts.audit?.({ action: 'resolve', provider, source: 'env', origin: name })
          return { provider, source: 'env', origin: name, degraded: this.#channel.reader ? undefined : this.#channel.note }
        }
      }
    } else {
      searched.push('env(未显式开启 fallback)')
    }

    throw credentialMissing(provider, searched)
  }

  /** 按引用取明文（仅 provider 适配器请求时点调用；每次经审计留痕，值不入日志不入错误） */
  reveal(ref: CredentialRef, opts: CredentialResolveOptions = {}): string {
    const env = opts.env ?? process.env
    if (ref.source === 'keychain') {
      if (!this.#channel.reader) throw new CarM8Error('A080001', 'CAR-E-CRED-MISSING', `keychain 通道缺席，无法取值（${ref.origin}）`, '未找到模型服务凭据，请运行 car doctor', false)
      const value = this.#channel.reader(ref.origin)
      if (!value) throw credentialMissing(ref.provider, [`keychain:${ref.origin}(resolve 后消失)`])
      opts.audit?.({ action: 'reveal', provider: ref.provider, source: ref.source, origin: ref.origin })
      return value
    }
    const value = env[ref.origin]
    if (!value) throw credentialMissing(ref.provider, [`env:${ref.origin}(resolve 后消失)`])
    opts.audit?.({ action: 'reveal', provider: ref.provider, source: ref.source, origin: ref.origin })
    return value
  }
}
