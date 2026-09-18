#!/usr/bin/env bash
# CAR E-1 逃逸回归矩阵（20 条 × 5 类）—— J-05 escape-linux / J-17 escape-wsl2 共用面
#
# 口径（M3部署设计增补 §2.1）：
#   - 20 条 POC-4 移植用例常驻化；逐条串行（M2 工作目录并发护栏）；禁止 rerun 掩盖；
#   - 审计 JSONL 无论成败必须产出（§2.1.1 步骤 6 常驻上传，非失败时才传）；
#   - 运行位置强约束：必须在原生 ext4 路径（WSL 内 $HOME），禁止 /mnt 挂载路径（9p 语义不完整→假阳性/假阴性）；
#   - 环境自检失败（内核/Landlock 不可用）= 环境失败（exit 2），不构成用例失败（§2.1.3）；
#   - 用例失败 exit 1；全绿 exit 0。
#
# 用法: run-matrix.sh <landlock-run 绝对路径> [审计 JSONL 输出目录]（默认 ./audit）
set -u

LR="$1"
OUTDIR="${2:-./audit}"
mkdir -p "$OUTDIR"
JSONL="$OUTDIR/escape-audit.jsonl"
: > "$JSONL"

PASS=0; FAIL=0; TOTAL=0
TS() { date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || echo 0; }

# ── 环境自检（§2.1.1 步骤 3）：内核 ≥5.15 + Landlock 可探测；失败=环境失败 ──
KVER="$(uname -r)"
KMAJOR="$(echo "$KVER" | cut -d. -f1)"; KMINOR="$(echo "$KVER" | cut -d. -f2)"
if [ "$KMAJOR" -lt 5 ] || { [ "$KMAJOR" -eq 5 ] && [ "$KMINOR" -lt 15 ]; }; then
  echo "ENV-FAIL: kernel $KVER < 5.15" >&2; exit 2
fi
if ! "$LR" --probe; then
  echo "ENV-FAIL: landlock probe failed (LSM disabled or kernel <5.13)" >&2; exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
# §2.1.1 步骤 4 强约束：用例必须在原生 ext4 工作区执行（/mnt 9p 语义不完整 → 假阳性/假阴性）
case "$(pwd)" in /mnt/*|/cygdrive/*)
  echo "ENV-FAIL: workspace on drvfs mount ($(pwd)) — move to native ext4 path" >&2; exit 2 ;;
esac
mkdir -p ws ro-target && echo secret > ro-target/secret.txt && echo local > ws/local.txt
# shellcheck disable=SC2164
ABS_RO="$(cd ro-target && pwd)"
ABS_WS="$(cd ws && pwd)"

# run_case <编号> <类> <模式> <期望exit> <描述> -- <bash -c 脚本>
run_case() {
  local id="$1" cls="$2" mode="$3" expect="$4" desc="$5"; shift 5
  [ "$1" = "--" ] && shift
  TOTAL=$((TOTAL+1))
  local out rc=0
  ( cd "ws" && "$LR" "$mode" -- bash -c "$*" ) >"$WORK/.out" 2>&1 || rc=$?
  local verdict=FAIL
  [ "$rc" -eq "$expect" ] && { verdict=PASS; PASS=$((PASS+1)); } || { verdict=FAIL; FAIL=$((FAIL+1)); }
  printf '{"case":"E-%s","class":"%s","mode":"%s","expect":%s,"actual":%s,"verdict":"%s","desc":"%s","ts":%s}\n' \
    "$id" "$cls" "$mode" "$expect" "$rc" "$verdict" "$desc" "$(TS)" >> "$JSONL"
  printf '[%s] E-%-2s (%s) expect=%s actual=%s  %s\n' "$verdict" "$id" "$cls" "$expect" "$rc" "$desc"
}

# ════ 类 A：工作区外写拒绝（--rw 下，写位仅授予 cwd） ════
run_case 01 A --rw 1 "写 /tmp 拒绝"          -- 'echo x > /tmp/car-escape-a && rm -f /tmp/car-escape-a'
run_case 02 A --rw 1 "写 \$HOME 拒绝"        -- 'echo x > "$HOME/car-escape-b" && rm -f "$HOME/car-escape-b"'
run_case 03 A --rw 1 "写父目录拒绝"           -- 'echo x > ../car-escape-c'
run_case 04 A --rw 1 "写绝对外部路径拒绝"      -- "echo x > $ABS_RO/overrun"

# ════ 类 B：写位转换拒绝（删除/建目/改名/截断，跨出 cwd 一律 EACCES） ════
run_case 05 B --rw 1 "unlink 工作区外拒绝"    -- "rm $ABS_RO/secret.txt"
run_case 06 B --rw 1 "mkdir 工作区外拒绝"     -- 'mkdir /tmp/car-escape-d'
run_case 07 B --rw 1 "rename 跨出 cwd 拒绝"   -- 'mv local.txt ../car-escape-e'
run_case 08 B --rw 1 "截断外部文件拒绝"       -- ": > $ABS_RO/secret.txt"

# ════ 类 C：读/执行面放行验证（allowlist 正确放行运行必需面） ════
run_case 09 C --rw 0 "读 /etc 放行"           -- 'cat /etc/hostname >/dev/null'
run_case 10 C --rw 0 "读工作区放行"           -- 'cat local.txt >/dev/null'
run_case 11 C --rw 0 "exec /bin/true 放行"    -- '/bin/true'
run_case 12 C --ro 0 "只读态读工作区放行"      -- 'cat local.txt >/dev/null'

# ════ 类 D：提权与特殊文件逃逸面 ════
run_case 13 D --ro 1 "只读态 cwd 写拒绝"      -- 'echo x > newfile'
run_case 14 D --rw 1 "symlink 逃逸拒绝"       -- 'ln -s /tmp/car-escape-f link && echo x > link'
run_case 15 D --ro 1 "只读态建目拒绝（MAKE_DIR）" -- 'mkdir subdir'
run_case 16 D --rw 1 "hardlink 外联拒绝"      -- 'ln local.txt ../car-escape-h'

# ════ 类 E：probe 与契约语义 ════
run_case 17 E --rw 0 "--rw cwd 写放行（正对照）" -- 'echo ok > w.txt && grep -q ok w.txt'
run_case 19 E --ro 0 "只读态 exec 放行"        -- '/bin/true'
run_case 20 E --rw 0 "子进程继承沙箱（嵌套写仍拒）" -- 'bash -c "echo x > /tmp/car-escape-i"; test $? -ne 0'

# E-18 特殊：非法用法不走 bash -c 包装，直接断言二进制契约
TOTAL=$((TOTAL+1))
( cd ws && "$LR" --bogus -- true ) >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 64 ]; then PASS=$((PASS+1)); v=PASS; else FAIL=$((FAIL+1)); v=FAIL; fi
printf '{"case":"E-18","class":"E","mode":"contract","expect":64,"actual":%s,"verdict":"%s","desc":"非法用法固定 exit 64","ts":%s}\n' "$rc" "$v" "$(TS)" >> "$JSONL"
printf '[%s] E-18 (E) expect=64 actual=%s  非法用法固定 exit 64\n' "$v" "$rc"

echo "----"
echo "matrix: $PASS/$TOTAL PASS, $FAIL FAIL  (audit: $JSONL)"
[ "$FAIL" -eq 0 ] && [ "$PASS" -eq 20 ] || exit 1
exit 0
