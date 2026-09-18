#!/usr/bin/env bash
# J-17 escape-wsl2 六步编排器（M3部署设计增补 §2.1.1）——在 WSL 发行版内执行
#
# 用法: j17-orchestrate.sh <repo 的 WSL 路径> <landlock-run 二进制的 WSL 路径>
# 步骤映射：1 WSL 启用（CI 前置步骤）/ 2 发行版导入（CI 前置步骤）/ 3 环境自检 / 4 工作区迁移 / 5 实跑 / 6 证据回传（CI 后置步骤）
set -euo pipefail

REPO="${1:?usage: j17-orchestrate.sh <repo-wsl-path> <landlock-run-wsl-path>}"
LR_SRC="${2:?missing landlock-run path}"

# ── 步骤 4：工作区迁移到原生 ext4（强约束：/mnt 9p 语义不完整 → 假阳性/假阴性） ──
case "$REPO" in /mnt/*) : ;; *)
  echo "note: repo path $REPO 不在 /mnt——若本机为原生 Linux（J-05 场景）请直接用 run-matrix.sh" >&2 ;;
esac
rm -rf ~/car-matrix
mkdir -p ~/car-matrix/artifacts
cp -r "$REPO/native" "$REPO/test" ~/car-matrix/
cp "$LR_SRC" ~/car-matrix/artifacts/landlock-run
chmod +x ~/car-matrix/artifacts/landlock-run

# ── G-06 第 4 断言点：WSL 发行版 node 版本（发行版默认无 node → informational，不阻塞逃逸门禁） ──
if command -v node >/dev/null 2>&1; then
  echo "G06-WSL-NODE: $(node -v)"
else
  echo "G06-WSL-NODE: not installed (informational — 逃逸矩阵不依赖 node)"
fi

# ── 步骤 3+5：环境自检（失败 exit 2 = 环境失败，§2.1.3 维护者 rerun 语义） + 20 条实跑 ──
cd ~/car-matrix
bash test/sandbox-escape/run-matrix.sh ~/car-matrix/artifacts/landlock-run ~/car-matrix/audit
