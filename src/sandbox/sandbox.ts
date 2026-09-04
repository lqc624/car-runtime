/**
 * F3 · 沙箱执行器：能力探测 + 三档模式 + 降级路径（BD-01）+ 逃逸回归接口
 *
 * 口径（《系统设计》F3 / 安全设计 §5.3 / Q-04 定稿 / 冻结决策② + M2系统设计增补 T-3）：
 *  - 平台后端：linux = landlock-run（dsh 同款独立 C11 可执行：--probe 探测、--ro/--rw -- argv、
 *    fail-closed）+ seccomp 过滤集；darwin = Seatbelt（sandbox-exec 动态生成 profile，M2-S7 实装）；
 *    win32 = 受限 token + Job Object（koffi FFI，S7 出 spike 方案、S8 实装——dsh win32 为 koffi 纯 JS，
 *    sandbox-local/src/index.ts:160-161 源码级已核实）。
 *    容器内 Landlock 不可用 → 探测失败走同一降级路径（SR-01/19 口径）
 *  - 降级态约束（Q-04）：写类操作强制确认模式（full 亦受限）、env-read 一律拒绝、
 *    降级事件 + 每次降级态授权带 degraded=true 留痕、静默降级 = AL-03 P1（计数必须为 0）
 *  - 执行：argv 数组形式（A03 红线：禁 shell -c 拼接）、单命令 300s 上限、0 自动重试
 */
import { spawn } from 'node:child_process'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type Capability = 'fs-write' | 'net' | 'exec' | 'mcp' | 'env-read'

export interface ProbeResult {
  platform: NodeJS.Platform
  landlock: boolean
  seccomp: boolean
  degraded: boolean
  /** 降级原因（审计留痕用）；未降级为 null */
  reason: string | null
}

export interface SandboxAuditSink {
  (event: { kind: 'sandbox-degraded' | 'sandbox-denied' | 'sandbox-exec'; detail: Record<string, unknown>; ts: number }): void
}

/** 能力探测：Linux 用 landlock-run --probe；其余平台直接降级（可插拔真实探测） */
export async function probeCapabilities(opts: {
  landlockRunPath?: string
  platform?: NodeJS.Platform
} = {}): Promise<ProbeResult> {
  const platform = opts.platform ?? process.platform
  if (platform !== 'linux' || !opts.landlockRunPath) {
    return {
      platform,
      landlock: false, seccomp: false, degraded: true,
      reason: platform === 'linux'
        ? 'landlock-run binary not available（BD-01：需编译 native/landlock-run 或提供路径）'
        : `platform ${platform} 沙箱原语未实装（S3：Linux 先行，经中间确认②）`,
    }
  }
  const probe = await new Promise<{ ok: boolean }>((resolve) => {
    try {
      const child = spawn(opts.landlockRunPath!, ['--probe'], { stdio: 'ignore' })
      child.on('exit', (code) => resolve({ ok: code === 0 }))
      child.on('error', () => resolve({ ok: false }))
    } catch { resolve({ ok: false }) }
  })
  return probe.ok
    ? { platform, landlock: true, seccomp: true, degraded: false, reason: null }
    : { platform, landlock: false, seccomp: false, degraded: true, reason: 'landlock-run probe failed（内核 <5.13 或 LSM 未启用）' }
}

export interface ExecRequest {
  argv: string[]
  /** 声明所需能力（能力标签 = 跨域请求唯一凭证） */
  capabilities: Capability[]
  mode: SandboxMode
  /** 运行权限模式（F4）：readonly/confirm/full——降级态下 full 亦受限为 confirm */
  permissionMode: 'readonly' | 'confirm' | 'full'
  authorize?: (req: ExecRequest) => Promise<boolean>
  timeoutMs?: number
}

export interface ExecResult { ok: boolean; stdout: string; stderr: string; code: number | null; degraded: boolean; denied?: string }

/**
 * M2-S7 · Seatbelt profile 生成器（darwin 后端）
 *
 * 口径：参照 Codex sandbox-exec 动态生成 profile（SR-19，源码级已核实）+ dsh darwin=['seatbelt'] 路由。
 * 生成规则（fail-closed：默认全部拒绝，仅显式 allow）：
 *  - 全模式：允许进程基本运行（process-exec/process-fork）+ /usr,/bin,/sbin,/System 只读；
 *  - read-only / workspace-write：拒绝 network*（deny-by-default 网络）；
 *  - workspace-write：仅 {workspace} 与 CAR_HOME 临时目录允许 file-write*，.git 强制只读（受保护路径）；
 *  - danger-full-access：不生成 profile（直跑，与 Codex 三档一致）。
 */
export function buildSeatbeltProfile(mode: SandboxMode, workspace: string): string {
  if (mode === 'danger-full-access') throw new Error('CAR-E-SANDBOX: danger-full-access does not use a seatbelt profile（直跑语义）')
  const ws = workspace.replace(/"/g, '\\"')
  const lines = [
    '(version 1)',
    '(deny default)', // fail-closed
    ';; 进程基本运行',
    '(allow process-fork)',
    '(allow process-exec)',
    ';; 系统只读面',
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/private/var/db/dyld"))',
    ';; 系统运行必需',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow iokit-open)',
  ]
  if (mode === 'workspace-write') {
    lines.push(
      `;; 工作区可写（.git 强制只读——受保护路径）`,
      `(allow file-write* (subpath "${ws}"))`,
      `(deny file-write* (subpath "${ws}/.git"))`,
      `;; 工作区读取`,
      `(allow file-read* (subpath "${ws}"))`,
      `;; 临时目录（编译器/子进程必需）`,
      '(allow file-write* (subpath "/private/tmp"))',
      '(allow file-read* (subpath "/private/tmp"))',
      '(allow file-write* (subpath "/private/var/tmp"))',
    )
  } else {
    lines.push(
      `;; read-only：工作区仅读`,
      `(allow file-read* (subpath "${ws}"))`,
      '(allow file-read* (subpath "/private/tmp"))',
    )
  }
  lines.push(';; deny-by-default 网络（写类能力需显式豁免才可放行，本模板一律拒绝）', '(deny network*)')
  return lines.join('\n')
}

export class SandboxExecutor {
  #probe: ProbeResult
  #audit: SandboxAuditSink
  #landlockRunPath?: string
  #workspace: string

  constructor(opts: { probe: ProbeResult; audit: SandboxAuditSink; landlockRunPath?: string; workspace: string }) {
    this.#probe = opts.probe
    this.#audit = opts.audit
    this.#landlockRunPath = opts.landlockRunPath
    this.#workspace = opts.workspace
  }

  get degraded(): boolean { return this.#probe.degraded }

  /** Q-04 定稿：降级态运行约束判定（在授权门之前生效） */
  effectivePermission(permissionMode: ExecRequest['permissionMode'], capabilities: Capability[]): { mode: 'readonly' | 'confirm' | 'full'; denied: string | null } {
    if (!this.degraded) return { mode: permissionMode, denied: null }
    const writeish = capabilities.some(c => c === 'fs-write' || c === 'net' || c === 'exec' || c === 'mcp')
    if (capabilities.includes('env-read')) return { mode: 'confirm', denied: 'env-read denied in degraded sandbox（Q-04：一律拒绝）' }
    if (writeish) return { mode: 'confirm', denied: null } // full 亦受限为 confirm
    return { mode: permissionMode === 'full' ? 'confirm' : permissionMode, denied: null }
  }

  /** 沙箱内执行：argv 数组、写类能力需授权、降级态 Q-04 约束、审计全量留痕 */
  async exec(req: ExecRequest): Promise<ExecResult> {
    const { mode: effMode, denied: degradedDenial } = this.effectivePermission(req.permissionMode, req.capabilities)
    if (degradedDenial) {
      this.#audit({ kind: 'sandbox-denied', detail: { argv: req.argv, reason: degradedDenial, degraded: true }, ts: Date.now() })
      return { ok: false, stdout: '', stderr: degradedDenial, code: -1, degraded: true, denied: degradedDenial }
    }
    // 权限门：写类能力在 readonly 一律拒；confirm 需审批（降级态强制 confirm）
    const writeish = req.capabilities.some(c => c === 'fs-write' || c === 'net' || c === 'exec' || c === 'mcp')
    if (writeish && effMode !== 'full') {
      const granted = effMode === 'confirm' ? await (req.authorize?.(req) ?? Promise.resolve(false)) : false
      if (!granted) {
        this.#audit({ kind: 'sandbox-denied', detail: { argv: req.argv, mode: effMode, degraded: this.degraded }, ts: Date.now() })
        return { ok: false, stdout: '', stderr: `authorization-denied (mode=${effMode}${this.degraded ? ', degraded' : ''})`, code: -1, degraded: this.degraded, denied: 'authorization-denied' }
      }
    }
    if (this.degraded) {
      // 降级态执行：无内核背书——仅透传执行并留痕（授权门已按 Q-04 收紧）
      this.#audit({ kind: 'sandbox-exec', detail: { argv: req.argv, degraded: true }, ts: Date.now() })
      return this.#spawn(req.argv, req.timeoutMs, true)
    }
    // 正常态：Linux landlock-run 包装（self-restrict-then-exec，fail-closed）
    if (process.platform === 'linux' && this.#landlockRunPath) {
      const ro = req.mode === 'read-only'
      const wrapped = [this.#landlockRunPath, ro ? '--ro' : '--rw', '--', ...req.argv]
      return this.#spawn(wrapped, req.timeoutMs, false)
    }
    // 正常态：macOS Seatbelt（sandbox-exec 动态 profile，M2-S7）
    if (process.platform === 'darwin' && req.mode !== 'danger-full-access') {
      const profile = buildSeatbeltProfile(req.mode, this.#workspace)
      return this.#spawn(['sandbox-exec', '-p', profile, ...req.argv], req.timeoutMs, false)
    }
    return this.#spawn(req.argv, req.timeoutMs, false)
  }

  #spawn(argv: string[], timeoutMs = 300_000, degraded: boolean): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: this.#workspace, shell: false, env: { ...process.env } })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout?.on('data', d => { stdout += d })
      child.stderr?.on('data', d => { stderr += d })
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: String(e), code: -1, degraded }) })
      child.on('exit', (code) => {
        clearTimeout(timer)
        this.#audit({ kind: 'sandbox-exec', detail: { argv, code, degraded }, ts: Date.now() })
        resolve({ ok: code === 0, stdout, stderr, code, degraded })
      })
    })
  }
}
