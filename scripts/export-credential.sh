#!/usr/bin/env bash
# 本地凭证导出启动器（macOS / Linux / Windows Git Bash 通用）
#
# 作用：找到本机的 WorkBuddy 可执行文件，用它的 Electron 运行时跑 export-credential.cjs。
# 不写死任何版本号或安装路径 —— 优先环境变量，其次 PATH，最后在常见安装根目录里搜。
#
# 用法：
#   bash scripts/export-credential.sh              # 导出 + 自检
#   bash scripts/export-credential.sh --no-verify  # 只导出，不发网络请求
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$SCRIPT_DIR/export-credential.cjs"
CACHE_FILE="$SCRIPT_DIR/../.local/workbuddy.path"

# ---------- 1) 找 WorkBuddy 可执行文件 ----------
# 策略：环境变量 → PATH(command -v) → 上次缓存 → 常见安装路径精确探测 → 有界目录搜索
# 全程不写死版本号；搜索限制深度，避免整盘扫描卡住。
find_workbuddy() {
  # a) 显式指定优先
  if [[ -n "${WORKBUDDY_EXE:-}" && -x "${WORKBUDDY_EXE}" ]]; then
    printf '%s' "$WORKBUDDY_EXE"; return 0
  fi

  # b) PATH 里找（用 command -v，不猜路径）
  local cand
  for cand in WorkBuddy workbuddy; do
    if command -v "$cand" >/dev/null 2>&1; then
      command -v "$cand"; return 0
    fi
  done

  # c) 上次找到的路径（缓存）
  if [[ -f "$CACHE_FILE" ]]; then
    local cached
    cached="$(head -n1 "$CACHE_FILE" 2>/dev/null || true)"
    if [[ -n "$cached" && -x "$cached" ]]; then
      printf '%s' "$cached"; return 0
    fi
  fi

  # d) 常见安装路径精确探测（命中即返回，几乎零成本）
  local pf86="" home="${HOME:-}"
  pf86="$(printenv 'ProgramFiles(x86)' 2>/dev/null || true)"
  local direct=(
    "${LOCALAPPDATA:-}/Programs/WorkBuddy/WorkBuddy.exe"
    "${LOCALAPPDATA:-}/WorkBuddy/WorkBuddy.exe"
    "${LOCALAPPDATA:-}/Programs/workbuddy/WorkBuddy.exe"
    "${PROGRAMFILES:-}/WorkBuddy/WorkBuddy.exe"
    "$pf86/WorkBuddy/WorkBuddy.exe"
    "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy"
    "$home/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy"
    "/opt/WorkBuddy/workbuddy"
    "/usr/local/bin/workbuddy"
  )
  local p
  for p in "${direct[@]}"; do
    [[ -n "$p" && -x "$p" ]] && { printf '%s' "$p"; return 0; }
  done

  # e) 有界搜索：只在「装应用的地方」找，深度 ≤3
  echo "… 正在定位 WorkBuddy 安装目录（最多几秒）" >&2
  local roots=(
    "${LOCALAPPDATA:-}/Programs"
    "${PROGRAMFILES:-}"
    "$pf86"
    "${ProgramData:-}"
    "/Applications"
    "/c/Program Files"
    "/d/Program Files"
    "/e/Program Files"
    "/f/Program Files"
  )
  # 再加各盘根目录，但只往下 2 层（腾讯系安装器常装在盘根自建目录里）
  local drive
  for drive in /c /d /e /f; do
    [[ -d "$drive" ]] && roots+=("$drive")
  done

  local root depth hit
  for root in "${roots[@]}"; do
    [[ -n "$root" && -d "$root" ]] || continue
    depth=3
    [[ "$root" =~ ^/[cdef]$ ]] && depth=2
    hit="$(find "$root" -maxdepth "$depth" -type f \( -iname 'WorkBuddy.exe' -o -iname 'workbuddy' -o -iname 'WorkBuddy' \) 2>/dev/null | head -n1 || true)"
    if [[ -n "$hit" ]]; then printf '%s' "$hit"; return 0; fi
  done

  return 1
}

WORKBUDDY_BIN="$(find_workbuddy || true)"
if [[ -z "$WORKBUDDY_BIN" ]]; then
  cat >&2 <<'MSG'
❌ 没找到 WorkBuddy 可执行文件。

请用下面任一方式告诉脚本它在哪：

  # 方式一：临时指定
  WORKBUDDY_EXE="/path/to/WorkBuddy.exe" bash scripts/export-credential.sh

  # 方式二：加进 PATH 后重试
  export PATH="/path/to/workbuddy-dir:$PATH"

macOS 默认在 /Applications/WorkBuddy.app；Windows 请指向安装目录下的 WorkBuddy.exe。
MSG
  exit 1
fi

echo "▶ 使用运行时：$WORKBUDDY_BIN"
echo "▶ 入口脚本  ：$ENTRY"

# 记住这次找到的路径，下次直接命中（.local/ 已被 gitignore 忽略）
if [[ -x "$WORKBUDDY_BIN" ]]; then
  mkdir -p "$(dirname "$CACHE_FILE")" 2>/dev/null || true
  printf '%s\n' "$WORKBUDDY_BIN" > "$CACHE_FILE" 2>/dev/null || true
fi
echo

# ---------- 2) 跑起来 ----------
ELECTRON_RUN_AS_NODE=1 "$WORKBUDDY_BIN" "$ENTRY" "$@"
