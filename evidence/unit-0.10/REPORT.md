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
