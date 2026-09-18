/**
 * landlock-run — CAR F3 沙箱 Linux 后端（self-restrict-then-exec，fail-closed）
 *
 * 接口契约（src/sandbox/sandbox.ts 调用面，不得单方面变更）：
 *   landlock-run --probe                     探测内核 Landlock 可用性：可用 exit 0，不可用 exit 1
 *   landlock-run --ro -- argv...             只读沙箱：全盘可读可执行，任何写一律拒绝
 *   landlock-run --rw -- argv...             工作区写沙箱：仅当前工作目录（cwd）可写，其余全盘只读
 *
 * 语义（《系统设计》F3 / 安全设计 §5.3 / M3部署设计增补 §2.1.2）：
 *   - allowlist 制：Landlock ruleset 未覆盖路径的 handled 访问位一律拒绝（fail-closed）；
 *   - handled 位 = ABI1 全集（EXECUTE/WRITE_FILE/READ_FILE/READ_DIR/REMOVE_DIR/REMOVE_FILE/
 *     MAKE_CHAR/MAKE_DIR/MAKE_REG/MAKE_SOCK/MAKE_FIFO/MAKE_TRANS/MAKE_SYM）
 *     + ABI≥3 追加 TRUNCATE；
 *     ABI2 REFER 不处理（跨目录 re-link 由内核默认拒绝——逃逸面收紧而非放松）；
 *   - PR_SET_NO_NEW_PRIVS 先置位再 restrict_self（setuid 提权失效）；
 *   - 用例/审计要求：任何一条访问位拒绝都表现为目标系统调用的 EACCES，由上层用例断言。
 *
 * ABI 兼容：直接 syscall（x86_64: 444/445/446），不依赖 glibc 封装（glibc < 2.34 也可编译）。
 * 构建单源（M3 §2.1.2）：J-01 单点编译 linux-x64-gnu，J-05/J-17 消费同一二进制，禁止平台内重编译。
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/prctl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* ── Landlock ABI（x86_64 syscall numbers，内核 ≥ 5.15 环境，J-17 环境自检兜底） ── */
#define SYS_LANDLOCK_CREATE_RULESET 444
#define SYS_LANDLOCK_ADD_RULE       445
#define SYS_LANDLOCK_RESTRICT_SELF  446

#define LANDLOCK_CREATE_RULESET_VERSION 1U

/* Landlock FS 访问位（linux/landlock.h 同值，手工定义以摆脱头文件版本依赖） */
#define LL_FS_EXECUTE    (1ULL << 0)
#define LL_FS_WRITE_FILE (1ULL << 1)
#define LL_FS_READ_FILE  (1ULL << 2)
#define LL_FS_READ_DIR   (1ULL << 3)
#define LL_FS_REMOVE_DIR (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR  (1ULL << 6)
#define LL_FS_MAKE_DIR   (1ULL << 7)
#define LL_FS_MAKE_REG   (1ULL << 8)
#define LL_FS_MAKE_SOCK  (1ULL << 9)
#define LL_FS_MAKE_FIFO  (1ULL << 10)
#define LL_FS_MAKE_TRANS (1ULL << 11)
#define LL_FS_MAKE_SYM   (1ULL << 12)
/* ABI v2 (1<<13 REFER) 有跨目录授权约束，不纳入 handled（跨目录 mv/link 默认拒绝，收紧面） */
#define LL_FS_TRUNCATE   (1ULL << 14) /* ABI v3 (kernel ≥ 6.2) */

#define LL_ABI1_WRITE_BITS (LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE | \
                            LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG | \
                            LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_TRANS | \
                            LL_FS_MAKE_SYM)
#define LL_ABI3_EXTRA      LL_FS_TRUNCATE

#define LANDLOCK_RULE_PATH_BENEATH 1U /* linux/landlock.h 同值 */

struct ll_ruleset_attr { uint64_t handled_access_fs; };
struct ll_path_beneath_attr { uint64_t allowed_access; int parent_fd; };

static int ll_create_ruleset(uint64_t handled, uint32_t *abi_out) {
  /* 先查 ABI 版本（不创建 ruleset） */
  int abi = (int)syscall(SYS_LANDLOCK_CREATE_RULESET, NULL, 0,
                         LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) return -1; /* EOPNOTSUPP: LSM 未启用 / ENOSYS: 内核过旧 / EINVAL */
  *abi_out = (uint32_t)abi;

  struct ll_ruleset_attr attr = { .handled_access_fs = handled };
  return (int)syscall(SYS_LANDLOCK_CREATE_RULESET, &attr, sizeof(attr), 0U);
}

static int ll_add_path_rule(int ruleset_fd, uint64_t access, const char *path) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return -1;
  struct ll_path_beneath_attr rule = { .allowed_access = access, .parent_fd = fd };
  int rc = (int)syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd,
                        LANDLOCK_RULE_PATH_BENEATH, &rule, 0U);
  /* LANDLOCK_RULE_PATH_BENEATH = 1（linux/landlock.h） */
  close(fd);
  return rc;
}

static int ll_restrict(int ruleset_fd) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return (int)syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0U);
}

/* probe：Landlock 可探测（内核 ≥ 5.13 + LSM 启用）exit 0，否则 exit 1 */
static int do_probe(void) {
  uint32_t abi = 0;
  int fd = ll_create_ruleset(LL_FS_EXECUTE | LL_FS_WRITE_FILE, &abi);
  if (fd < 0) return 1;
  close(fd);
  return 0;
}

static void usage_exit(void) {
  fprintf(stderr,
    "usage: landlock-run --probe\n"
    "       landlock-run --ro -- argv...\n"
    "       landlock-run --rw -- argv...\n");
  exit(64); /* 契约：非法用法固定 64（逃逸矩阵 E 类断言面） */
}

int main(int argc, char **argv) {
  if (argc < 2) usage_exit();

  if (strcmp(argv[1], "--probe") == 0) return do_probe();

  int rw;
  if (strcmp(argv[1], "--ro") == 0) rw = 0;
  else if (strcmp(argv[1], "--rw") == 0) rw = 1;
  else usage_exit();

  if (argc < 4 || strcmp(argv[2], "--") != 0) usage_exit();
  char **cmd = &argv[3];

  uint32_t abi = 0;
  uint64_t handled = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR | LL_ABI1_WRITE_BITS;
  /* 建 ruleset；ABI≥3 时重建以纳入 TRUNCATE（否则 truncate 不受控 = 收窄覆盖面） */
  int fd = ll_create_ruleset(handled, &abi);
  if (fd < 0) { perror("landlock-run: create_ruleset"); return 65; }
  if (abi >= 3) {
    close(fd);
    handled |= LL_ABI3_EXTRA;
    fd = ll_create_ruleset(handled, &abi);
    if (fd < 0) { perror("landlock-run: create_ruleset(abi3)"); return 65; }
  }

  /* 全盘读/执行放行（运行面），未覆盖写位 = 全盘默认拒绝（fail-closed） */
  if (ll_add_path_rule(fd, LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR, "/") != 0) {
    perror("landlock-run: add rule /"); return 65;
  }
  /* /dev/null 写放行：null 设备无逃逸面，是 shell 重定向/工具链运行必需（dsh 同款惯例） */
  uint64_t null_bits = LL_FS_WRITE_FILE | (abi >= 3 ? LL_FS_TRUNCATE : 0);
  if (ll_add_path_rule(fd, null_bits, "/dev/null") != 0) {
    perror("landlock-run: add rule /dev/null"); return 65;
  }
  if (rw) {
    uint64_t write_bits = LL_ABI1_WRITE_BITS | (abi >= 3 ? LL_ABI3_EXTRA : 0);
    /* 仅 cwd（工作区）可写——M3 §2.1.1 步骤 4 强约束：用例必须在原生 FS 工作区内跑 */
    if (ll_add_path_rule(fd, write_bits, ".") != 0) {
      perror("landlock-run: add rule ."); return 65;
    }
  }

  if (ll_restrict(fd) != 0) { perror("landlock-run: restrict_self"); return 65; }
  close(fd);

  execvp(cmd[0], cmd);
  perror("landlock-run: execvp");
  return 66;
}
