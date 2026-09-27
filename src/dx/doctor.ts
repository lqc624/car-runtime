/**
 * M6 · car doctor 增强（《系统设计》§3.2.M6.2 引导行：环境自检——沙箱/凭据/连通性）
 *
 * 口径：
 *  - 凭据检查只探存在性、绝不打印值（secrets 红线：值入日志即泄露面）
 *  - 连通性检查网络不可达 = 显式 SKIPPED 而非 FAIL——测试环境必须可离线通过（不失败）
 *  - 1.1-S2：签名就绪检查行（mode / 信任根 / 配置文件通道发现态）——诊断面只读，
 *    门禁判定仍在 sigGate/verifier；公钥可打印、信任根值本身不打印
 */
import { createPublicKey } from 'node:crypto'
import { CredentialService } from '../runtime-core/credentials.ts'
import { loadCarConfig, mergeSignatureGate } from '../load/config.ts'

export interface CredentialCheck {
  name: string
  envVar: string
  present: boolean
  hint: string
}

/** 凭据存在性检查：只报 present/not-set，永不输出值 */
export function doctorCredentials(env: NodeJS.ProcessEnv = process.env): CredentialCheck[] {
  return [
    {
      name: 'CAR 凭据',
      envVar: 'CAR_TOKEN',
      present: !!env.CAR_TOKEN,
      hint: 'registry 发布/拉取鉴权用；未设置不影响本地插件开发',
    },
    {
      name: 'npm token',
      envVar: 'NPM_TOKEN',
      present: !!env.NPM_TOKEN,
      hint: 'npm publish 需要时请设置（export NPM_TOKEN=…），值不入日志',
    },
  ]
}

export interface ConnectivityResult {
  status: 'PASS' | 'SKIPPED'
  detail: string
  latencyMs: number
}

/** M8 增强：keychain 通道状态（模型凭据读取面，§3.2.M8.2 凭据行）——能力探测口径，缺席显式降级不静默；离线可过 */
export function doctorKeychain(opts: { platform?: NodeJS.Platform } = {}): { available: boolean; note: string } {
  return new CredentialService({ platform: opts.platform }).channelStatus
}

export interface SignatureCheck {
  /** 生效模式（flag > env > 配置 > 缺省 warn——DEC-1 ②；enforce 缺省翻转 2026-12-25 登记计划内变更） */
  mode: 'warn' | 'enforce'
  /** 信任根通道：absent=未配置（全部插件按 unsigned 处理）；valid=在场且可解析；invalid=在场但解析失败（enforce 下拒签风险） */
  trustRoot: 'absent' | 'valid' | 'invalid'
  /** 配置文件通道（1.1-S3）：absent=cwd 未发现；found=已发现且校验通过；invalid=发现但解析/校验失败（fail-visible） */
  configFile: 'absent' | 'found' | 'invalid'
  detail: string
}

/** 1.1-S2 签名就绪检查：mode 生效值 + 信任根在场可解析性 + car.config.json 发现态（离线可过；值不打印） */
export function doctorSignature(opts: { env?: NodeJS.ProcessEnv; cwd?: string; configPath?: string } = {}): SignatureCheck {
  const env = opts.env ?? process.env
  const cfg = loadCarConfig({ explicitPath: opts.configPath, cwd: opts.cwd })
  let trustRoot: SignatureCheck['trustRoot'] = 'absent'
  const raw = env.CAR_TRUST_ROOT || cfg.config.sandbox?.sigTrustRoot
  if (raw) {
    try {
      createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' })
      trustRoot = 'valid'
    } catch {
      trustRoot = 'invalid'
    }
  }
  // 生效模式含配置层（配置文件解析失败时按 env/缺省口径合并，invalid 态在 configFile 显式呈现）
  const { mode } = mergeSignatureGate(env, cfg.error ? {} : cfg.config)
  const configFile: SignatureCheck['configFile'] = cfg.error ? 'invalid' : cfg.path ? 'found' : 'absent'
  const parts = [
    `mode=${mode}${mode === 'warn' ? '（DEC-1 ② 缺省；2026-12-25 到期翻转）' : ''}`,
    trustRoot === 'absent'
      ? '信任根未配置（全部插件按 unsigned 处理；car plugin-sign keygen 产出 .pub 即信任根）'
      : trustRoot === 'valid'
        ? '信任根已配置（ed25519 spki 可解析，值不打印）'
        : '信任根已配置但不可解析（CAR-E-SIG 拒签风险——检查 CAR_TRUST_ROOT / sandbox.sig.trustRoot 是否为 spki base64）',
    configFile === 'absent'
      ? '配置文件未发现（car.config.json）'
      : configFile === 'found'
        ? `配置文件 ${cfg.path}（校验通过）`
        : `配置文件无效（${cfg.error}）`,
  ]
  return { mode, trustRoot, configFile, detail: parts.join('；') }
}

/**
 * registry 连通性检查：可达 = PASS（含延迟）；不可达/显式跳过 = SKIPPED（不失败）。
 * 默认 registry 取 CAR_REGISTRY_URL，缺省 npmjs。
 */
export async function doctorConnectivity(opts: {
  registryUrl?: string
  timeoutMs?: number
  /** 测试注入跳过 */
  skip?: boolean
} = {}): Promise<ConnectivityResult> {
  const url = opts.registryUrl ?? process.env.CAR_REGISTRY_URL ?? 'https://registry.npmjs.org/-/ping'
  if (opts.skip || process.env.CAR_OFFLINE === '1') {
    return { status: 'SKIPPED', detail: `显式离线（CAR_OFFLINE=1 或测试注入）——跳过 ${url}`, latencyMs: 0 }
  }
  const t0 = Date.now()
  try {
    await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 2000) })
    return { status: 'PASS', detail: url, latencyMs: Date.now() - t0 }
  } catch (e) {
    return {
      status: 'SKIPPED',
      detail: `registry 不可达（${(e as Error).name}: ${(e as Error).message}）——离线环境显式跳过，不判失败`,
      latencyMs: Date.now() - t0,
    }
  }
}
