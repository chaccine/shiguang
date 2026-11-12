# Unit-0.10 Task A · 0.1.10

分支 `unit-0.10`，基线 `main b882029`。延续中断会话的工作树；没有创建提交、
没有合并或推送。按 RESUME，由编排侧提交；本机 `.git` 只读。

## 完成范围

- schema v4 及 v1→v2→v3→v4 迁移；原文件先留安全副本，校验后走既有原子写路径。
- 使用位说明、显式封面、照片顺序、手写地点和六种可选心情；正式/草稿/冲突快照同构，
  草稿隔离、提交 CAS、原子发布和丢弃保护不变。
- 冻结 v3 state/明文备份/生产参数加密备份兼容；v4 明文/加密往返；合并比较所有新字段。
- 主题偏好持久化及备份；可选应用锁的设置/验证/改码/关闭、Argon2id、随机盐、恒时结果
  比较、重启保留的指数限速、脱敏诊断；Tauri 命令和 TS 契约/预览镜像。
- 本轮复核修补 MemoryAdapter：重复原图的使用位重排仍算内容分歧；撞号后的正式、草稿、
  冲突快照保持使用位和封面映射；重导出保留来源；改号记录永久删除后旧包不复活。
- 0.1.10 及所有本地包/lockfile 版本核对；Android versionCode 1010 为推导值。

设置/锁安全模型见 [SPEC](SPEC.md)：**应用锁核心只是 UI 门禁，不加密文件**；便携
备份省略凭据，覆盖恢复保留目标锁与失败计数，合并永不导入锁。忘记码没有应用内恢复
接口；有文件权限者可退出后手动编辑偏好，普通 Android 用户未必有该权限。加密备份
口令独立，丢失不能解密。MemoryAdapter 明确使用 WebCrypto PBKDF2 预览模型；真实
应用始终使用 Rust Argon2id。

上游按本机实际文件读取：M01 v1.3、M06/M07 及审核、G01–G06、outline（文件实际标记
v2.6），以及 README、UNIT0.8_REPORT、既有各单元 SPEC。本轮实施范围以用户授权为准。

## 最终验证

Rust 1.90.0 / Node v24.22.1 / npm 11.21.1，全部合成数据，离线依赖。

| 命令 | 结果 |
| --- | --- |
| `cargo test --offline --locked --workspace` | **211 通过，0 失败，1 ignored** |
| `cargo test --offline --locked --workspace --features fault-injection` | **266 通过，0 失败，1 ignored**；比默认多 55 项 |
| `npm test` | **16 个文件全部通过，0 失败** |
| `node --test --test-isolation=none tests/*.test.ts` | **153 项通过，0 失败**（Node 24 的逐项计数） |
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| 本地包版本与三份 Cargo.lock / package-lock 核对 | **PASS** |
| `git diff --check` | **PASS** |
| Tauri Android `cargo check --offline --locked … --target aarch64-linux-android` | **BLOCKED**：既有 `bit-set 0.11.1` 未缓存；未联网、未降级依赖 |

唯一 ignored 是 `generate_v3_golden_fixtures`：它会写历史夹具，只允许在原 v3 核心
显式执行，并断言 `CURRENT_SCHEMA_VERSION == 3`。当前 v4 不能重生成它。**读取冻结
夹具的完整性与兼容测试均已执行**。迁移中断覆盖 MigrationBackup/MigrationWrite 及
安全写入各提交前故障点；另测新字段提交中断、锁/主题写失败。它们是故障注入，
不是物理断电或真机测试。

机器摘要及日志 SHA-256：[task-a-verification.json](task-a-verification.json)。
原始日志在本目录 `task-a-{cargo,faults,npm,npm-cases,typecheck,build,tauri-android-check}.log`
（仓库原有 `.gitignore` 忽略日志；需保存原始证据时由编排侧选择）。

初次运行误用了系统 Rust 1.85，因仓库原有文件锁 API 等无法编译；改用已安装 1.90 后
通过，没有为旧编译器修改或削弱代码。新增重复图片/撞号回归曾按预期暴露预览问题，
修补后完整套件绿色；新 Rust 回归中的整行比较曾误含本机 baseRevision，已改为检查
其实际目标（正式快照/内容修订），原有测试没有因此放宽。

## 未实现 / NOT_RUN

- 新字段的编辑控件、主题切换显示、解锁屏幕、启动门禁、后台重锁、最近任务遮挡均未实现。
  目前不能宣称启用偏好后现有 UI 已受锁保护。
- Android/macOS/Windows 壳编译、打包、升级安装、真实设备与物理断电测试：NOT_RUN；
  Android 编译尝试如上 BLOCKED。TS invoke 契约测试不代替原生壳编译。
- APK 权限和 versionCode 实包检查：NOT_RUN；未增加 Android INTERNET 权限，既有 CI
  去除 INTERNET 的步骤保留。`src-tauri/gen/` 为原有未跟踪产物，不在交付文件列表中。
- M01 完整故事编辑器、M06/M07 全产品验收不是本 Task A 的交付。M04、M05 检索、M08、
  云/网络/AI 均未增加。没有真实私人数据、凭据或 keystore。

开放项：在依赖齐全的 CI 编译 Tauri，再安排各平台和后续 UI 的验证；本阶段没有待确认
的数据语义问题。没有尝试恢复备份加密口令的后门。

## 建议提交拆分（编排侧执行）

必须按顺序处理，每个提交前均执行完整五项绿色检查（默认 Rust、故障注入 Rust、
npm、typecheck、build）。共享文件需要按检查点/差异分段暂存，不能把最终版本一次放入
第二个提交。现存 `01-v3-fixtures.patch` / `02-schema-v4.patch` 是中断前保留的检查点，
不包含本轮最终锁实现和复核修补；不能误认为它们已经提交。

1. **`test(fixtures): freeze synthetic schema v3 state and backups`**

   文件：`core/tests/fixtures/v3/`（README、state.json、plain.sgbak、encrypted.sgbak、
   7 个 media PNG）、`core/tests/v3_golden_generator.rs`、
   `evidence/unit-0.10/fixtures-verification.json`。
   对应历史夹具绿色检查点：185 / 237 / 127 项，typecheck/build 通过。

2. **`feat(data): migrate schema v4 snapshots and compatible backups`**

   文件（采用 schema 检查点的内容）：

   - `core/src/{model,schema,store,backup,merge,query,settings,lib}.rs`
   - `core/tests/unit010_{schema,faults}.rs`
   - `core/tests/{unit04_schema,unit06_merge,unit07_backup,unit07_query,unit07_schema,unit08_stress}.rs`
   - `src/domain/{types,rules,view,timeline,draft-session,errors}.ts`
   - `src/platform/{api,memory-adapter,tauri-adapter}.ts`
   - `src-tauri/src/lib.rs`
   - `tests/{unit010-schema,rules,unit07,view}.test.ts`
   - `Cargo.toml`、`Cargo.lock`、`package.json`、`package-lock.json`、
     `src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、`thumbnails/{Cargo.toml,Cargo.lock}`
   - `README.md`、`evidence/unit-0.10/{SPEC.md,schema-verification.json}`

   对应 schema 绿色检查点：195 / 248 / 140 项，typecheck/build 通过。
   **提交正文必须说明既有测试调整**：经批准 schema 期望从 3 改为 4，未来版本拒绝样本
   从 4 改为 5，Snapshot 测试构造补默认字段/有效封面，手工清空照片时同时清空封面；
   预览迁移调用改为 migrateToV4。没有删除或放宽 CAS、数据保护、故障断言。

3. **`feat(security): add Argon2id app lock and finish v4 compatibility checks`**

   新文件：`core/src/app_lock.rs`、`core/tests/unit010_lock.rs`、
   `src-tauri/src/u010_cmd.rs`、`src/platform/preview-lock.ts`、`tests/unit010-lock.test.ts`、
   `evidence/unit-0.10/{REPORT.md,task-a-verification.json}`。

   其余差异：`core/Cargo.toml`、`Cargo.lock`、`src-tauri/Cargo.lock`、
   `thumbnails/Cargo.lock`（直接依赖已锁定 subtle）；
   `core/src/{lib,store}.rs`（最终锁接入）；
   `core/tests/unit010_{schema,faults}.rs`（最终回归）、
   `core/tests/unit04_schema.rs`（迁移链注释）；
   `src/domain/{types,errors}.ts`、`src/platform/{api,memory-adapter,tauri-adapter}.ts`、
   `src-tauri/src/lib.rs`、`tests/unit010-schema.test.ts`、`README.md`、
   `evidence/unit-0.10/SPEC.md`。

   最终绿色检查点：**211 / 266 / 153 项**，typecheck/build 通过。最终差异没有新增
   依赖版本或网络取包；备份锁处理和新字段保护测试保持严格。

`src-tauri/gen/`、本目录 `.stage2/` 中间快照和检查点补丁均不纳入上述提交；避免用
`git add .` 一次收进这些交接产物。实际源码、夹具、SPEC、摘要和报告才是提交内容。
已按 Git blob 校验 v3 冻结夹具与第一检查点一致。没有可打印的本轮提交哈希。


## Task B · UI / M01 + M06 + M07（2026-11-11）

工作分支 `unit-0.10`，起始 HEAD `5000219`。未创建新提交，未 stage/merge/push；
`.git` 只读且由编排侧提交。预先存在的 `src-tauri/gen/` 保持未跟踪，不列入交付。
版本仍为 Task A 已落的 0.1.10。全部开发与测试数据均为合成夹具。

### 本轮已完成

- 规范手机五入口与桌面侧栏；默认时光轴；草稿/收藏标签/备份/回收站等功能均从我的可达。
  博物馆仅建设中占位，M05 查找入口省略，无搜索功能。
- 正式只读阅读页，显式编辑进入/继续修改草稿；标题、日期、地点、心情、突出封面、
  权威顺序相册、纯文本多行说明、正文、标签/收藏；原图/预览故障可重试且不删引用。
  返回保留来源、筛选/选中日、滚动上下文。往年今日卡片同样有阅读入口。
- 编辑器说明、封面标记、无拖拽依赖的上/下移动、手写地点、心情。串行自动保存沿用
  既有保存状态；照片失败写入保留待重试，切页/提交先 flush；不发布正式内容。
- 只读 Rust 本机分类统计 + Tauri 命令 + TS/MemoryAdapter。跳过内部/外部/循环符号链接，
  分类总和有测试；UI 明确预览数字是合成示例，可用空间未知，支持未来低空间数字的提示。
  不提供删除或自动清理，不修改记录和原图。
- 主题 light/dark/system，系统主题监听，本机字号偏好钩子；设置反馈保留持久化不确定语义。
- 应用锁双输启用、当前码改码/关闭、立即锁定、启动门禁；原生窗口焦点及 DOM 可见性/
  焦点监听；后台立即遮挡、离开满 60 秒后重锁；错码限速和倒计时调用核心状态。
  输入提交即清空，finally 再清空，不记日志；诚实说明文件不加密、忘记口令无应用内找回、
  Android 文件访问限制、最近任务截图未保护、备份口令独立。
- 截图脚本沿我的二级入口及阅读→编辑路径更新，未删除原断言。原有导航测试仅依获批的
  V04 五入口和默认启动规则更新期望；其它既有数据保护和故障测试未削弱。

### 最终本地验证（Rust 1.90.0 / Node 24.22.1）

| 命令 | 实际结果 | 证据 |
| --- | --- | --- |
| `cargo test --offline --locked --workspace` | **213 passed / 0 failed / 1 ignored** | task-b-cargo-test.log |
| `cargo test --offline --locked -p shiguang_core --features fault-injection` | **258 passed / 0 failed / 1 ignored**（含正常核心及故障测试） | task-b-fault-injection.log |
| `npm test` | **19 个模块 passed / 0 failed**（Node 24 默认以文件计数） | task-b-npm-test.log |
| `node --test --test-isolation=none tests/*.test.ts` | **160 项 passed / 0 failed / 0 skipped** | task-b-npm-cases.log |
| `npm run typecheck` | **PASS** | task-b-typecheck.log |
| `npm run build` | **PASS** | task-b-build.log |
| 修改的 Rust 文件 rustfmt 检查、`git diff --check` | **PASS** | 本地执行 |

Rust 唯一忽略项仍为历史 v3 夹具生成器（只能在原 v3 核心显式运行）；正常冻结旧夹具
兼容性测试实际执行，没有新增忽略。额外尝试的 workspace 全量 fmt 检查发现基线 lock.rs、
time.rs 及旧测试已有格式差异，未改动这些无关文件；本轮修改的 Rust 文件已单独格式化并检查通过。

新增验证包括：真实 main.ts 入口的 DOM 事件启动/五入口/我的草稿/编辑标量/阅读→修改→返回；
实际阅读 renderer 的封面与相册顺序、字面说明及 formal 隔离；DraftSession 照片失败重试；
存储列表与低空间提示、命令适配；PersonalUi 启用确认/错码/核心倒计时/改码/关闭/启动锁定/
Tauri 焦点回调/输入清空/主题事件。DOM 测试使用最小事件夹具，不模拟布局、图像解码或
系统真实焦点送达，不应被解释为设备或完整浏览器 E2E 通过。

### 未实现 / NOT_RUN / BLOCKED

- **BLOCKED：Chrome/截图。** 本轮一次启动 `/usr/bin/google-chrome`（Playwright headless）
  在沙箱中被 `setsockopt: Operation not permitted` 阻断，Chrome SIGTRAP 退出；未反复重试，
  未生成新截图。更新的既有截图脚本未执行完成，不能宣称像素/零 page errors 通过。
- **NOT_RUN：原生壳构建、APK/桌面安装与真实生命周期、软键盘/安全区/读屏/对比度实测。**
  Task A 已记录原生 Android 离线 check 缺 bit-set 缓存；Task B 未重复取包或尝试联网。
  系统最近任务截图防护未实现。Tauri 适配代码/DOM 回调测试不代表原生编译或真机通过。
- **明确延期：M01 图文块故事编辑及双模式。** m01 v1.3 首版要求成立，但现有正文+相册
  模型须增 blocks、迁移、备份/合并及无损编辑测试，非简单 UI，按本任务 Cine 接受的延期记录。
  完整 M01 的照片替换/撤销、R03 三分支重编选择仍未实现；默认继续现有修改草稿，不丢弃它。
- 剩余空间原生探测未实现（显示未知）；缓存/备份清理操作未提供；本机字号偏好不随备份迁移。
- M04 展区、M05 搜索、M08、云/网络/AI 均未实现；无新增 Android INTERNET 权限/依赖下载/秘密。

### 提交记录与建议拆分（编排执行，本轮无新 hash）

已落基线提交（只读核对）：

- `f58b13f test(u010): freeze synthetic schema v3 state and .sgbak fixtures (plain + encrypted)`
- `d70635f feat(u010): schema v4 (caption/cover/order/location/mood, theme, app lock), v3 migration, backup/merge compatibility, Argon2id app-lock core`
- `5000219 chore(u010): drop Codex staging snapshot from evidence [skip ci]`

本轮新提交：**无**。建议按逻辑拆成：

1. `feat(u010): add read-only local storage usage statistics` — Rust storage 模块/命令/测试，
   TS storageStats 类型与两个 adapter，相关存储契约（共享文件需按 hunk 拆分）。
2. `feat(u010): complete M01 reading and M06/M07 navigation, editor and privacy UI` — 正式投影
   地点/心情、串行照片自动保存、规范导航、我的、阅读/编辑/主题/应用锁、测试及脚本。
   提交正文须注明：旧 navigation 测试期望按获批 V04 和默认时光轴变更，其余断言保留；
   图文块故事编辑明确延期；浏览器截图/真机 NOT_RUN/BLOCKED。
3. `docs(u010): record Task B validation and deferred scope` — README、SPEC、本报告及最终测试日志。

### 开放事项

无阻塞当前代码交付的问题。后续需在可启动浏览器及三端原生环境核验布局、Tauri/Android
后台事件和 60 秒重锁、主题/字号/软键盘；另行设计 blocks 迁移、可用空间 API 和系统截图保护。

## Task C · M06 灯下展馆、主题及可访问性（2026-11-11）

分支 unit-0.10；本轮起点/仍为 HEAD：
`322c906 docs(u010): Task B validation and deferred scope`。
A/B 已有 `d70635f`（数据/设置/应用锁）、`d98cc7a`（存储统计）、`f2e59c1`（UI）等，
本轮没有提交、合并或推送；不伪造新 hash。src-tauri/gen/ 是启动时已有的未跟踪目录，
未改动、不得加入编排提交。

### 已实现

- 浅色延续 A 暖纸本；深色为独立“灯下展馆”：暖墨/胡桃木分层、琥珀操作色、
  展框内线/内高光、低强度灯光与纸纹、独立排版参数及纯 CSS 占位构图。
  时光轴、日历、导航、阅读、编辑、输入、按钮、提示/错误、弹窗和锁屏同源。
  博物馆仍只有明确建设中及回时光轴入口，照片无调色/滤镜。
- 色彩集中 tokens.css，两套完整语义集合；组件只引用 token。样式从 HTML 外移，
  构建复制两份 CSS。原有合成照片 SVG 移至 platform/synthetic-media.ts，原色不变。
- head 同步应用经过校验的主题/字号绘制缓存，后台原设置仍权威；三种偏好、实时系统事件、
  预览选择及写入失败回退落地。覆盖恢复后刷新主题；刷新失败不保留已消费的导入 token
  或旧编辑会话，也不把内容恢复操作撤回成“未恢复”。字体标准/大/特大沿原本机钩子，
  根字号相对用户默认值，全控件继承字体，支持减少动态效果。
- 命名输入/模态弹窗、跳到内容、可见焦点、主导航 aria-current、日历完整日期/计数/
  选中/今天/珍藏、44–48px CSS 触控约束、应用锁 Tab 循环及解锁后焦点恢复。
  200% 使用换行/可变容器/内部滚动路径；真实布局是否无截断仍须浏览器验证。
- [设计系统](DESIGN_SYSTEM.md) 记录夜间理由、候选 token 表及边界。无 schema/领域/
  Rust/adapter 数据契约变更，无依赖下载、网络/云/AI、秘密或 Android 权限变更。

### 最终自动验证（Rust 1.90.0 / Node 24.22.1）

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| cargo test --offline --locked --workspace | **213 passed / 0 failed / 1 ignored** | task-c-cargo-test.log |
| cargo test --offline --locked -p shiguang_core --features fault-injection | **258 passed / 0 failed / 1 ignored**（正常核心及故障注入一起计数） | task-c-fault-injection.log |
| npm test | **21 个文件 passed / 0 failed** | task-c-npm-test.log |
| node --test --test-isolation=none tests/*.test.ts | **170 项 passed / 0 failed / 0 skipped** | task-c-npm-cases.log |
| npm run typecheck / npm run build | **PASS** | task-c-typecheck.log / task-c-build.log |
| 组件颜色 rg 扫描 | **0 处固定 hex/rgb/hsl** | task-c-color-check.log |
| node --check scripts/a11y-u010.mjs / git diff --check | **PASS**（语法/空白检查） | 本地执行 |

Rust 唯一 ignored 仍是仅允许在原 v3 核心运行的历史夹具生成器；冻结旧库兼容测试实际运行。
新加 10 项前端用例：对比度计算/独立 token/结构/触控样式约束，首屏脚本、三个偏好、实时
系统事件、失败回退、相对字号和缓存不可读、Tauri 契约消费。已有 bootstrap/锁 UI 事件测试
补充当前页、占位返回、日历标签/选中和焦点循环断言。

对比度测试直接读实际 token，用 sRGB 计算，覆盖不透明表面、渐变端点、双层纹理和最强
灯光合成。正文/次级/状态文字 ≥4.5:1，控件边界/焦点 ≥3:1；早期叠加测试发现临界值后，
已降低灯光强度并校准次级文字，未降低阈值。结构/触控约束和最小 DOM 事件测试不是实际
像素、焦点系统送达或读屏验收，不把它们计作完整 AC04/WCAG 认证。

### BLOCKED / NOT_RUN / 未实现

Chrome 两次启动尝试均被沙箱系统调用权限阻断，未第三次重试：

1. Playwright headless + no-sandbox / disable-dev-shm-usage / disable-crashpad-for-testing：
   `FATAL:content/browser/sandbox_host_linux.cc:41 ... shutdown: Operation not permitted (1)`，SIGABRT。
2. 追加 no-zygote / single-process / disable-gpu：同一 FATAL / SIGABRT。

因此新截图 **BLOCKED**；npm run test:a11y:u010 的完整浏览器矩阵 **NOT_RUN**。
脚本已提供（320/1280px、两主题、100/200%、实际触控矩形/键盘/动态效果/各页面与锁屏），
本轮仅语法检查；全部资源通过本地 dist 拦截提供，不需监听端口或联网。
真实 200% 无截断、屏幕阅读器、弱光视觉评审、系统字号/软键盘/安全区、三端壳/设备均
**NOT_RUN**。不能据本轮单元测试宣称所有可访问性或原生体验通过。

完整故事块/双模式、照片替换/撤销、R03 三分支、系统最近任务截图保护及 Task B 的其他
延期不变。M04 展区、M05 搜索、M08 及网络/云/AI 未实现。

### 建议提交拆分（由编排执行，尚无新 hash）

1. feat(u010): add lamplit night design system and prepaint appearance
   — tokens/styles/外观控制器、HTML/主界面/锁屏、合成媒体整理、CSS 构建复制，
   同步必要旧测试。提交正文注明获批 M06 V14 导航语义用 aria-current 代替孤立 tab 的
   aria-selected；安全区断言随 CSS 拆出读取 styles.css；原数据/故障断言不删不弱化。
2. test(u010): verify theme contrast and accessibility contracts
   — 新测试、已有事件测试增强、浏览器复测脚本及 package 命令。说明浏览器矩阵 NOT_RUN。
3. docs(u010): document Task C night tokens and validation limits
   — README、SPEC、DESIGN_SYSTEM、本报告、task-c 日志及其 .gitignore 例外。

开放问题：无阻塞实现的产品问题；需在可启动 Chrome 的环境运行浏览器矩阵，再做 Cine
视觉复核及三端系统字号/读屏/输入体验验收，候选色值可据此继续校准。
