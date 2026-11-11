# Unit-0.8 报告：草稿编辑器标签 + 真缩略图/HEIC + 压力测试 + 锁等待与截图修复 · 0.1.9（versionCode 1009）

- 分支：`feat/unit-0.8-polish`（由 main `3eace87` 拉出；**不合并**，由 Cine 决定）
- 规格：`evidence/unit-0.8/SPEC.md`
- 模型：Codex gpt-6.1-sol medium（`codex exec`，workspace-write）完成实现；编排侧补了锁文件、缩略图测试断言、截图脚本与证据（沙箱不能听 localhost、不能写 `.git`）
- 正式/发布签名：**未做**（Cine 已取消；未创建 release keystore，未向 CI/Secrets 添加正式签名）

## 测试

| 项 | 结果 |
| --- | --- |
| `cargo test --locked`（workspace：core + cli） | **184 通过 / 0 失败** |
| `cargo test --locked -p shiguang_core --features fault-injection` | **226 通过 / 0 失败** |
| `cargo test --locked --manifest-path thumbnails/Cargo.toml` | **1 通过 / 0 失败**（JPEG/PNG/GIF/WebP 真解码、缓存稳定、不改原图；有损 WebP 合成花纹可小于 320px PNG，尺寸上限才是硬约束） |
| `npm test` | **127 通过 / 0 失败**（14 个测试模块，含 `tests/unit08.test.ts`） |
| `npm run typecheck` / `npm run build` | PASS |
| 截图 u04 / u05 / u06 | **PASS**，page errors 0；已按 0.1.8 导航重跑（设置 → 打开回收站；默认时光轴） |
| 截图 unit-0.9（`screenshots-u09.mjs`） | **PASS**，page errors 0；8 张：编辑器加/建标签（桌面+手机）、时光轴缩略图、HEIC 占位 |

## 功能结论

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 版本 0.1.9 / versionCode 1009 | PASS（推导） | package、workspace、Tauri、两份既有 lockfile、README；CI 产物 aapt：versionCode 1009 / versionName 0.1.9 |
| 草稿编辑器加/改/建标签 | PASS（core + TS + 预览截图） | `set_record_tags` 允许未提交的 active 草稿行（CAS 仍在）；`set_favorite` 仍要求正式记录；丢弃从未提交的草稿会删行；commit 只发布内容、保留标签。真机/桌面壳 NOT_RUN |
| 列表真缩略图（JPEG/PNG/GIF/WebP） | PASS（crate 单测 + 浏览器预览） | 解码在独立 `thumbnails/` crate（`image` 0.25），不进 core。缓存 `previews/{assetId}.thumb-v2.png`，最大边 320px。时光轴/日历封面走 `photoThumbUrl`，不再拉原图。Tauri 壳在 CI 构建，本机无 webkit，桌面壳 check NOT_RUN/BLOCKED |
| HEIC/HEIF 嗅探 + 占位 | PASS（core 嗅探 + MemoryAdapter 预览截图） | 无法解码时显示「无法预览 HEIC 图片」，不崩溃 |
| Android ImageDecoder HEIC | NOT_RUN | `android-overrides/MainActivity.kt` + `src-tauri/src/android_thumb.rs` 已写，需 CI APK / 真机 |
| macOS ImageIO / sips HEIC | NOT_RUN | 代码已写，未在 macOS 上跑 |
| Windows WIC/WPF HEIC | NOT_RUN | 代码已写；系统可能没有 HEIF 扩展，失败应走占位 |
| Linux 原生 HEIC 解码 | NOT_RUN | 未引入 libheif（无 sudo）；走占位 |
| 写锁等待 15s + 多进程测试 | PASS（Linux） | 偏离 Unit-0.4 SPEC 的约 3s；正确性断言保留（80 条、seq 唯一、可解析、无丢失更新）。PR CI run 42937318633（tip `c357f1f`）Windows core+cli+ts **通过** |
| 5000 条合成压力测试 | PASS | 见下表；默认 CI 规模 200 |
| 旧截图脚本 0.4–0.6 | PASS | 见上 |

## 压力测试（合成数据）

Rust 1.90 debug，5000 条正式记录、5000 个照片引用，共享 **32** 张本地生成的小 PNG（不是 5000 张高分辨率相机原图）。`state.json` 6,209,093 字节；备份 8,573,843 字节。语料在临时目录，不入库。

复现：

```sh
SHIGUANG_STRESS_SIZE=5000 SHIGUANG_STRESS_OUT="$PWD/evidence/unit-0.8/stress.json" cargo test --locked -p shiguang_core --test unit08_stress -- --nocapture
```

| 测量 | 毫秒 |
| --- | ---: |
| Store::open | 511.529 |
| 时光轴首页 50 条 | 11.480 |
| 时光轴后续页（约第 10 页） | 7.409 |
| 备份导出 | 2406.035 |
| 覆盖恢复 | 6856.987 |

恢复后核对 5000 条正式记录与照片引用。发现的热点：JSON 解析对每个字符重复校验剩余文档（接近平方）；已改为一次只校验一个 UTF-8 标量，并保留严格 JSON 拒绝与多语言往返回归。`Store::open` 不会重建全部预览。不宣称未经完整前后对照的加速比。

## 截图

`evidence/unit-0.9/`（本单元，浏览器 MemoryAdapter，合成数据，不是真机）：

- desktop-create-tag.png / mobile-create-tag.png
- desktop-editor-tags.png / mobile-editor-tags.png
- desktop-timeline-thumbnails.png / mobile-timeline-thumbnails.png
- desktop-heic-placeholder.png / mobile-heic-placeholder.png

`evidence/unit-0.4`、`unit-0.5`、`unit-0.6` 的 PNG 已按当前导航重跑。`evidence/unit-0.8/` 里 0.1.8 导航截图未改。


## CI 与安装包

- PR：https://github.com/chaccine/shiguang/pull/7（**未合并**，由 Cine 决定）
- 分支 tip：`c357f1f`
- CI：**7/7 通过**，run https://github.com/chaccine/shiguang/actions/runs/42937318633 （head `c357f1f`）

| 文件 | 大小 | sha256 | 说明 |
| --- | ---: | --- | --- |
| `拾光_0.1.9_arm64-debug.apk` | 26,239,541 B | `8e724692ca50d8930fdf4afcc24074e3acda75254d59d6dfe968e47816f9a08f` | CI universal debug APK（已 strip）→ 去旧签名块 → `zipalign -p 4` → box `~/.android/debug.keystore`（androiddebugkey）重签；`apksigner verify` v2+v3 通过；证书 SHA-256 `59dbe106e00efc187b10faf0c2839fd575de09a42f7a964dc94c00e309af766f`（可覆盖安装 0.1.8，数据保留）；versionCode 1009 / versionName 0.1.9；权限仅 `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`，无 INTERNET。Drive：https://drive.google.com/file/d/1SBSJuE9at6ceYqs9WznjFqB_C-4-oo9y/view |
| `拾光_0.1.9_aarch64.dmg` | 4,533,925 B | `d8586a6bccb72a9d04ad2f73b5b782e3a92bad6bf143684646080fc49af526ec` | CI 未签名；本机 `/workspace/u09dl/` |
| `拾光_0.1.9_x64_zh-CN.msi` | 4,579,328 B | `f990a2aa9ff0e78e5b46de364d8fc870d68774e99470fa4432ca34306eeb14e2` | CI 未签名；本机 `/workspace/u09dl/` |

NSIS `.exe` 本次未出：CI 因 `nsis_tauri_utils.dll` 从 GitHub Releases 下载持续 504，Windows job 仍只打 MSI（见 `.github/workflows/ci.yml`）。Cine 已允许补做 NSIS，需另想办法（例如把 dll 放进仓库或换镜像）后再开。

## 未跑 / 未做 / 需 Cine 决定

- 真机与桌面安装包实际运行：NOT_RUN（等本 PR 的 APK / dmg / msi）
- 三端原生 HEIC 解码：NOT_RUN
- 本机 Tauri 桌面编译：预计仍 BLOCKED（box 无 webkit2gtk，与既往相同）
- Windows 多进程锁测试：需看本 PR 的 CI
- **正式/发布签名**：Cine 已取消，未创建 release keystore，未向 CI/Secrets 添加正式签名。
- 固定 debug keystore 已写入 GitHub Secrets（`ANDROID_DEBUG_KEYSTORE_*`，2026-11-11 09:31 Asia/Shanghai），CI 已改为重签并断言证书 SHA-256 `59dbe106…`。NSIS 工具包已预置在 `ci/windows-nsis/`，Windows job 启用 `msi,nsis`（第一种方案，尚未因失败改走第二/第三种）。Drive README 与 P0 决策已追加 2026-11-11 状态。工作仍在本分支 `feat/unit-0.8-polish` / PR #7（tip `2e7e33e`），未开新分支、未动 `main`。
- CI 核验 **BLOCKED**：push run 42940005230 与 PR run 42940011610 全部 job 未分配 runner。GitHub 标注账户付款失败或消费额度不足。最近一次实际跑完的绿色 CI 仍是 42937318633（`c357f1f`，7/7，当时尚未重签、只出 MSI）。未反复重跑。Cine 处理 GitHub Billing & plans 后可重跑 PR #7。

## 日志

`evidence/unit-0.8/`：cargo-test.log、fault-injection.log、thumbnail-test.log、npm-test.log、typecheck.log、build.log、stress.log / stress.json、screenshots-u04/u05/u06/u09.log、dependency-fetch.log、tauri-lockfile.log。
