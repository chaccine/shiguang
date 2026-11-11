# Unit-0.10 报告草稿：M01 / M06 / M07 · 0.1.10（versionCode 1010）

- 分支：`unit-0.10`；基线 `main b882029`（0.1.9），本轮开始及交付 HEAD `b19bcfc`。
- 规格：[SPEC](unit-0.10/SPEC.md)、[A–C 实施记录](unit-0.10/REPORT.md)、[设计系统](unit-0.10/DESIGN_SYSTEM.md)。本报告汇总当前实现及 Task D 实际验证，不覆盖历史记录。
- 已核对 README、UNIT0.8_REPORT、仓库各单元 SPEC，以及 `/workspace/specs/` 的 m01 + audit（v1.3）、m06 + audit、m07 + audit、contract G01–G06、outline（实际文件为 v2.6，包含历史 v2.5）。本轮授权优先于旧规划中的未开工表述。
- 全部为合成夹具；无真实私人数据、秘密或 keystore。无网络/云/AI 功能，无 Android INTERNET 权限变更。未改领域模型、MemoryAdapter、Tauri adapter 或 Rust core；既有测试与 G01–G06 断言未修改。
- 本轮不 stage、commit、merge 或 push；`.git` 只读，提交由编排侧执行。原先未跟踪的 `src-tauri/gen/` 不纳入交付。
- CI: GitHub Actions run 42979346894 (PR #8, code tip b19bcfc) **7/7 success**；更早 run 42974345706（322c906）7/7 success。最终代码提交 94faa12：run 42980602822 **7/7 success**。

## PASS

### 本地自动验证

Rust 1.90.0（`export PATH=$HOME/.cargo/bin:$PATH`）、Node v24.22.1、npm 11.21.1；使用锁定且已缓存的依赖。`--offline` 禁止测试过程取包。

| 命令 | 实际结果 | 日志（unit-0.10/） |
| --- | --- | --- |
| `cargo test --offline --locked --workspace` | **213 passed / 0 failed / 1 ignored** | task-d-cargo-test.log |
| `cargo test --offline --locked -p shiguang_core --features fault-injection` | **258 passed / 0 failed / 1 ignored**（含正常核心；较默认核心多 55 项故障/锁回退用例） | task-d-fault-injection.log |
| `npm test` | **21 个测试文件 passed / 0 failed** | task-d-npm-test.log |
| `node --test --test-isolation=none tests/*.test.ts` | **170 项 passed / 0 failed / 0 skipped** | task-d-npm-cases.log |
| `npm run typecheck` | **PASS** | task-d-typecheck.log |
| `npm run build` | **PASS** | task-d-build.log |
| `node --check scripts/screenshots-u10.mjs` | **PASS，仅语法** | task-d-syntax-check.log |
| `npm run build && node scripts/screenshots-u10.mjs`（编排侧，沙箱外，2026-11-11 15:5x UTC+8） | **PASS：32 张合成截图，page errors 0** | unit-0.10/screenshots-result.json、unit-0.10/*.png |
| `git diff --check` | **PASS** | 本地检查 |

唯一 ignored 是历史 v3 夹具生成器，仅能在原 v3 核心显式运行；冻结旧库与旧备份的兼容性用例实际执行。故障注入模拟写入失败，不等于真实设备断电。前端逐项计数是同一套测试的另一种 Node 运行模式，不能与文件计数相加。

### 当前功能结论（A–C 已落实现，本轮重跑自动回归）

| 项目 | 已实现范围与证据边界 |
| --- | --- |
| M01 schema v4 | 使用位独立说明、显式封面、有序照片、手写地点、可选心情；正式/草稿/冲突快照同构，显式提交与 CAS 保留。旧版本迁移、冻结 v3 明文/加密包、v4 备份/合并回归通过。 |
| M01 阅读与编辑 | 正式只读阅读与明确编辑入口；封面、正文、有序相册和纯文本说明；编辑器说明/封面/上移下移/地点/心情。自动保存与 formal 隔离有测试，像素和真机效果未验证。 |
| M06 导航与主题 | 默认时光轴；手机五入口、桌面侧栏；我的集中二级功能。A 暖纸本和独立“灯下展馆”，light/dark/system、首屏缓存、系统事件及本机 100/115/130% 字号。 |
| M06 无障碍 | token 对比度计算、结构/触控 CSS 约束及 DOM 事件测试通过；不等于浏览器布局、读屏或完整 WCAG 验收通过。 |
| M07 存储 | Rust 只读分类统计及两 adapter 契约；跳过符号链接，不自动清理原图/记录。预览为明确标注的合成数字，剩余空间未知。 |
| M07 应用锁 | 原生 Argon2id、失败限速、启用/改码/关闭及 UI 启动门禁/遮挡/60 秒重锁逻辑；便携备份不带锁凭据，恢复保留目标锁。DOM/核心回归通过，真实生命周期未验证。 |
| 博物馆入口 | 仅明确“建设中”占位；无展区、推荐或 M04 功能。M05 搜索、M08 均未增加。 |

应用锁只是 UI 门禁，**不加密本机文件**，不是 IPC 授权；最近任务系统截图保护未实现。忘记码没有应用内恢复接口；文件可读写者可退出后手动审阅重置偏好，普通 Android 用户可能没有文件访问权限。备份加密口令独立，丢失无法找回。MemoryAdapter 仅用 PBKDF2 模拟预览门禁，不代表原生 Argon2id 或真实 `.sgbak` 格式。

### 截图脚本交付

新增 `scripts/screenshots-u10.mjs`，沿用 u09 的 Playwright + preview-server 与真实 MemoryAdapter。两个隔离浏览器上下文分别为手机 **390×844**、桌面 **1280×960**；固定中文 locale/上海时区，浅色启动。通过 API 创建一条合成正式记录及两张 canvas 生成 PNG，无真实文件或远程媒体。

编排侧在可启动 Chrome 的环境执行：

```sh
npm run screenshots:u10
# Chrome 不在默认位置时：CHROME_PATH=/path/to/chrome npm run screenshots:u10
```

预期 **32 张** PNG，输出至 `evidence/unit-0.10/`，每个后缀均包含 `mobile-` 和 `desktop-` 两份：

| 文件后缀 | 内容 |
| --- | --- |
| nav-default.png | 重启后默认时光轴与五入口导航 |
| timeline-light.png / timeline-dark.png | 浅色时光轴 / 灯下展馆时光轴 |
| reading-light.png / reading-dark.png | 带封面和独立说明的正式阅读 |
| editor-fields.png / editor-photos.png | 地点/心情、说明、选封面并上移；桌面独立滚动区补拍照片控件 |
| mine.png / storage.png | 我的 hub / 标明合成数据的只读存储 |
| theme-settings.png | 主题与字体设置 |
| app-lock-settings.png / lock-screen.png | 应用锁设置 / 实际点击立即锁定后的预览锁屏 |
| museum-light.png / museum-dark.png | 两主题“建设中”占位 |
| large-font-light.png / large-font-dark.png | 通过实际设置选特大 130% 的时光轴；不是设备系统字体缩放 |

每次成功保存打印绝对路径；脚本检查矩阵完整、图片解码、页面错误、HTTP 错误、外部请求、默认导航、封面重排、自动保存及正式版隔离，任一失败非零退出。结果写入 `screenshots-result.json`，只列本次成功保存项，失败时不会用旧 PNG 冒充本次成功。编排侧已在沙箱外实际运行：32 张全部保存，page errors 0。

`evidence/manifest.json` 与 `scripts/verify-evidence.mjs` 是 Unit-0 原始数据/媒体 SHA 验收格式，不管理历次浏览器截图；本轮保持不变。截图采用自己的运行清单。日志通过 `.gitignore` 的 Task D 定向例外保留；无 staging/snapshot 副本或补丁文件。

## NOT_RUN

- **截图视觉复核：仅编排侧粗看（浅色/夜间时光轴、阅读页、存储页、桌面夜间阅读页），未做设计验收**。已知外观小问题：①手机全页截图里底部固定导航被截在页面中间（fullPage 截图的已知现象，真机需复核）；②“＋记录”入口图标加文字出现双“＋”。
- `npm run test:a11y:u010` 浏览器矩阵、实际 200% 无截断、浏览器键盘/触控矩形、屏幕阅读器：NOT_RUN；已有 Task C 脚本保留。
- Android/macOS/Windows 安装、升级、离线使用、跨端备份恢复、原生 HEIC、签名和 APK 实包权限/versionCode 检查：NOT_RUN。版本 0.1.10 / versionCode 1010 是仓库配置结论，未核验本单元安装包。
- Android 后台/恢复的应用锁及 60 秒重锁、系统最近任务预览、系统字体缩放、中文 IME/软键盘、安全区/横屏：NOT_RUN。
- 新一轮 5000 条压力测试、100 张大原图/100 MB 备份、物理断电与三端文件授权：NOT_RUN；不复用历史测试冒充本轮结果。
- CI 原生构建已跑通（run 42980602822，94faa12，7/7：三端 core+cli+ts、三端 tauri bundle、Android APK）；CI 产物未下载、未安装，安装包真机验证仍 NOT_RUN。

## BLOCKED（及额外检查失败）

- **浏览器运行环境 BLOCKED（历史 A–C 已确认）**：u09 在沙箱外可运行；Task B/C 曾因 `setsockopt` / sandbox `shutdown: Operation not permitted` 退出。Task D 按指令未启动 Chrome；截图随后由编排侧在沙箱外跑通（见 PASS）。
- **本机 Tauri 桌面 check BLOCKED**：执行 `cargo check --offline --locked --manifest-path src-tauri/Cargo.toml`，退出 101：`failed to download jiff v0.2.42` / `attempting to make an HTTP request, but --offline was specified`。未取包、未降级、未安装系统依赖。日志 `task-d-tauri-desktop-check.log`。Unit-0.8 已记本机无 webkit2gtk；本次在更早的依赖阶段停止，不能声称已经复现或通过 GTK 编译。原生壳未编译通过。
- **额外旧证据检查 FAILED**：一次运行 `npm run verify:evidence`，在解析既有、被忽略的 `evidence/acceptance/draft-kill.log` 时失败（JSON.parse position 676 / line 30）。该文件含两段拼接 JSON；校验器要求单个对象。本轮未改该旧日志、manifest 或校验断言，也未重跑会重写旧验收目录的 `run_acceptance.sh`。建议另行真实重跑该场景并生成单对象日志后，再运行旧数据验收。此检查不在上表必跑绿色套件中，不标 PASS。

## DEFERRED（未实现及原因）

- M01 图文块权威模型、快速/故事双模式及块级撤销/预览：沿 A/B 已记录的本轮延期。正文+相册不能冒充故事块；完整交付需新模型、迁移、备份/合并与编辑恢复测试。
- 照片替换/撤销、拖动柄、R03 继续/从正式版重编/取消三分支等完整 M01 交互仍未完成；现有默认继续草稿，不静默丢弃。
- 系统最近任务截图防护、原生剩余空间探测、缓存/备份清理 UI：未实现，需分别验证平台 API 和引用保护；不以占位按钮或虚构数字表示完成。
- M04 展览、M05 检索、M08、云同步/网络/AI：本轮明确范围外。博物馆只保留建设中。
- 正式发布签名：沿既有 Cine 取消决定，不创建 release keystore 或新秘密。

## 需要 Cine 决定

- 编排侧生成截图后，请复核浅色与“灯下展馆”的视觉、照片说明密度及特大字号布局；当前候选 token 尚未经真实设备视觉验收，不作为像素定稿。
- 安排 Android/macOS/Windows 的设备与执行人，重点核验后台恢复锁、系统字号/读屏、IME 和备份迁移；目前没有设备 PASS 结论。
- 后续单元的优先顺序：完整 M01 blocks/双模式，或先补系统截图隐私与存储 API。现有延期不等于撤销上游产品要求；本轮脚本交付无待批准的实现分支。

## 提交记录与建议拆分（编排侧执行）

A–C 已落提交（只读核对，非 Task D 新提交）：

- `f58b13f test(u010): freeze synthetic schema v3 state and .sgbak fixtures (plain + encrypted)`
- `d70635f feat(u010): schema v4 (caption/cover/order/location/mood, theme, app lock), v3 migration, backup/merge compatibility, Argon2id app-lock core`
- `5000219 chore(u010): drop Codex staging snapshot from evidence [skip ci]`
- `d98cc7a feat(u010): read-only local storage usage statistics (M07 D11)`
- `f2e59c1 feat(u010): spec 5-tab navigation, 我的 hub, read-first reading page, captions/cover/reorder/location/mood editor, storage view, theme + app-lock UI`
- `322c906 docs(u010): Task B validation and deferred scope`
- `aa12dda feat(u010): 灯下展馆 night design system, semantic tokens, prepaint theme (light/dark/system), font scale, a11y states`
- `0172a9a test(u010): theme contrast (WCAG AA from tokens) and accessibility contracts`
- `b19bcfc docs(u010): night tokens, design system and Task C validation limits`

Task D 新提交：**无，无新 hash**。建议：

1. `test(u010): prepare synthetic mobile and desktop screenshot matrix` — scripts/screenshots-u10.mjs、package.json。提交正文注明仅 node --check，浏览器运行 NOT_RUN；没有修改既有测试。
2. `docs(u010): draft verification report and record Task D evidence limits` — 本报告、README、.gitignore、task-d 日志和验证摘要。编排侧运行截图后再收录真实 PNG / screenshots-result.json 并更新报告，不能提前写 PASS。

## 日志

`unit-0.10/task-d-{cargo-test,fault-injection,npm-test,npm-cases,typecheck,build,syntax-check,tauri-desktop-check}.log`；机器摘要及日志 SHA-256 见 `unit-0.10/task-d-verification.json`。截图日志/结果须待外部真实运行后生成。
