#!/usr/bin/env bash
# 把仓库内固定的 NSIS 工具包预置到 Tauri 缓存目录，避免构建时从 GitHub Releases 下载失败。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export SG_NSIS_SRC="$ROOT/ci/windows-nsis"
if [[ -z "${LOCALAPPDATA:-}" ]]; then
  echo "LOCALAPPDATA is not set; this script is for the Windows CI runner." >&2
  exit 1
fi
export SG_TAURI_DIR="${LOCALAPPDATA}/tauri"
export SG_NSIS_DIR="${SG_TAURI_DIR}/NSIS"
python3 << 'PY'
import hashlib, os, shutil, zipfile
from pathlib import Path

src = Path(os.environ["SG_NSIS_SRC"])
tauri_dir = Path(os.environ["SG_TAURI_DIR"])
nsis_dir = Path(os.environ["SG_NSIS_DIR"])
dll_sha1 = "75197fee3c6a814fe035788d1c34ead39349b860"
zip_sha1 = "db14f8af2ea346b786c6ae19343f61aaf5e09b8e"

def sha1(p: Path) -> str:
    return hashlib.sha1(p.read_bytes()).hexdigest()

zip_path = src / "nsis-3.13.zip"
dll_src = src / "nsis_tauri_utils.dll"
if not zip_path.is_file() or not dll_src.is_file():
    raise SystemExit("missing vendored NSIS files under ci/windows-nsis/")
got_zip, got_dll = sha1(zip_path), sha1(dll_src)
if got_zip != zip_sha1:
    raise SystemExit(f"nsis-3.13.zip sha1 {got_zip} != {zip_sha1}")
if got_dll != dll_sha1:
    raise SystemExit(f"nsis_tauri_utils.dll sha1 {got_dll} != {dll_sha1}")

tauri_dir.mkdir(parents=True, exist_ok=True)
# Always reseat from the pinned zip so a stale actions/cache copy cannot drift.
if nsis_dir.exists():
    shutil.rmtree(nsis_dir)
if True:
    staging = tauri_dir / "nsis-extract"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(staging)
    extracted = staging / "nsis-3.13"
    if not extracted.is_dir():
        candidates = [p for p in staging.iterdir() if p.is_dir()]
        if len(candidates) != 1:
            raise SystemExit(f"unexpected zip layout: {list(staging.iterdir())}")
        extracted = candidates[0]
    shutil.move(str(extracted), str(nsis_dir))
    shutil.rmtree(staging, ignore_errors=True)

dest = nsis_dir / "Plugins" / "x86-unicode" / "additional" / "nsis_tauri_utils.dll"
dest.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(dll_src, dest)
if sha1(dest) != dll_sha1:
    raise SystemExit("copied dll hash mismatch")
print(f"seeded NSIS at {nsis_dir}")
print(f"seeded dll at {dest}")
PY
