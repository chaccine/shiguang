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

| b4041cc | fix：顶部栏被 Android 状态栏遮挡（Android 15+/targetSdk 35+ 强制 edge-to-edge）。`android-overrides/MainActivity.kt`：系统栏/刘海/输入法 insets 作为根视图 padding，系统栏背后 #EAD9C6、深色图标；CI 在 `tauri android init` 后复制覆盖并删 `INTERNET` 权限（应用离线）；CSS `viewport-fit=cover` + 手机断点内 `env(safe-area-inset-*)`（Android 由原生 padding 处理，env 为 0，不叠加；桌面规则未改）；android job `CARGO_PROFILE_DEV_DEBUG=false` / `STRIP=true`；版本 0.1.1（versionCode 1001） | Grok Bot |
| （本提交） | 手机竖屏预览模拟截图脚本 `scripts/screenshots-mobile.mjs`（`npm run screenshots:mobile`）+ 截图；报告更新 | Grok Bot |

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
| 0.1.0 在 REDMI G Pro 上安装 + 启动 + 草稿列表显示 | **PASS（Cine 真机，2026-11-09）**；发现问题：顶部"拾光"标题与"草稿/时光"标签被状态栏遮挡 → 已在 b4041cc 修复 |
| 0.1.1 修复在真机上的效果（顶部不再遮挡、底部手势条、输入法弹出时不遮挡） | NOT_RUN（等 Cine 真机） |
| 0.1.1 修复的浏览器预览模拟（390×844，模拟 36px 状态栏 / 20px 手势条） | PASS（**预览模拟，非真机**）：`evidence/unit-0.3/01-before-statusbar-overlap.png` / `02-after-insets-padding.png` |
| 在真机上新建/编辑/存入草稿 | NOT_RUN（Cine 只报告了启动与草稿列表显示） |
| Android 上 `<input type=file>` 选照片 | NOT_RUN：代码层面 wry 0.55.1 的 `RustWebChromeClient.onShowFileChooser` 已实现系统选择器，未在设备上验证 |
| Android 上数据目录落盘（app_data_dir） | NOT_RUN：代码路径与桌面一致（`app.path().app_data_dir()` → `Store::open`，Android 为应用私有目录，`cfg(unix)` 目录 fsync 分支同样适用），未在设备上验证 |
| 切后台 flush | 仅 typecheck/构建通过；Android 上行为 NOT_RUN |
| 去掉 INTERNET 后应用仍能启动 | NOT_RUN（0.1.1 真机未测；Tauri 资源/IPC 走进程内自定义协议，预期无影响） |

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

## 0.1.1（状态栏修复）CI 与侧载 APK
CI：push run https://github.com/chaccine/shiguang/actions/runs/42588758511 、PR run https://github.com/chaccine/shiguang/actions/runs/42588767158（提交 b4041cc）。PR run 7/7 PASS（core+cli+ts ×3、tauri bundle ×3、android apk）。CI APK 现为 18,954,206 字节（.so 11.7MB，已无调试符号），versionName 0.1.1 / versionCode 1001，Manifest 无 INTERNET。

**签名注意**：CI runner 每次都新生成 debug keystore（run 42586346600 证书 `c89fce33…`，run 42588767158 证书 `753d0aa0…`），CI 产物之间**不能**覆盖升级。Cine 手机上装的 0.1.0 是 box 用 `~/.android/debug.keystore` 重签的版本（证书 SHA-256 `59dbe106e00efc187b10faf0c2839fd575de09a42f7a964dc94c00e309af766f`）。所以侧载包在 box 上重签：

- 文件：`/workspace/u03dl/拾光_0.1.1_arm64-debug.apk`，18,527,230 字节，sha256 `9951a1c2ca601975dbaa99b73990511b1da7aa77c04955d0c6109dfbb9157977`
- 做法：取 CI 产物 → `rust-objcopy --strip-all`（1.90.0 工具链）→ 重打包（.so、resources.arsc 为 STORED，去旧签名）→ `zipalign -f -p 4`（`zipalign -c` 通过）→ `apksigner sign`（box debug keystore，alias androiddebugkey）
- `apksigner verify`：Verifies，v2 + v3 签名；证书与已安装的 0.1.0 相同 → 应可直接覆盖升级（versionCode 1000 → 1001，数据保留）。覆盖安装本身在真机上 NOT_RUN。

## 已知限制 / 后续
- APK 体积：已从约 116MB 降到约 18MB（CI 里去调试符号）。release 构建 + 正式签名可更小；签名密钥属于凭据，需 Cine 决定。
- CI 签名不固定：每次 run 的 debug 证书不同。要让 CI 产物能直接覆盖升级，需要把一个固定的签名 keystore 放进 GitHub Secrets（凭据，需 Cine 决定）；在此之前侧载包由 box 重签。
- `gen/android` 未提交，CI 每次 `tauri android init` 生成，再用 `android-overrides/` 确定性覆盖（MainActivity、删 INTERNET）。以后定制更多（图标、权限）时再考虑提交 gen/android。
- 仅 arm64（REDMI G Pro 足够）；armv7/x86 未打。
- 移动端 UI 只依赖已有响应式样式（`max-width: 760px`），未做手机专门排版与截图。
- 沿用 Unit-0.1/0.2 未完成项：冲突副本选择界面、多进程写锁、G02 墓碑、schemaVersion 迁移、Windows NSIS（504）。
