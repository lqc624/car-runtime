/**
 * Windows 沙箱 spike 骨架（S8 执行；M2系统设计增补 T-3 / adr/win32-spike.md）
 *
 * koffi 为 optionalDependencies：未安装（非 Windows 或沙箱内无 npm）时输出 SKIP + 判据清单，
 * 与 POC-4 windows-skip 后端口径一致（verdict=SKIPPED 不满足发布门禁）。
 */
import { spawnSync } from 'node:child_process'

async function main() {
  let koffi: any = null
  try { koffi = (await import('koffi')).default ?? (await import('koffi') as any) } catch { /* not installed */ }
  const platform = process.platform
  if (platform !== 'win32') { console.log(`SKIP: spike requires win32 (current: ${platform})`); return }
  if (!koffi) {
    console.log(`SKIP: koffi not installed（npm install koffi 后重跑）
判据清单（adr/win32-spike.md）:
  1. 受限 token 下 whoami /groups 显示剥离 Administrators SID（S-1-16-0 IL）
  2. 工作区外写操作 ACCESS_DENIED（fail-closed 非静默）
  3. Job Object 配额触发：fork 炸弹被杀、父进程存活
  4. koffi 纯 JS 依赖链（零原生编译）
调用链: OpenProcessToken → CreateRestrictedToken(DISABLE_MAX_PRIVILEGE + deny Administrators SID)
        → CreateProcessAsUserW → CreateJobObjectW + SetInformationJobObject(256MB/32 proc/kill-on-close)`)
    return
  }
  // S8 实装：koffi('kernel32.dll', ...) 调用骨架（真实执行在 Windows + koffi 环境）
  const kernel32 = koffi.load?.('kernel32.dll') ?? null
  console.log('READY: koffi available, kernel32 loaded =', kernel32 !== null)
  console.log('S8 在此接入 CreateRestrictedToken / CreateJobObjectW 实装（判据 1-4 自动断言）')
  // 保守门禁：未实装完成前不得声称 PASS
  process.exitCode = 2 // PENDING
}

void spawnSync // 保留引用（阶段 3 探针用）
main()
