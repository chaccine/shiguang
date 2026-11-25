# Unit-0.12 requested Android trial APK delivery

Authorized by Cine 2026-11-25, PR10 remains unmerged. No rebuild, code changes, desktop packaging, signing operation or secret/auth access.

## Artifact and version
- Source: successful CI run 45596206197, code head c898fde13eb8b01efd684a52160396a26a6a4703; artifact 15014270036, shiguang-Android-arm64-debug-apk.
- Current repo tip 66e750d differs from c898fde only in documentation and browser evidence, not application/signing/build code.
- Downloaded existing APK byte-for-byte and copied under a user-facing filename.
- Local file: /workspace/u12-delivery/拾光_0.1.12_arm64-debug.apk
- Size 27017781 bytes. ABI arm64-v8a. Package com.shiguang.unit0. versionName 0.1.12, versionCode 1012. minSdk 24, targetSdk 37.
- SHA256 dd9c1d79cbe7b43e11d4a294ba74e7ecec33a2acdbda66d5abc6fba0aa30f544
- INTERNET permission not present in actual manifest badging.

## Signature and upgrade prerequisites
Official Android Build Tools 35 apksigner verify --verbose --print-certs: Verifies; APK v2 and v3 verified. No key/private credential needed or read. Portable JRE and official Build Tools downloaded to /workspace/u12-delivery/tools only; no sudo/global installs.
- Signer certificate SHA256: 59dbe106e00efc187b10faf0c2839fd575de09a42f7a964dc94c00e309af766f.
- Actual local /workspace/u09dl/拾光_0.1.9_arm64-debug.apk verified by the same tool: same signer digest and com.shiguang.unit0, code 1009. New code 1012 is higher.
- Digest matches repository pinned fixed debug cert. Signing script and CI workflow unchanged from merged 0.1.11 through this APK's source. We did not have an actual 0.1.11 APK to compare independently; 0.1.11 continuity here uses unchanged pinned signing pipeline evidence, not a claimed direct APK comparison.
- Same package/signature and higher version satisfy normal Android update prerequisites for that chain; installation/data retention NOT tested or guaranteed. If Android reports a signature conflict or downgrade, STOP; do not uninstall the old app. Make an independent external backup before testing.

## Drive delivery verified
Fresh folder search resolved 拾光 Shiguang -> 1OqmX1Z0IbvOV-2jPF0noXXzs3DNsz2vm.
Uploaded file ID 16nLW-UNI3KJ0uk4yQBuI17AB7OqVwzDL.
https://drive.google.com/file/d/16nLW-UNI3KJ0uk4yQBuI17AB7OqVwzDL/view
Metadata reread confirmed exact filename, APK MIME, size 27017781 and parents=[1OqmX1Z0IbvOV-2jPF0noXXzs3DNsz2vm]. No permission widening/share operation. Remote hash absent from metadata, so no unsupported remote-byte checksum claim.

## NOT_RUN / focused trial
Native Android install/upgrade/data retention, phone 390/360 layout, keyboard/IME, touch and real-device latency remain NOT_RUN. Existing wide-browser checks are PARTIAL, not phone evidence.
Try: (1) backup outside app, install as update without uninstalling, check existing records/photos/tags; (2) search caption/location plus tags/date/favorite/photo filter and read/back; (3) light/night narrow-screen scrolling, keyboard and favorites/museum linkage. Existing formal/draft separation must hold.

## Latest requested development model (separate from APK reuse)
Fresh official Codex model/list now includes exact gpt-6.2-astra (GPT-6.2-Astra), with max reasoning and fast speed tier (priority service tier). Full local response /workspace/u12-delivery/model-list-latest.json. This is not gpt-6-astra. No new coding task or paid service/account change launched for this APK; before later coding, use only owner-authorized gpt-6.2-astra max+fast with minimal request confirmation. No downgrade/substitution.
