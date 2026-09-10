/**
 * win32 FFI 诊断矩阵（M5-S26 临时诊断，非门禁）：定位 windows-2025 runner 上
 * CreateProcessAsUserW 子进程 0xC0000142（STATUS_DLL_INIT_FAILED）的确切触发条件。
 * 矩阵：API（AsUser/WithToken/normal）× 环境块（NULL/显式 Unicode）×
 *       标志（CREATE_NO_WINDOW/DETACHED_PROCESS）× 程序（cmd/whoami/node）× token（原发/受限）。
 * 本机（非提权交互会话）全绿为基线；runner 上首个失败行即回归点。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const koffi = (await import('koffi')).default ?? (await import('koffi') as any)
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')

const CREATE_NO_WINDOW = 0x08000000
const CREATE_SUSPENDED = 0x00000004
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const DETACHED_PROCESS = 0x00000008
const STILL_ACTIVE = 259
const PSEUDO_CURRENT_PROCESS = BigInt.asUintN(64, -1n)
const SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'

const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void *', Attributes: 'uint32' })
const CloseHandle = kernel32.func('int32 __stdcall CloseHandle(uint64 hObject)')
const WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(uint64 hHandle, uint32 dwMilliseconds)')
const ResumeThread = kernel32.func('uint32 __stdcall ResumeThread(uint64 hThread)')
const GetExitCodeProcess = kernel32.func('int32 __stdcall GetExitCodeProcess(uint64 hProcess, void *lpExitCode)')
const OpenProcessToken = advapi32.func('int32 __stdcall OpenProcessToken(uint64 ProcessHandle, uint32 DesiredAccess, void *TokenHandle)')
const CreateRestrictedToken = advapi32.func('int32 __stdcall CreateRestrictedToken(uint64 ExistingTokenHandle, uint32 Flags, uint32 DisableSidCount, SID_AND_ATTRIBUTES *SidsToDisable, uint32 DeletePrivilegeCount, void *PrivilegesToDelete, uint32 RestrictedSidCount, void *SidsToRestrict, void *NewTokenHandle)')
const CreateProcessAsUserW = advapi32.func('int32 __stdcall CreateProcessAsUserW(uint64 hToken, void *lpApplicationName, void *lpCommandLine, void *pa, void *ta, int32 bInherit, uint32 flags, void *env, void *dir, void *si, void *pi)')
const CreateProcessW = kernel32.func('int32 __stdcall CreateProcessW(void *lpApplicationName, void *lpCommandLine, void *pa, void *ta, int32 bInherit, uint32 flags, void *env, void *dir, void *si, void *pi)')
const CreateProcessWithTokenW = advapi32.func('int32 __stdcall CreateProcessWithTokenW(uint64 hToken, uint32 logonFlags, void *lpApplicationName, void *lpCommandLine, uint32 flags, void *env, void *dir, void *si, void *pi)')

function buildEnvBlock(): Buffer {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (env.SystemRoot === undefined) env.SystemRoot = SystemRoot
  if (env.windir === undefined) env.windir = SystemRoot
  if (env.SystemDrive === undefined) env.SystemDrive = 'C:'
  return Buffer.from(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0\0', 'utf16le')
}

function buildAdminSid(): Buffer {
  const b = Buffer.alloc(16)
  b[0] = 1; b[1] = 2; b.set([0, 0, 0, 0, 0, 5], 2)
  b.writeUInt32LE(32, 8); b.writeUInt32LE(544, 12)
  return b
}

function hexExit(code: number): string {
  return code === STILL_ACTIVE ? 'STILL_ACTIVE' : (code >= 0x80000000 ? `0x${code.toString(16).toUpperCase()}` : String(code))
}

interface Variant {
  label: string
  api: 'normal' | 'asUser' | 'withToken'
  token: 'plain' | 'restricted'
  env: 'null' | 'block'
  flags: number
  program: 'cmd' | 'whoami' | 'node'
  explicitAppName?: boolean
}

const results: string[] = []
async function runVariant(v: Variant, hToken: bigint, hRestricted: bigint, execPath: string): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'car-dbg-'))
  const outFile = path.join(dir, 'out.txt')
  const program = v.program === 'cmd' ? path.join(SystemRoot, 'System32', 'cmd.exe')
    : v.program === 'whoami' ? path.join(SystemRoot, 'System32', 'whoami.exe')
    : execPath
  const cmdline = v.program === 'cmd'
    ? `"${program}" /c exit 0`
    : v.program === 'whoami'
      ? `"${program}" /priv /fo list`
      : `"${program}" -e process.exit(0)`
  const cmdBuf = Buffer.from(cmdline + '\0', 'utf16le')
  const si = Buffer.alloc(104); si.writeUInt32LE(104, 0)
  const pi = Buffer.alloc(24)
  const envArg = v.env === 'block' ? buildEnvBlock() : null
  const flags = v.env === 'block' ? (v.flags | CREATE_UNICODE_ENVIRONMENT) : v.flags
  const tok = v.token === 'restricted' ? hRestricted : hToken
  let ok = 0
  try {
    if (v.api === 'normal') {
      ok = CreateProcessW(null, cmdBuf, null, null, 0, flags, envArg, null, si, pi)
    } else if (v.api === 'asUser') {
      ok = CreateProcessAsUserW(tok, null, cmdBuf, null, null, 0, flags, envArg, null, si, pi)
    } else {
      ok = CreateProcessWithTokenW(tok, 0, null, cmdBuf, flags, envArg, null, si, pi)
    }
    if (!ok) {
      results.push(`${v.label}: CREATE_FAILED rc=0`)
      return
    }
    const hProcess = pi.readBigUInt64LE(0)
    const hThread = pi.readBigUInt64LE(8)
    const wait = WaitForSingleObject(hProcess, 30000)
    const codeBuf = Buffer.alloc(4)
    GetExitCodeProcess(hProcess, codeBuf)
    const code = codeBuf.readUInt32LE(0)
    CloseHandle(hThread); CloseHandle(hProcess)
    results.push(`${v.label}: created=1 wait=${wait === 0 ? 'signaled' : 'timeout'} exit=${hexExit(code)}`)
  } catch (e) {
    results.push(`${v.label}: JS_ERROR ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('=== win32 FFI debug matrix ===')
  const hTokBuf = Buffer.alloc(8)
  if (!OpenProcessToken(PSEUDO_CURRENT_PROCESS, 0x1 | 0x2 | 0x8, hTokBuf)) throw new Error('OpenProcessToken failed')
  const hToken = hTokBuf.readBigUInt64LE(0)
  const sidBuf = buildAdminSid()
  const hRestrBuf = Buffer.alloc(8)
  if (!CreateRestrictedToken(hToken, 0x1, 1, [{ Sid: sidBuf, Attributes: 0 }], 0, null, 0, null, hRestrBuf)) throw new Error('CreateRestrictedToken failed')
  const hRestricted = hRestrBuf.readBigUInt64LE(0)
  const execPath = process.execPath

  const matrix: Variant[] = [
    { label: '01 normal           cmd  nowin env=null  ', api: 'normal', token: 'plain', env: 'null', flags: CREATE_NO_WINDOW, program: 'cmd' },
    { label: '02 asUser   plain   cmd  nowin env=null  ', api: 'asUser', token: 'plain', env: 'null', flags: CREATE_NO_WINDOW, program: 'cmd' },
    { label: '03 asUser   plain   cmd  nowin env=block ', api: 'asUser', token: 'plain', env: 'block', flags: CREATE_NO_WINDOW, program: 'cmd' },
    { label: '04 asUser   plain   cmd  DETACH env=block ', api: 'asUser', token: 'plain', env: 'block', flags: DETACHED_PROCESS, program: 'cmd' },
    { label: '05 asUser   plain   whoami nowin env=block', api: 'asUser', token: 'plain', env: 'block', flags: CREATE_NO_WINDOW, program: 'whoami' },
    { label: '06 asUser   restr   cmd  nowin env=null  ', api: 'asUser', token: 'restricted', env: 'null', flags: CREATE_NO_WINDOW, program: 'cmd' },
    { label: '07 asUser   restr   cmd  nowin env=block ', api: 'asUser', token: 'restricted', env: 'block', flags: CREATE_NO_WINDOW, program: 'cmd' },
    { label: '08 asUser   restr   cmd  DETACH env=block ', api: 'asUser', token: 'restricted', env: 'block', flags: DETACHED_PROCESS, program: 'cmd' },
    { label: '09 asUser   restr   whoami nowin env=block', api: 'asUser', token: 'restricted', env: 'block', flags: CREATE_NO_WINDOW, program: 'whoami' },
    { label: '10 withToken plain  cmd  nowin env=block ', api: 'withToken', token: 'plain', env: 'block', flags: CREATE_NO_WINDOW, program: 'cmd' },
    { label: '11 withToken restr  cmd  nowin env=block ', api: 'withToken', token: 'restricted', env: 'block', flags: CREATE_NO_WINDOW, program: 'cmd' },
    { label: '12 normal           node nowin env=null  ', api: 'normal', token: 'plain', env: 'null', flags: CREATE_NO_WINDOW, program: 'node' },
    { label: '13 asUser   restr   node  nowin env=block', api: 'asUser', token: 'restricted', env: 'block', flags: CREATE_NO_WINDOW, program: 'node' },
    { label: '14 asUser   restr   node DETACH env=block ', api: 'asUser', token: 'restricted', env: 'block', flags: DETACHED_PROCESS, program: 'node' },
  ]
  for (const v of matrix) await runVariant(v, hToken, hRestricted, execPath)
  console.log(results.join('\n'))
  CloseHandle(hRestricted); CloseHandle(hToken)
}

main().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exitCode = 1 })
