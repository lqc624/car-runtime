# Windows 沙箱 spike 方案（M2-S7 出方案 → S8 实装，M2系统设计增补 T-3 / 规划 §4 三重闸门第一道）

## 路线定稿

**路线 a（推荐，证据充分）**：Node + koffi FFI 纯 JS 实现 Win32 受限 token + Job Object——
dsh win32 路径即此形态（`sandbox-local/src/index.ts:160-161`，源码级已核实），Codex 受限 token 语义为参照
（SR-19）。禁运行时网络下载沙箱组件（M2部署设计增补 D-3）——koffi 走 optionalDependencies 随包分发。

## 三阶段 spike（S8 第一周执行，Windows 10/11 + Server 2022 双机）

### 阶段 1：受限 token 创建（约 1 人日）

koffi 调用链：`CreateProcessAsUserW`（受限 token）或 `CreateProcessW` + `CREATE_RESTRICTED_TOKEN`
- `OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE|TOKEN_QUERY, &h)`
- `CreateRestrictedToken(h, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 1, [sids deny Administrators], &restricted)`
- 验证命令：spike 子进程内执行 `whoami /groups` → 断言 `S-1-16-0`（Untrusted IL）或 Administrators deny SID 在列；
- 写能力探针：尝试写 `%USERPROFILE%` 外路径 → 断言拒绝（fail-closed）。

### 阶段 2：Job Object 资源配额（约 0.5 人日）

- `CreateJobObjectW` → `SetInformationJobObject(JobObjectExtendedLimitInformation)`：
  内存 256MB + 活跃进程数 32 + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；
- `AssignProcessToJobObject`；验证：fork 炸弹用例（POC-4 T-17）在配额内被拒。

### 阶段 3：逃逸矩阵试跑（约 1 人日）

- POC-4 的 20 条用例以 win32 后端实跑（env-proc 类预期通过 deny 继承成立）；
- 全 PASS + 审计 JSONL → 进 CI windows-2022 runner（16 Job 矩阵，M2部署设计增补）。

## 四判据（S8 结论门）

1. 受限 token 下 `whoami /groups` 显示剥离管理员 SID；
2. 工作区外写操作返回 ACCESS_DENIED（fail-closed，非静默）；
3. Job Object 配额触发生效（fork 炸弹被杀，父进程存活）；
4. koffi 调用零原生编译（纯 JS 依赖链成立，npm install 干净机器可复现）。

## 逐级回退（判据任一不可达）

a 失败 → 回退 b：`PsExec -l -e` 外部工具包装（依赖 Sysinternals，企业可接受性降）；b 失败 → 回退 c：
win32 显式降级维持 S3 现状（BD-01 语义，降级需走中间确认——M2 规划 §4 第三道闸门）。

## spike 脚本

`scripts/win32-koffi-spike.ts`——阶段 1/2 的 koffi 调用骨架（`koffi` 未安装时输出 SKIP + 判据清单，
与 POC-4 windows-skip 后端口径一致）。
