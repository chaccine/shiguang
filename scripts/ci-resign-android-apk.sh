#!/usr/bin/env bash
# 用 GitHub Secrets 中的固定 debug keystore 重签 CI APK，使证书与盒上重签包一致，可覆盖安装。
# 不向日志打印口令、别名值或 keystore 字节。
set -euo pipefail
EXPECTED_CERT_SHA256="59dbe106e00efc187b10faf0c2839fd575de09a42f7a964dc94c00e309af766f"
: "${ANDROID_DEBUG_KEYSTORE_BASE64:?ANDROID_DEBUG_KEYSTORE_BASE64 secret is missing}"
: "${ANDROID_DEBUG_KEYSTORE_PASSWORD:?ANDROID_DEBUG_KEYSTORE_PASSWORD secret is missing}"
: "${ANDROID_DEBUG_KEY_ALIAS:?ANDROID_DEBUG_KEY_ALIAS secret is missing}"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$SDK" ]]; then
  echo "ANDROID_SDK_ROOT/ANDROID_HOME is not set" >&2
  exit 1
fi
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -n 1 || true)"
if [[ -z "$BT" ]]; then
  echo "No Android build-tools found under $SDK" >&2
  exit 1
fi
ZIPALIGN="$BT/zipalign"
APKSIGNER="$BT/apksigner"
[[ -x "$ZIPALIGN" && -x "$APKSIGNER" ]] || { echo "zipalign/apksigner missing in $BT" >&2; exit 1; }

mapfile -t APKS < <(find src-tauri/gen/android/app/build/outputs/apk -name '*.apk' -type f | sort)
if [[ ${#APKS[@]} -eq 0 ]]; then
  echo "No APK found under src-tauri/gen/android/app/build/outputs/apk" >&2
  exit 1
fi

WORK="${RUNNER_TEMP:-/tmp}/shiguang-resign"
rm -rf "$WORK"
mkdir -p "$WORK"
KS="$WORK/debug.keystore"
export KS
python3 - << 'PY'
import base64, os, pathlib, sys
raw = os.environ["ANDROID_DEBUG_KEYSTORE_BASE64"].encode("ascii")
# tolerate accidental whitespace/newlines in the secret
raw = b"".join(raw.split())
pathlib.Path(os.environ["KS"]).write_bytes(base64.b64decode(raw))
print(f"keystore bytes written: {pathlib.Path(os.environ['KS']).stat().st_size}", file=sys.stderr)
PY

resign_one() {
  local src="$1"
  local base
  base="$(basename "$src")"
  local unsigned="$WORK/${base}.unsigned.apk"
  local aligned="$WORK/${base}.aligned.apk"
  local signed="$WORK/${base}.signed.apk"
  python3 - << PY
import zipfile
from pathlib import Path
src = Path("$src")
dst = Path("$unsigned")
sig_suffixes = (".SF", ".RSA", ".DSA", ".EC")
with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(dst, "w") as zout:
    for info in zin.infolist():
        name = info.filename
        base = name.rsplit("/", 1)[-1]
        if name.startswith("META-INF/") and (
            base.endswith(sig_suffixes) or base == "MANIFEST.MF" or base.startswith("CERT.")
        ):
            continue
        zout.writestr(info, zin.read(info.filename))
PY
  "$ZIPALIGN" -p -f 4 "$unsigned" "$aligned"
  "$ZIPALIGN" -c -p 4 "$aligned"
  "$APKSIGNER" sign \
    --ks "$KS" \
    --ks-key-alias "$ANDROID_DEBUG_KEY_ALIAS" \
    --ks-pass "pass:${ANDROID_DEBUG_KEYSTORE_PASSWORD}" \
    --key-pass "pass:${ANDROID_DEBUG_KEYSTORE_PASSWORD}" \
    --out "$signed" \
    "$aligned"
  "$APKSIGNER" verify --verbose --print-certs "$signed" | tee "$WORK/${base}.verify.txt"
  python3 - << PY
from pathlib import Path
text = Path("$WORK/${base}.verify.txt").read_text()
needle = "$EXPECTED_CERT_SHA256"
# apksigner prints the digest without separators, lower/upper may vary
ok = needle.lower() in text.lower().replace(":", "").replace(" ", "")
# also accept colon-separated
colon = ":".join(needle[i:i+2] for i in range(0, 64, 2))
ok = ok or colon.lower() in text.lower()
if "Verifies" not in text:
    raise SystemExit("apksigner did not report Verifies")
if not ok:
    raise SystemExit("APK certificate SHA-256 does not match the pinned debug certificate")
print("certificate SHA-256 matches pinned debug key")
PY
  cp -f "$signed" "$src"
  echo "resigned $src"
}

# KS path for python
export KS
for apk in "${APKS[@]}"; do
  resign_one "$apk"
done
# Do not leave the keystore in the workspace
rm -rf "$WORK"
echo "all APKs resigned with pinned debug certificate"
