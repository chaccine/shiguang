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
  echo "- box 缺 webkit2gtk（无 sudo），本机不构建桌面壳；Tauri 三端打包与 Android APK 由 GitHub Actions 构建"
  echo "- 真机（Android / macOS / Windows）行为：见各单元报告，未实测项为 NOT_RUN"
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
cargo test --offline -p shiguang_core --features fault-injection >"$ACC/cargo-fault.log" 2>&1
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

echo "== U05 备份导出/校验/覆盖恢复（CLI，合成数据）=="
U05="$ACC/u05"
mkdir -p "$U05"
tree_sha() {
  # 数据根下除锁文件外每个文件的 sha256（相对路径排序）
  (cd "$1" && find . -type f ! -name '.write.lock' ! -name '.instance.lock' ! -name '*.owner' | LC_ALL=C sort | while read -r f; do
    printf '%s  %s\n' "$(sha_file "$f")" "$f"; done)
}
tree_sha "$DATA" >"$U05/source-before-export.sha"
shg export-backup "$U05/full.sgbak" >"$U05/export.json"
tree_sha "$DATA" >"$U05/source-after-export.sha"
cmp "$U05/source-before-export.sha" "$U05/source-after-export.sha" || { echo "FAIL: 导出改动了源数据" >&2; exit 1; }
"$BIN" verify-backup "$U05/full.sgbak" >"$U05/verify.json"
expect_fail "$U05/restore-without-yes.json" "$BIN" --data-dir "$U05/data-restored" restore-backup "$U05/full.sgbak"
node -e '
const fs = require("fs");
const buf = fs.readFileSync(process.argv[1]);
const flipped = Buffer.from(buf); flipped[Math.floor(buf.length / 2)] ^= 0xff;
fs.writeFileSync(process.argv[2], flipped);
fs.writeFileSync(process.argv[3], buf.subarray(0, buf.length - 20));
' "$U05/full.sgbak" "$U05/corrupt.sgbak" "$U05/truncated.sgbak"
expect_fail "$U05/verify-corrupt.json" "$BIN" verify-backup "$U05/corrupt.sgbak"
expect_fail "$U05/verify-truncated.json" "$BIN" verify-backup "$U05/truncated.sgbak"
# 坏包覆盖恢复到“现有数据”必须被拒绝且现有数据逐字节不变
mkdir -p "$U05/data-victim"
"$BIN" --data-dir "$U05/data-victim" draft-new --body "受害库的合成草稿" --date "2026-11-10" >"$U05/victim-draft.json"
tree_sha "$U05/data-victim" >"$U05/victim-before.sha"
expect_fail "$U05/restore-corrupt.json" "$BIN" --data-dir "$U05/data-victim" restore-backup "$U05/corrupt.sgbak" --yes
tree_sha "$U05/data-victim" >"$U05/victim-after.sha"
cmp "$U05/victim-before.sha" "$U05/victim-after.sha" || { echo "FAIL: 坏包恢复改动了现有数据" >&2; exit 1; }
# 好包覆盖恢复到受害库：内容 = 源库，且留下安全副本
"$BIN" --data-dir "$U05/data-victim" restore-backup "$U05/full.sgbak" --yes >"$U05/restore.json"
"$BIN" --data-dir "$U05/data-victim" dump >"$U05/restored-dump.json"
shg dump >"$U05/source-dump.json"
node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).state;
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).state;
const pick = (s) => JSON.stringify({ records: s.records, deletionMarkers: s.deletionMarkers, conflictCopies: s.conflictCopies, seq: s.seq, seed: s.seed, schemaVersion: s.schemaVersion });
if (pick(a) !== pick(b)) { console.error("FAIL: 恢复后状态与源库不一致"); process.exit(1); }
const r = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (!fs.existsSync(r.safetyBackupDir)) { console.error("FAIL: 缺少安全副本"); process.exit(1); }
console.log("U05 往返一致，记录数", a.records.length, "安全副本", r.safetyBackupDir);
' "$U05/source-dump.json" "$U05/restored-dump.json" "$U05/restore.json" >"$U05/roundtrip.log"
(cd "$DATA/media" && find . -type f | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(sha_file "$f")" "$f"; done) >"$U05/media-source.sha"
(cd "$U05/data-victim/media" && find . -type f | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(sha_file "$f")" "$f"; done) >"$U05/media-restored.sha"
cmp "$U05/media-source.sha" "$U05/media-restored.sha" || { echo "FAIL: 恢复后原图与源库不一致" >&2; exit 1; }

echo "== U06 合并导入/防复活/口令加密（CLI，合成数据；口令只走环境变量，不落日志）=="
U06="$ACC/u06"
rm -rf "$U06"; mkdir -p "$U06"
cp -R "$U05/data-victim" "$U06/data-merge"
rm -f "$U06/data-merge/.write.lock" "$U06/data-merge/.instance.lock"
first_id() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const rows=Array.isArray(j)?j:(j.records??j.rows??[]);process.stdout.write(rows[0].recordId)'; }
VICTIM_ID="$("$BIN" --data-dir "$U06/data-merge" list | first_id)"
"$BIN" --data-dir "$U06/data-merge" trash "$VICTIM_ID" >"$U06/trash.json"
"$BIN" --data-dir "$U06/data-merge" purge "$VICTIM_ID" >"$U06/purge.json"
"$BIN" --data-dir "$U06/data-merge" plan-merge "$U05/full.sgbak" >"$U06/plan.json"
expect_fail "$U06/merge-without-yes.json" "$BIN" --data-dir "$U06/data-merge" merge-backup "$U05/full.sgbak"
"$BIN" --data-dir "$U06/data-merge" merge-backup "$U05/full.sgbak" --yes >"$U06/merge1.json"
expect_fail "$U06/get-purged.json" "$BIN" --data-dir "$U06/data-merge" get "$VICTIM_ID"
"$BIN" --data-dir "$U06/data-merge" merge-backup "$U05/full.sgbak" --yes >"$U06/merge2.json"
node -e '
const fs = require("fs");
const read = (f) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); return j.plan ?? j; };
const plan = read(process.argv[1]), m1 = read(process.argv[2]), m2 = read(process.argv[3]);
const id = process.argv[4];
if (!plan.skippedDeleted.some((x) => x.recordId === id)) { console.error("FAIL: 计划未列出已永久删除的记录"); process.exit(1); }
if (m1.added !== 0) { console.error("FAIL: 旧包合并新增了记录", m1.added); process.exit(1); }
if (m2.added !== 0 || m2.updated !== 0 || m2.conflictCopiesAdded !== 0 || m2.mediaAdded !== 0) { console.error("FAIL: 重复合并不幂等"); process.exit(1); }
console.log("U06 防复活 + 幂等通过；skippedDeleted =", plan.skippedDeleted.length);
' "$U06/plan.json" "$U06/merge1.json" "$U06/merge2.json" "$VICTIM_ID" >"$U06/merge-check.log"
# 口令加密：随机合成口令，仅存在于本脚本进程环境变量中。
SHIGUANG_BACKUP_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64"))')"
export SHIGUANG_BACKUP_PASSWORD
shg export-backup "$U06/enc.sgbak" --encrypt --kdf-fast >"$U06/export-enc.json"
if grep -q "合成" "$U06/enc.sgbak"; then echo "FAIL: 加密包里出现明文" >&2; exit 1; fi
"$BIN" verify-backup "$U06/enc.sgbak" >"$U06/verify-enc.json"
tree_sha "$U06/data-merge" >"$U06/merge-before-wrong.sha"
expect_fail "$U06/verify-wrong.json" env SHIGUANG_BACKUP_PASSWORD="wrong-synthetic" "$BIN" verify-backup "$U06/enc.sgbak"
expect_fail "$U06/merge-wrong.json" env SHIGUANG_BACKUP_PASSWORD="wrong-synthetic" "$BIN" --data-dir "$U06/data-merge" merge-backup "$U06/enc.sgbak" --yes
expect_fail "$U06/merge-nopass.json" env -u SHIGUANG_BACKUP_PASSWORD "$BIN" --data-dir "$U06/data-merge" merge-backup "$U06/enc.sgbak" --yes
node -e '
const fs = require("fs");
const buf = fs.readFileSync(process.argv[1]);
const flipped = Buffer.from(buf); flipped[buf.length - 40] ^= 0x01;
fs.writeFileSync(process.argv[2], flipped);
' "$U06/enc.sgbak" "$U06/enc-tampered.sgbak"
expect_fail "$U06/merge-tampered.json" "$BIN" --data-dir "$U06/data-merge" merge-backup "$U06/enc-tampered.sgbak" --yes
tree_sha "$U06/data-merge" >"$U06/merge-after-wrong.sha"
cmp "$U06/merge-before-wrong.sha" "$U06/merge-after-wrong.sha" || { echo "FAIL: 错口令/篡改改动了现有数据" >&2; exit 1; }
"$BIN" --data-dir "$U06/data-merge" merge-backup "$U06/enc.sgbak" --yes >"$U06/merge-enc.json"
if grep -rqF -- "$SHIGUANG_BACKUP_PASSWORD" "$U06" "$ACC"/*.log 2>/dev/null; then echo "FAIL: 口令出现在输出/日志里" >&2; exit 1; fi
unset SHIGUANG_BACKUP_PASSWORD
echo "U06 加密：错口令/缺口令/篡改均拒绝且数据不变；正确口令合并成功；口令未出现在任何输出中" >"$U06/crypto-check.log"

echo "== 6/6 AC-U0-11 manifest 与总校验 =="
shg manifest --out "$EVID/manifest.json" \
  --rustc "$RUSTC_VERSION" \
  --node "$NODE_VERSION" \
  --npm "$NPM_VERSION" \
  --tauri "BLOCKED: 见 evidence/tauri-cargo-check.log" >"$ACC/manifest-export.json"

npm run verify:evidence >"$ACC/verify-evidence.log" 2>&1

echo "验收脚本完成。产物：$ACC"
