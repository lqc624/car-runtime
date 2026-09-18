/**
 * M6 · car doctor 增强（《系统设计》§3.2.M6.2 引导行：环境自检——沙箱/凭据/连通性）
 *
 * 口径：
 *  - 凭据检查只探存在性、绝不打印值（secrets 红线：值入日志即泄露面）
 *  - 连通性检查网络不可达 = 显式 SKIPPED 而非 FAIL——测试环境必须可离线通过（不失败）
 */
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
