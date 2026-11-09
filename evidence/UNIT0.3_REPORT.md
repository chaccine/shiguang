# Unit-0.3 Android APK（Tauri v2 mobile）｜验收报告

> 2026-11-09（Asia/Shanghai）· 分支 `feat/unit-0.3-android`（基线 `main@709b329`）· PR 未合并，由 Cine 决定。
> 只用合成数据；无付费服务、无部署。box 未安装 Android SDK（无 sudo，按约定只在 CI 构建）。

## 提交
| 提交 | 内容 | 执行者 |
|---|---|---|
| 9206cbf | CI 新增 `tauri android apk (ubuntu-latest)`：Java 17（temurin）、runner 预装 Android SDK + 最新 NDK、Rust 1.90.0 + 4 个 Android 目标、`tauri android init --ci`（gen/android 未提交时 CI 生成）、`tauri android build --ci --debug --apk --target aarch64`，上传 APK 与日志 | Grok Bot |
| abeda68 | ci-fix：Gradle wrapper 下载 10s 读超时 → `networkTimeout=120000`，构建重试 3 次，缓存 `~/.gradle` | Grok Bot |
| 22c006f | UI：`visibilitychange(hidden)` / `pagehide` 时立即 flush 草稿（Android 切后台/被回收时通常不触发 `beforeunload`） | Grok Bot |
| 1756828 | fix：`package.json` 增加 `"tauri": "tauri"` 脚本（Gradle 的 rustBuild 任务调用 `npm run tauri android android-studio-script`） | Grok Bot |

本单元改动小，未调用 CodeBuddy / Qoder / Codex。

## 验证结果
| 项 | 结果 |
|---|---|
| `cargo test --locked`（box，1.90.0） | PASS 52（15 / 13 / 14 / 10） |
| `cargo test --locked -p shiguang_core --features fault-injection` | PASS 61 |
| `npm test` | PASS 59/59 |
| `npm run typecheck` / `npm run build` | PASS / PASS |
| `bash scripts/run_acceptance.sh` | PASS |
| CI 7 个 job（run 42586346600） | PASS 7/7，见下 |
| APK 文件检查（box 下载后） | PASS：仅含 `lib/arm64-v8a/libshiguang_desktop_lib.so`；含 APK 签名块（v2，Android debug keystore） |
| 在 REDMI G Pro 上安装 / 启动 / 读写草稿 | NOT_RUN（等 Cine 真机） |
| Android 上 `<input type=file>` 选照片 | NOT_RUN：代码层面 wry 0.55.1 的 `RustWebChromeClient.onShowFileChooser` 已实现系统选择器，未在设备上验证 |
| Android 上数据目录落盘（app_data_dir） | NOT_RUN：代码路径与桌面一致（`app.path().app_data_dir()` → `Store::open`，Android 为应用私有目录，`cfg(unix)` 目录 fsync 分支同样适用），未在设备上验证 |
| 切后台 flush | 仅 typecheck/构建通过；Android 上行为 NOT_RUN |

## CI
Run（push，提交 1756828）：https://github.com/chaccine/shiguang/actions/runs/42586346600

| Job | 结果 |
|---|---|
| core+cli+ts (ubuntu / macos / windows) | PASS ×3 |
| tauri bundle (ubuntu / macos / windows) | PASS ×3（桌面未回退） |
| tauri android apk (ubuntu-latest) | PASS：artifact `shiguang-Android-arm64-debug-apk`（`universal/debug/app-universal-debug.apk`，121,454,450 字节） |

此前失败 run：42583668602（Gradle 发行包下载 10s 超时）、42585072148（缺 `npm run tauri` 脚本）。Rust 部分两次都已编译通过。

APK sha256：`308e2bb9237a929a3b135da6eb28b142989f321e264ec5c8ee727410b7dcc5ce`；minSdk 24，targetSdk 37，versionCode 1000，包名 `com.shiguang.unit0`。

下载：
```bash
gh run download 42586346600 -R chaccine/shiguang -n shiguang-Android-arm64-debug-apk
```
保留 14 天（至 2026-11-23）。安装：传到手机后打开 APK，按提示允许"安装未知应用"。debug 签名仅用于侧载测试，不能上架；以后换正式签名需先卸载此版本。

## 已知限制 / 后续
- APK 约 116MB：debug 构建带完整调试符号。后续可改为 release 构建 + 自有签名（或 strip）显著变小；正式签名密钥属于凭据，需 Cine 决定。
- `gen/android` 未提交，CI 每次 `tauri android init` 生成；模板自带 `INTERNET` 权限（应用本身不联网）。需要定制 Manifest（去掉 INTERNET、图标、权限）时再提交 gen/android。
- 仅 arm64（REDMI G Pro 足够）；armv7/x86 未打。
- 移动端 UI 只依赖已有响应式样式（`max-width: 760px`），未做手机专门排版与截图。
- 沿用 Unit-0.1/0.2 未完成项：冲突副本选择界面、多进程写锁、G02 墓碑、schemaVersion 迁移、Windows NSIS（504）。
