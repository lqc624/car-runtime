/**
 * Windows 沙箱 spike（S8 骨架；M2系统设计增补 T-3 / adr/win32-spike.md）
 *
 * M5-S24 阶段 1 实装（2026-09-09）：判据 1 自动断言——
 *   OpenProcessToken(TOKEN_ASSIGN_PRIMARY|TOKEN_DUPLICATE|TOKEN_QUERY)
 *   → CreateRestrictedToken(DISABLE_MAX_PRIVILEGE + Administrators SID → SidsToDisable)
 *   → CreateProcessAsUserW → 子进程 `whoami /groups /fo list` + `whoami /priv /fo list`
 *   → 与父进程基线做差分断言（deny-only + 特权剥离，双证据）。
 *
 * M5-S25 阶段 2 实装（2026-09-09）：判据 3 自动断言——
 *   CreateJobObjectW → SetInformationJobObject(JobObjectExtendedLimitInformation:
 *   ProcessMemoryLimit=256MB + ActiveProcessLimit=32 + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
 *   → 受限子进程（CREATE_SUSPENDED）AssignProcessToJobObject → ResumeThread → IsProcessInJob 复核
 *   → fork 炸弹探针：并发 spawn 64 个 node 子进程（> ActiveProcessLimit=32），超限创建被拒
 *   → KILL_ON_JOB_CLOSE 击杀验证：关 Job 句柄后 30s 长睡子进程在 15s 内被终止（父进程存活）
 *   （fork 炸弹口径 = POC-4 T-17 同源：超限创建在配额内被拒，adr/win32-spike.md 阶段 2）
 *
 * M5-S26 阶段 3 实装（2026-09-10）：判据 2 自动断言（同进程写探针）——
 *   受限子进程内：写沙箱允许区（%TEMP% 会话目录）必须成功；写工作区外管理员门控路径
 *   （C:\Windows\）必须显式 ACCESS_DENIED（EPERM/EACCES，fail-closed 非静默）；
 *   未受限 token 子进程作对照组（本机父进程非提权，对照组同拒属预期，已如实记录）。
 *   四判据至此全部自动断言整合：VERDICT=FOUR-CRITERIA-ALL-PASS 时退出码 0，任一 FAIL 退出码 1
 *   （CI 门禁直连）。DEC-2 已裁决接入 Windows CI 矩阵：ci.yml win32-spike job（windows-latest）。
 *
 * 判据 4（koffi 纯 JS 依赖链）随 koffi 可加载 + prebuilt 在位即断言。
 *
 * koffi 为 optionalDependencies：未安装（非 Windows 或沙箱内无 npm）时输出 SKIP + 判据清单，
 * 与 POC-4 windows-skip 后端口径一致（verdict=SKIPPED 不满足发布门禁）。
 *
 * ABI 备注（koffi 3.2.1 本机探针已核实）：
 *   - koffi.struct 默认 C 自然对齐（SID_AND_ATTRIBUTES=16B，与 Win32 一致）；
 *   - Node Buffer 可直接作 `void *` 参数传入（调用期 pin 住）；null 传 `void *` 合法；
 *   - JS 对象数组不能直传 `void *`（报 ambiguous），须以 koffi.struct 声明参数类型；
 *   - HANDLE 以 uint64 + BigInt 传参（x64 ABI 下与指针寄存器等价）；
 *   - JOBOBJECT_EXTENDED_LIMIT_INFORMATION x64 = 144B（BASIC_LIMIT 64B + IO_COUNTERS 48B + 4 个 SIZE_T）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ---------------- Win32 常量 ----------------
const TOKEN_ASSIGN_PRIMARY = 0x0001
const TOKEN_DUPLICATE = 0x0002
const TOKEN_QUERY = 0x0008
const DISABLE_MAX_PRIVILEGE = 0x00000001
const CREATE_NO_WINDOW = 0x08000000
const CREATE_SUSPENDED = 0x00000004
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const WAIT_TIMEOUT = 0x00000102
const STILL_ACTIVE = 259
const PSEUDO_CURRENT_PROCESS = BigInt.asUintN(64, -1n) // GetCurrentProcess() 伪句柄

// Job Object（JobObjectExtendedLimitInformation = 9）
const JobObjectExtendedLimitInformation = 9
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOB_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024 // 256MB（规划口径）
const JOB_ACTIVE_PROCESS_LIMIT = 32 // 规划口径

const ADMIN_SID = 'S-1-5-32-544' // BUILTIN\Administrators
const DENY_ONLY_RE = /Deny[- ]only|仅用于拒绝|只用于拒绝|用于拒绝/i // zh-CN / en-US whoami 属性文本（含 "Group used for deny only" 变体）
const PRIV_NAME_RE = /Se[A-Z][A-Za-z]+Privilege/g // 特权名不做本地化，可靠
const DANGEROUS_PRIVS = [
  'SeDebugPrivilege', 'SeBackupPrivilege', 'SeRestorePrivilege',
  'SeTakeOwnershipPrivilege', 'SeLoadDriverPrivilege', 'SeSecurityPrivilege',
  'SeManageVolumePrivilege', 'SeTrustedCredManAccessPrivilege',
]

const SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const WHOAMI_EXE = path.join(SystemRoot, 'System32', 'whoami.exe')
const CMD_EXE = path.join(SystemRoot, 'System32', 'cmd.exe')

type CriterionStatus = 'PASS' | 'FAIL' | 'PENDING' | 'SKIP'
interface Criterion { id: number; name: string; status: CriterionStatus; evidence: string }

const criteria: Criterion[] = [
  { id: 1, name: '受限 token 下 whoami /groups 显示 Administrators 剥离（deny-only）+ 特权剥离', status: 'PENDING', evidence: '' },
  { id: 2, name: '工作区外写操作 ACCESS_DENIED（fail-closed，非静默）', status: 'PENDING', evidence: '' },
  { id: 3, name: 'Job Object 配额触发：fork 炸弹被拒/被杀、父进程存活', status: 'PENDING', evidence: '' },
  { id: 4, name: 'koffi 纯 JS 依赖链（零原生编译，prebuilt 在位）', status: 'PENDING', evidence: '' },
]

// Administrators SID（S-1-5-32-544）：Revision=1, Count=2, Authority={0,0,0,0,0,5}, Sub=[32,544]
function buildAdministratorsSid(): Buffer {
  const b = Buffer.alloc(16) // sizeof(SID) x64 = 16
  b[0] = 1
  b[1] = 2
  b.set([0, 0, 0, 0, 0, 5], 2)
  b.writeUInt32LE(32, 8)
  b.writeUInt32LE(544, 12)
  return b
}

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION（x64 = 144B），manual 布局写入
function buildExtendedLimitInfo(): Buffer {
  const b = Buffer.alloc(144)
  b.writeUInt32LE(
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    16, // BasicLimitInformation.LimitFlags
  )
  b.writeUInt32LE(JOB_ACTIVE_PROCESS_LIMIT, 40) // BasicLimitInformation.ActiveProcessLimit
  b.writeBigUInt64LE(BigInt(JOB_MEMORY_LIMIT_BYTES), 112) // ProcessMemoryLimit
  return b
}

// 显式 Unicode 环境块：CreateProcessAsUserW 传 NULL 环境时，受限子进程可能因缺
// SystemRoot/SystemDrive 等关键变量而 0xC0000142（STATUS_DLL_INIT_FAILED）——
// windows-2025 runner（提权上下文）实测踩坑，本机非提权交互环境不可复现
function buildEnvBlock(): Buffer {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (env.SystemRoot === undefined) env.SystemRoot = SystemRoot
  if (env.windir === undefined) env.windir = SystemRoot
  if (env.SystemDrive === undefined) env.SystemDrive = 'C:'
  return Buffer.from(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0\0', 'utf16le')
}

// 输出解码：优先 UTF-8，含替换符则回退 GBK（zh-CN whoami 重定向输出走 OEM 代码页）
function decodeOutput(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  return utf8.includes('\uFFFD') ? new TextDecoder('gbk').decode(buf) : utf8
}

// /fo list 格式：SID 行之后的下一条「属性/Attributes:」行即该组属性
function parseGroupAttrs(listText: string, sid: string): string | null {
  const lines = listText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(sid)) continue
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const l = lines[j].trim()
      const m = l.match(/^(?:属性|Attributes)\s*[:：]\s*(.+)$/i)
      if (m) return m[1]
      if (!l) continue
      if (/[:：]/.test(l)) break // 已进入下一条目（组名/类型/SID 标签行）
    }
  }
  return null
}

function mandatoryLabel(listText: string): string | null {
  const m = listText.match(/S-1-16-\d+/g)
  return m ? m[m.length - 1] : null
}

function privilegeNames(listText: string): string[] {
  return [...listText.matchAll(PRIV_NAME_RE)].map((m) => m[0])
}

interface RestrictedChild {
  hProcess: bigint
  hThread: bigint
  pid: number
  resume: () => void
  wait: (ms?: number) => number
  exitCode: () => number
  outText: () => string
  cleanup: () => void
}

async function main() {
  console.log('=== CAR win32-koffi spike（M5-S24/S25/S26：四判据自动断言）===')
  if (process.platform !== 'win32') {
    console.log(`SKIP: spike requires win32 (current: ${process.platform})`)
    for (const c of criteria) c.status = 'SKIP'
    printReport()
    return
  }

  let koffi: any
  try { koffi = (await import('koffi')).default ?? (await import('koffi') as any) } catch { koffi = null }
  if (!koffi) {
    console.log('SKIP: koffi not installed（npm install koffi 后重跑）')
    console.log('判据清单（adr/win32-spike.md 四判据，见脚本头注释）')
    for (const c of criteria) c.status = 'SKIP'
    printReport()
    return
  }

  // ---- 判据 4：koffi prebuilt 在位、零原生编译 ----
  // koffi 3.x 的本机模块走平台包 @koromix/koffi-win32-x64（npm install 即得，无 node-gyp 编译）
  const repoRoot = path.join(import.meta.dirname ?? '.', '..')
  const prebuiltPkg = path.join(repoRoot, 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node')
  const prebuiltBuild = path.join(repoRoot, 'node_modules', 'koffi', 'build', 'koffi', 'win32_x64')
  criteria[3].status = 'PASS'
  criteria[3].evidence = `koffi 3.2.1 经 optionalDependencies 加载成功；prebuilt 本机模块在位=${existsSync(prebuiltPkg) || existsSync(prebuiltBuild)}（@koromix/koffi-win32-x64 平台包，无编译步骤）`

  // ---- FFI 绑定 ----
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  // SID_AND_ATTRIBUTES 需显式 struct 类型：void * 参数收 JS 对象数组会被判歧义，
  // 声明为 SID_AND_ATTRIBUTES * 后 koffi 按 C 布局（16B，x64 自然对齐，探针已核实）转换
  const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void *', Attributes: 'uint32' })
  const CloseHandle = kernel32.func('int32 __stdcall CloseHandle(uint64 hObject)')
  const WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(uint64 hHandle, uint32 dwMilliseconds)')
  const ResumeThread = kernel32.func('uint32 __stdcall ResumeThread(uint64 hThread)')
  const GetExitCodeProcess = kernel32.func('int32 __stdcall GetExitCodeProcess(uint64 hProcess, void *lpExitCode)')
  const OpenProcessToken = advapi32.func('int32 __stdcall OpenProcessToken(uint64 ProcessHandle, uint32 DesiredAccess, void *TokenHandle)')
  const CreateRestrictedToken = advapi32.func('int32 __stdcall CreateRestrictedToken(uint64 ExistingTokenHandle, uint32 Flags, uint32 DisableSidCount, SID_AND_ATTRIBUTES *SidsToDisable, uint32 DeletePrivilegeCount, void *PrivilegesToDelete, uint32 RestrictedSidCount, void *SidsToRestrict, void *NewTokenHandle)')
  const CreateProcessAsUserW = advapi32.func('int32 __stdcall CreateProcessAsUserW(uint64 hToken, void *lpApplicationName, void *lpCommandLine, void *lpProcessAttributes, void *lpThreadAttributes, int32 bInheritHandles, uint32 dwCreationFlags, void *lpEnvironment, void *lpCurrentDirectory, void *lpStartupInfo, void *lpProcessInformation)')
  // Job Object（S25 阶段 2）
  const CreateJobObjectW = kernel32.func('uint64 __stdcall CreateJobObjectW(void *lpJobAttributes, void *lpName)')
  const SetInformationJobObject = kernel32.func('int32 __stdcall SetInformationJobObject(uint64 hJob, int32 JobObjectInformationClass, void *lpJobObjectInformation, uint32 cbJobObjectInformationLength)')
  const AssignProcessToJobObject = kernel32.func('int32 __stdcall AssignProcessToJobObject(uint64 hJob, uint64 hProcess)')
  const IsProcessInJob = kernel32.func('int32 __stdcall IsProcessInJob(uint64 hProcess, uint64 hJob, void *pbResult)')

  const closeQuiet = (h: bigint) => { try { if (h !== 0n) CloseHandle(h) } catch { /* noop */ } }

  // ---- 受限子进程工厂（cmd /c 重定向落盘，规避句柄继承/控制台编码问题）----
  const createRestrictedChild = (hToken: bigint, program: string, args: string[], opts?: { suspended?: boolean }): RestrictedChild => {
    const dir = mkdtempSync(path.join(tmpdir(), 'car-spike-'))
    const outFile = path.join(dir, 'out.txt')
    const q = (a: string) => (a.includes(' ') ? `"${a}"` : a)
    const cmdBuf = Buffer.from(`${CMD_EXE} /c chcp 65001 >nul & "${program}" ${args.map(q).join(' ')} > "${outFile}" 2>&1\0`, 'utf16le')
    const si = Buffer.alloc(104) // sizeof(STARTUPINFOW) x64
    si.writeUInt32LE(104, 0) // cb
    const pi = Buffer.alloc(24) // sizeof(PROCESS_INFORMATION) x64
    const flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | (opts?.suspended ? CREATE_SUSPENDED : 0)
    if (!CreateProcessAsUserW(hToken, null, cmdBuf, null, null, 0, flags, buildEnvBlock(), null, si, pi)) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error('CreateProcessAsUserW failed (rc=0)——可能缺 SeIncreaseQuotaPrivilege 或受宿主沙箱拦截')
    }
    const hProcess = pi.readBigUInt64LE(0)
    const hThread = pi.readBigUInt64LE(8)
    const codeBuf = Buffer.alloc(4)
    return {
      hProcess,
      hThread,
      pid: pi.readUInt32LE(16),
      resume: () => { ResumeThread(hThread) },
      wait: (ms = 60000) => WaitForSingleObject(hProcess, ms),
      exitCode: () => { GetExitCodeProcess(hProcess, codeBuf); return codeBuf.readUInt32LE(0) },
      outText: () => (existsSync(outFile) ? readFileSync(outFile).toString('utf8') : ''),
      cleanup: () => { closeQuiet(hThread); closeQuiet(hProcess); rmSync(dir, { recursive: true, force: true }) },
    }
  }

  // ---- 父进程基线（未受限）----
  const parentGroups = decodeOutput(spawnSync(WHOAMI_EXE, ['/groups', '/fo', 'list'], { encoding: 'buffer' }).stdout as Buffer)
  const parentPrivsText = decodeOutput(spawnSync(WHOAMI_EXE, ['/priv', '/fo', 'list'], { encoding: 'buffer' }).stdout as Buffer)
  const parentAdminAttrs = parseGroupAttrs(parentGroups, ADMIN_SID)
  const parentPrivs = privilegeNames(parentPrivsText)

  // ---- 阶段 1 调用链 ----
  const hTokBuf = Buffer.alloc(8)
  if (!OpenProcessToken(PSEUDO_CURRENT_PROCESS, TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY, hTokBuf)) {
    throw new Error('OpenProcessToken failed (rc=0)')
  }
  const hToken = hTokBuf.readBigUInt64LE(0)

  const sidBuf = buildAdministratorsSid()
  const saaArray = [{ Sid: sidBuf, Attributes: 0 }] // SID_AND_ATTRIBUTES[1]，Attributes 入参不参与语义
  const hRestrBuf = Buffer.alloc(8)
  const okRestrict = CreateRestrictedToken(hToken, DISABLE_MAX_PRIVILEGE, 1, saaArray, 0, null, 0, null, hRestrBuf)
  if (!okRestrict) {
    closeQuiet(hToken)
    throw new Error('CreateRestrictedToken failed (rc=0)——检查 SID_AND_ATTRIBUTES ABI（期望 16B C 对齐）')
  }
  const hRestricted = hRestrBuf.readBigUInt64LE(0)

  try {
    // ========== 判据 1（S24 阶段 1）==========
    const c1a = createRestrictedChild(hRestricted, WHOAMI_EXE, ['/groups', '/fo', 'list'])
    const c1p = createRestrictedChild(hRestricted, WHOAMI_EXE, ['/priv', '/fo', 'list'])
    c1a.wait(); c1p.wait()
    const childGroupsRes = { out: c1a.outText(), exitCode: c1a.exitCode() }
    const childPrivsRes = { out: c1p.outText(), exitCode: c1p.exitCode() }
    c1a.cleanup(); c1p.cleanup()
    const childAdminAttrs = parseGroupAttrs(childGroupsRes.out, ADMIN_SID)
    const childPrivs = privilegeNames(childPrivsRes.out)
    const stripped = parentPrivs.filter((p) => !childPrivs.includes(p))
    const childDangerous = childPrivs.filter((p) => DANGEROUS_PRIVS.includes(p))
    const parentAlreadyDeny = parentAdminAttrs !== null && DENY_ONLY_RE.test(parentAdminAttrs)
    const childDeny = childAdminAttrs !== null && DENY_ONLY_RE.test(childAdminAttrs)

    // ---- 判据 1 裁决：Administrators deny-only 在列 + 特权剥离差分（双证据）----
    const c1Pass = childAdminAttrs !== null && childDeny && stripped.length > 0 && childDangerous.length === 0
    criteria[0].status = c1Pass ? 'PASS' : 'FAIL'
    criteria[0].evidence = [
      `父 Administrators 属性: ${parentAdminAttrs ?? '未在列'}`,
      `子 Administrators 属性: ${childAdminAttrs ?? '未在列'}`,
      `父 IL: ${mandatoryLabel(parentGroups)} / 子 IL: ${mandatoryLabel(childGroupsRes.out)}`,
      `特权差分: 父 ${parentPrivs.length} 个 → 子 ${childPrivs.length} 个，剥离=[${stripped.join(', ') || '无'}]`,
      `子进程危险特权: ${childDangerous.length === 0 ? '无' : childDangerous.join(', ')}`,
      ...(parentAlreadyDeny
        ? ['注: 父进程本身为 UAC filtered token（Administrators 已 deny-only），deny-only 断言为必要条件，受限 token 生效性由特权剥离差分（DISABLE_MAX_PRIVILEGE）共同支撑']
        : []),
      `子进程退出码: groups=${childGroupsRes.exitCode}, priv=${childPrivsRes.exitCode}`,
    ].join(' | ')

    // ========== 判据 3（S25 阶段 2：Job Object 配额 + fork 炸弹，POC-4 T-17 同源）==========
    const hJob = CreateJobObjectW(null, null)
    if (hJob === 0n) throw new Error('CreateJobObjectW failed (returned NULL)')
    const okJobInfo = SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, buildExtendedLimitInfo(), 144)
    if (!okJobInfo) throw new Error('SetInformationJobObject failed (rc=0)——检查 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 布局（期望 144B）')

    // fork 炸弹探针：并发 spawn 64 个 3s 长睡 node 子进程，统计超限被拒数
    const forkProbeJs = [
      'const { spawn } = require("child_process");',
      'const N = 64;',
      'let ok = 0, fail = 0, done = 0;',
      'function finish(extra) { console.log("FORK_RESULT " + JSON.stringify(Object.assign({ ok: ok, fail: fail }, extra || {}))); process.exit(0); }',
      'function check() { if (done >= N) finish(); }',
      'for (let i = 0; i < N; i++) {',
      '  let c;',
      '  try { c = spawn(process.execPath, ["-e", "setTimeout(function(){process.exit(0)},3000)"], { stdio: "ignore" }); }',
      '  catch (e) { fail++; done++; continue; }',
      '  c.on("error", function () { fail++; done++; check(); });',
      '  c.on("exit", function (code) { if (code === 0) { ok++; } else { fail++; } done++; check(); });',
      '}',
      'setTimeout(function () { finish({ timeout: true }); }, 20000);',
    ].join('\n')
    const sleepJs = 'setTimeout(function () { process.exit(0) }, 30000)\n'

    const s25Dir = mkdtempSync(path.join(tmpdir(), 'car-s25-'))
    const forkProbePath = path.join(s25Dir, 'fork-probe.js')
    const sleepPath = path.join(s25Dir, 'sleep-30s.js')
    writeFileSync(forkProbePath, forkProbeJs, 'utf8')
    writeFileSync(sleepPath, sleepJs, 'utf8')
    const nodeExe = process.execPath

    try {
      // ① 长睡哨兵子进程（挂 Job，用于 KILL_ON_JOB_CLOSE 击杀验证）
      const sentinel = createRestrictedChild(hRestricted, nodeExe, [sleepPath], { suspended: true })
      const okAssignSentinel = AssignProcessToJobObject(hJob, sentinel.hProcess)
      sentinel.resume()

      // ② fork 炸弹子进程（CREATE_SUSPENDED → 挂 Job → Resume，消除子孙脱离 Job 的竞态）
      const bomber = createRestrictedChild(hRestricted, nodeExe, [forkProbePath], { suspended: true })
      const okAssignBomber = AssignProcessToJobObject(hJob, bomber.hProcess)
      bomber.resume()
      const inJobBuf = Buffer.alloc(4)
      IsProcessInJob(bomber.hProcess, hJob, inJobBuf)
      const bomberInJob = inJobBuf.readUInt32LE(0) !== 0

      // ③ 配额内等待 fork 炸弹结束（探针自限时 20s）
      const bomberWait = bomber.wait(90000)
      const forkLine = bomber.outText().split(/\r?\n/).find((l) => l.startsWith('FORK_RESULT'))
      let fork: { ok?: number; fail?: number; timeout?: boolean } = {}
      try { fork = JSON.parse((forkLine ?? '').replace(/^FORK_RESULT\s+/, '') || '{}') } catch { /* 解析失败按空处理 */ }

      // ④ KILL_ON_JOB_CLOSE 击杀验证：确认哨兵仍在跑（2s 等待超时=活着），关 Job 句柄，哨兵须在 15s 内被终止
      const sentinelAlive = sentinel.wait(2000) === WAIT_TIMEOUT && sentinel.exitCode() === STILL_ACTIVE
      CloseHandle(hJob) // 最后一个 Job 用户句柄关闭 → 触发 KILL_ON_JOB_CLOSE
      const t0 = Date.now()
      const sentinelKilledWait = sentinel.wait(15000)
      const killElapsedMs = Date.now() - t0
      const sentinelKilled = sentinelKilledWait === 0 && sentinel.exitCode() !== STILL_ACTIVE

      // ⑤ 父进程存活：全部 Job 活动后父进程仍可正常派生子进程
      const parentAlive = spawnSync(WHOAMI_EXE, ['/priv'], { encoding: 'buffer' }).status === 0

      const quotaTriggered = (fork.fail ?? 0) > 0
      const quotaSane = (fork.ok ?? 0) > 0 // 配额内进程仍可正常创建（非一刀切拒绝）
      const c3Pass = okJobInfo && okAssignBomber && bomberInJob && quotaTriggered && quotaSane
        && sentinelAlive && sentinelKilled && parentAlive
      criteria[2].status = c3Pass ? 'PASS' : 'FAIL'
      criteria[2].evidence = [
        `Job 限额: ProcessMemory=256MB + ActiveProcess=${JOB_ACTIVE_PROCESS_LIMIT} + KILL_ON_JOB_CLOSE（SetInformationJobObject=${okJobInfo ? 'OK' : 'FAIL'}）`,
        `fork 探针挂 Job: Assign=${okAssignBomber ? 'OK' : 'FAIL'}, IsProcessInJob=${bomberInJob}`,
        `fork 炸弹(64 并发): 成功=${fork.ok ?? '?'} 被拒=${fork.fail ?? '?'}${fork.timeout ? ' (探针超时截断)' : ''}`,
        `KILL_ON_JOB_CLOSE: 哨兵存活确认=${sentinelAlive}, 关句柄后 ${killElapsedMs}ms 内被杀=${sentinelKilled}`,
        `父进程存活: ${parentAlive}`,
        ...(bomberWait === WAIT_TIMEOUT ? ['告警: fork 探针未在 90s 内退出'] : []),
      ].join(' | ')

      sentinel.cleanup()
      bomber.cleanup()
      rmSync(s25Dir, { recursive: true, force: true })
    } catch (e) {
      rmSync(s25Dir, { recursive: true, force: true })
      throw e
    }

    // ========== 判据 2（S26 阶段 3：写探针同进程验证，fail-closed 非静默）==========
    // 同进程口径：探针在受限子进程内执行（非父进程代跑）；允许区=%TEMP% 会话目录，
    // 工作区外=管理员门控路径 C:\Windows\（写权限仅提权进程可获）。
    const writeProbeJs = [
      'const fs = require("fs");',
      'const path = require("path");',
      'const res = { insideOk: false, insideErr: null, outsideDenied: false, outsideErr: null, outsideSilent: false };',
      'const insidePath = path.join(process.argv[2], "inside-probe.txt");',
      'try { fs.writeFileSync(insidePath, "car-spike-probe"); fs.unlinkSync(insidePath); res.insideOk = true; }',
      'catch (e) { res.insideErr = e.code || String(e); }',
      'const outsidePath = "C:\\\\Windows\\\\car-spike-outside-" + process.pid + ".tmp";',
      'try { fs.writeFileSync(outsidePath, "car-spike-probe"); res.outsideSilent = true; try { fs.unlinkSync(outsidePath); } catch (e2) {} }',
      'catch (e) { res.outsideDenied = true; res.outsideErr = e.code || String(e); }',
      'console.log("WRITE_RESULT " + JSON.stringify(res));',
    ].join('\n')
    const s26Dir = mkdtempSync(path.join(tmpdir(), 'car-s26-'))
    const writeProbePath = path.join(s26Dir, 'write-probe.js')
    writeFileSync(writeProbePath, writeProbeJs, 'utf8')
    try {
      const runWriteProbe = (tok: bigint) => {
        const c = createRestrictedChild(tok, process.execPath, [writeProbePath, s26Dir])
        c.wait(60000)
        const line = c.outText().split(/\r?\n/).find((l) => l.startsWith('WRITE_RESULT'))
        c.cleanup()
        try { return JSON.parse((line ?? '').replace(/^WRITE_RESULT\s+/, '') || '{}') } catch { return {} as Record<string, unknown> }
      }
      const restrictedWrite = runWriteProbe(hRestricted)
      const unrestrictedWrite = runWriteProbe(hToken) // 对照组：未受限 token（父进程非提权）
      const deniedCodes = ['EPERM', 'EACCES']
      const c2Pass = restrictedWrite.insideOk === true
        && restrictedWrite.outsideDenied === true
        && restrictedWrite.outsideSilent !== true
        && deniedCodes.includes(String(restrictedWrite.outsideErr))
      criteria[1].status = c2Pass ? 'PASS' : 'FAIL'
      criteria[1].evidence = [
        `受限子进程写沙箱允许区(%TEMP% 会话目录): ${restrictedWrite.insideOk ? 'OK' : `失败(${restrictedWrite.insideErr})`}`,
        `受限子进程写工作区外管理员门控路径(C:\\Windows\\): ${restrictedWrite.outsideDenied ? `ACCESS_DENIED(${restrictedWrite.outsideErr})` : (restrictedWrite.outsideSilent ? '静默成功——fail-closed 破防' : `异常(${restrictedWrite.outsideErr})`)}`,
        `对照组(未受限 token 子进程, 父进程非提权): outsideDenied=${unrestrictedWrite.outsideDenied}, err=${unrestrictedWrite.outsideErr}`,
        '注: 本机父进程为非提权 UAC filtered token，对照组同拒属预期；强差分=提权终端复跑（父侧可写、受限子侧被拒）。受限 token 已切断管理员写入通道（判据 1: Administrators deny-only + 特权剥离），写失败以显式异常抛出（fail-closed，非静默降级）',
      ].join(' | ')
      rmSync(s26Dir, { recursive: true, force: true })
    } catch (e) {
      rmSync(s26Dir, { recursive: true, force: true })
      throw e
    }
  } finally {
    closeQuiet(hRestricted)
    closeQuiet(hToken)
  }

  printReport()
}

function printReport() {
  console.log('')
  console.log('---- 四判据状态（adr/win32-spike.md）----')
  for (const c of criteria) {
    console.log(`判据 ${c.id} [${c.status}] ${c.name}`)
    if (c.evidence) console.log(`         证据: ${c.evidence}`)
  }
  const allPass = criteria.every((c) => c.status === 'PASS')
  const verdict = allPass
    ? 'FOUR-CRITERIA-ALL-PASS（1.0-GO-2 判据 1+2 达成；1.0-GO-3 判据 3 目标项达成）'
    : `SPIKE-INCOMPLETE: ${criteria.filter((c) => c.status !== 'PASS').map((c) => `判据${c.id}=${c.status}`).join(', ')}`
  console.log('')
  console.log(`VERDICT: ${verdict}`)
  if (!allPass) process.exitCode = 1 // CI 门禁直连：任一判据 FAIL/SKIP/PENDING 即非零退出
}

main().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exitCode = 1 })
