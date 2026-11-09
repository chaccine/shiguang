#!/usr/bin/env bash
# Unit-0 验收驱动：仅使用合成数据（SHIGUANG_SEED=20261109）。
# 用法：bash scripts/run_acceptance.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export SHIGUANG_SEED="20261109"
export SHIGUANG_CLOCK="2026-11-09T10:00:00Z"

EVID="$ROOT/evidence"
ACC="$EVID/acceptance"
DATA="$ACC/data"
BIN="$ROOT/target/debug/shiguang"

rm -rf "$ACC"
mkdir -p "$ACC"
rm -f "$EVID/manifest.json" "$EVID/ENV_VERSIONS.md"

echo "== 1/6 记录环境与构建 =="
RUSTC_VERSION="$(rustc --version)"
CARGO_VERSION="$(cargo --version)"
NODE_VERSION="$(node --version)"
NPM_VERSION="$(npm --version)"
OS_VERSION="$(uname -srm)"
CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

{
  echo "# ENV_VERSIONS（Unit-0 / 桌面 Linux box）"
  echo
  echo "- 采集时间（UTC）：$CAPTURED_AT"
  echo "- OS：$OS_VERSION"
  echo "- rustc：$RUSTC_VERSION"
  echo "- cargo：$CARGO_VERSION"
  echo "- node：$NODE_VERSION"
  echo "- npm：$NPM_VERSION"
  echo "- 验收固定时钟：SHIGUANG_CLOCK=2026-11-09T10:00:00Z"
  echo "- SHIGUANG_SEED：20261109"
  echo "- pkg-config：未安装（command -v pkg-config 无结果）"
  echo "- webkit2gtk-4.1 / gtk+-3.0：无法通过 pkg-config 探测；环境无 sudo/apt/全局安装权限"
  echo "- Tauri 构建：BLOCKED，详见 evidence/tauri-cargo-check.log 与 UNIT0_REPORT.md"
  echo "- Android / 第二桌面 OS：NOT_RUN"
  echo
  echo "## 工具链原位输出"
  echo
  echo "    $ rustc --version"
  echo "    $RUSTC_VERSION"
  echo "    $ cargo --version"
  echo "    $CARGO_VERSION"
  echo "    $ node --version"
  echo "    $NODE_VERSION"
  echo "    $ npm --version"
  echo "    $NPM_VERSION"
  echo "    $ uname -srm"
  echo "    $OS_VERSION"
} > "$EVID/ENV_VERSIONS.md"

cargo build --offline -p shiguang >"$ACC/cargo-build.log" 2>&1

echo "== 2/6 Rust 与前端测试 =="
cargo test --offline >"$ACC/cargo-test.log" 2>&1
npm run test >"$ACC/frontend-test.log" 2>&1
npm run typecheck >"$ACC/frontend-typecheck.log" 2>&1
npm run build >"$ACC/frontend-build.log" 2>&1

shg() { "$BIN" --data-dir "$DATA" "$@"; }
jget() {
  node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let cur = value;
for (const key of process.argv[2].split(".")) {
  cur = cur == null ? undefined : cur[key];
}
process.stdout.write(typeof cur === "object" ? JSON.stringify(cur) : String(cur));
' "$1" "$2"
}
expect_fail() {
  local out="$1"; shift
  set +e
  "$@" >"$out" 2>"$out.err"
  local code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    echo "FAIL: 期望失败却成功：$*" >&2
    exit 1
  fi
}
sha_file() {
  node -e '
const crypto = require("crypto");
const fs = require("fs");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$1"
}

shg init >"$ACC/init.json"

echo "== 3/6 AC-U0-02 仅标题拒绝 =="
shg draft-new --title "只有标题" --date "2026-11-09" >"$ACC/title-draft.json"
TITLE_ID="$(jget "$ACC/title-draft.json" "record.recordId")"
expect_fail "$ACC/commit-title-rejected.json" shg commit "$TITLE_ID"

shg draft-new --body "有正文但缺日期" >"$ACC/no-date-draft.json"
NODATE_ID="$(jget "$ACC/no-date-draft.json" "record.recordId")"
expect_fail "$ACC/commit-no-date-rejected.json" shg commit "$NODATE_ID"

echo "== 4/6 AC-U0-03/04 草稿持久化、强杀、正式提交 =="
shg draft-new --title "重启测试" --body "重启前写入的正文" --date "2026-11-08" >"$ACC/draft-created.json"
DRAFT_ID="$(jget "$ACC/draft-created.json" "record.recordId")"
shg get "$DRAFT_ID" >"$ACC/draft-before-restart.json"
shg get "$DRAFT_ID" >"$ACC/draft-after-restart.json"

shg draft-save "$DRAFT_ID" --body "强杀前的正文（已落盘）" --hold-ms 60000 >"$ACC/draft-kill.log" 2>&1 &
KILL_PID=$!
for _ in $(seq 1 100); do
  if [ -s "$ACC/draft-kill.log" ]; then break; fi
  sleep 0.1
done
sleep 0.2
kill -9 "$KILL_PID" 2>/dev/null || true
wait "$KILL_PID" 2>/dev/null || true
shg get "$DRAFT_ID" >"$ACC/draft-after-kill.json"

shg commit "$DRAFT_ID" >"$ACC/commit-first.json"
shg get "$DRAFT_ID" >"$ACC/formal-after-commit.json"

echo "== AC-U0-05 正式列表排除草稿 =="
shg draft-new --title "只是草稿" --body "绝不应出现在时间轴" --date "2026-11-09" >"$ACC/pure-draft.json"
PURE_ID="$(jget "$ACC/pure-draft.json" "record.recordId")"
shg list >"$ACC/list-after-pure-draft.json"

echo "== 5/6 AC-U0-06/07 媒体 asset 与预览 =="
shg fixture --out "$ACC/fixtures/window.png" --seed "synthetic-window" >"$ACC/fixture-a.json"
shg fixture --out "$ACC/fixtures/tea.png" --seed "synthetic-tea" >"$ACC/fixture-b.json"
shg draft-new --body "两张合成图，各自 caption" --date "2026-11-06" >"$ACC/photo-draft.json"
PHOTO_ID="$(jget "$ACC/photo-draft.json" "record.recordId")"
shg attach "$PHOTO_ID" --asset "$ACC/fixtures/window.png" --caption "第一张：窗外的光" >"$ACC/photo-a.json"
shg attach "$PHOTO_ID" --asset "$ACC/fixtures/tea.png" --caption "第二张：桌上的茶" >"$ACC/photo-b.json"
shg ensure-previews >"$ACC/previews-first.json"
PREVIEW_DIR="$DATA/previews"
{
  for f in "$PREVIEW_DIR"/*.preview.png; do
    printf '%s  %s\n' "$(sha_file "$f")" "$(basename "$f")"
  done
} >"$ACC/previews-before-clear.sha"
shg assets >"$ACC/assets-before-clear.json"
shg commit "$PHOTO_ID" >"$ACC/photo-commit.json"
shg list >"$ACC/list-with-photos.json"

rm -rf "$PREVIEW_DIR"
shg get "$PHOTO_ID" >"$ACC/photo-after-preview-loss.json"
shg assets >"$ACC/assets-after-preview-loss.json"
shg ensure-previews >"$ACC/previews-rebuilt.json"
{
  for f in "$PREVIEW_DIR"/*.preview.png; do
    printf '%s  %s\n' "$(sha_file "$f")" "$(basename "$f")"
  done
} >"$ACC/previews-after-rebuild.sha"
shg assets >"$ACC/assets-after-rebuild.json"

echo "== AC-U0-08/09 修改草稿与再次提交 =="
shg draft-new --body "编辑前的正式正文" --date "2026-11-05" --time "19:20" >"$ACC/edit-draft.json"
EDIT_ID="$(jget "$ACC/edit-draft.json" "record.recordId")"
shg commit "$EDIT_ID" >"$ACC/edit-first-commit.json"
shg draft-new --base "$EDIT_ID" >"$ACC/edit-base.json"
shg draft-save "$EDIT_ID" --body "尚未提交的修改" >"$ACC/edit-pending-save.json"
shg list >"$ACC/list-with-pending-edit.json"
shg get "$EDIT_ID" >"$ACC/edit-pending-get.json"
shg commit "$EDIT_ID" >"$ACC/edit-second-commit.json"
shg list >"$ACC/list-after-edit-commit.json"

echo "== AC-U0-10 未来日期且无时刻 =="
shg draft-new --body "未来的日期，不伪造时刻" --date "2099-12-31" >"$ACC/future-draft.json"
FUTURE_ID="$(jget "$ACC/future-draft.json" "record.recordId")"
shg commit "$FUTURE_ID" >"$ACC/future-commit.json"
shg get "$FUTURE_ID" >"$ACC/future-get.json"
shg dump >"$ACC/dump.json"

echo "== 6/6 AC-U0-11 manifest 与总校验 =="
shg manifest --out "$EVID/manifest.json" \
  --rustc "$RUSTC_VERSION" \
  --node "$NODE_VERSION" \
  --npm "$NPM_VERSION" \
  --tauri "BLOCKED: 见 evidence/tauri-cargo-check.log" >"$ACC/manifest-export.json"

npm run verify:evidence >"$ACC/verify-evidence.log" 2>&1

echo "验收脚本完成。产物：$ACC"
