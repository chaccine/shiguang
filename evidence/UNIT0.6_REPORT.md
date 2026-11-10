# Unit-0.6 报告：G03 安全合并 + G02 跨备份防复活 + 可选口令加密 · 0.1.5（versionCode 1005）

- 分支 / PR：`feat/unit-0.5-backup` → https://github.com/chaccine/shiguang/pull/5（与 Unit-0.5 同一 PR，**未合并**，由 Cine 决定）
- 规格：`evidence/unit-0.6/SPEC.md`；core 实现日志：`evidence/unit-0.6/01-core.log`
- 全部测试与截图只用合成数据；无联网权限、无云同步、无 AI。备份 ≠ 同步。

## 做了什么

| 部分 | 内容 | 谁做 |
|---|---|---|
| 规格 / 版本 / 依赖 | SPEC；0.1.5 / 1005；RustCrypto 依赖与 Cargo.lock 固定（argon2 0.5.3、chacha20poly1305 0.10.1、getrandom 0.2.17、zeroize 1.9.1），dev profile 对密码学 crate opt-level=3（Android 侧载包是 debug 构建，否则 Argon2 很慢） | 我 |
| core 合并 | `merge_states` 纯函数（墙钟时间不参与胜负）；`Store::plan_merge`（只读）/ `merge_backup`（独占写锁，安全副本 `backups/pre-merge-*`，`.merge-journal.json`，新原图先落盘、state 原子替换为提交点，失败回滚）；`mergeOrigins` 记录撞号改号来源，保证重复导入/再导出幂等 | Codex gpt-6.1-sol（high） |
| core 防复活 | 删除标记新增可选 `createdAt`；身份 = (recordId, createdAt)；标记无 createdAt 时保守匹配（宁可不导入也不复活） | Codex |
| core 加密 | SGBAKENC v1：头部（KDF 参数、盐、nonce 前缀）整体作 AAD；1 MiB 分块 XChaCha20-Poly1305 STREAM（nonce = 19B 前缀‖u32 BE 计数‖末块标志）；Argon2id 默认 m=64MiB/t=3/p=1，解密时参数有上下限（拒绝 KDF 炸弹）；口令 `Zeroizing`，Debug 输出 `[REDACTED]` | Codex |
| CLI | `export-backup --encrypt [--kdf-fast]`、`plan-merge`、`merge-backup --yes`；口令只走环境变量 `SHIGUANG_BACKUP_PASSWORD` 或 `--password-stdin`，不接受命令行参数 | Codex |
| Tauri 命令 | `export_backup{password?}`、`unlock_backup`、`plan_merge`、`merge_backup`；能力改为 merge/encryption/antiResurrection = true。加密包解锁后明文副本只在应用私有缓存 `backup-imports/`，合并/恢复/取消后删除，启动时清理 | 我 |
| TS / MemoryAdapter | 同语义合并表、防复活（删除 createdAt 存在独立映射，不改动删除标记的 3 字段形状）、撞号改号 + 幂等、预览“加密”（口令校验值门禁 + 混淆，**仅交互演示，不是真加密**） | 我 |
| UI（「数据」页） | 「使用口令加密（可选）」+ 两次输入 + “口令丢失将无法找回”；加密包解锁框；「合并导入」先出计划再二次确认（新增/更新/冲突副本/已删除不带回/回收站保持）；「覆盖恢复」确认写明“替换当前全部数据”；摘要显示是否加密；“未实现”卡片改为已支持/未实现/注意 | 我（UI 小，未用 CodeBuddy） |
| 验收脚本 | `run_acceptance.sh` 新增 U06 段（见下） | 我 |

## 本机测试（box，Linux x86_64，rustc 1.90.0）

| 项 | 结果 |
|---|---|
| `cargo test --workspace` | **153 通过 / 0 失败** |
| `cargo test --workspace --features shiguang_core/fault-injection` | **195 通过 / 0 失败**（含 unit06_faults：第 k 张原图/第 k 个加密块失败、日志/提交点前后崩溃均回滚或可恢复） |
| `cargo clippy --workspace --all-targets -D warnings` | 通过 |
| `src-tauri` `cargo clippy --target aarch64-linux-android` | 通过（3 条既有 derivable_impls 警告，非本单元引入） |
| `npm test` | **99 通过**（新增 tests/unit06.test.ts 9 条） |
| `npm run typecheck` / `npm run build` | 通过 |
| `scripts/run_acceptance.sh` | 通过；U06 段：永久删除后合并旧包不复活（skippedDeleted=1、`get` → RECORD_DELETED）、无 `--yes` 拒绝、二次合并 added/updated/冲突副本/原图均为 0；加密包内无明文；错口令 / 缺口令 / 篡改 → BACKUP_PASSWORD_WRONG / BACKUP_PASSWORD_REQUIRED / BACKUP_PASSWORD_WRONG，数据目录逐文件 sha256 不变；正确口令合并成功；随机口令未出现在任何输出/日志中 |

Unit-0.6 修改了一条既有断言：`core/tests/unit04_trash.rs` 删除标记字段列表加入 `createdAt`（规格要求的防复活身份字段；仍断言不含任何正文/标题/说明）。

## CI

PR run [42752920403](https://github.com/chaccine/shiguang/actions/runs/42752920403)，head `a5661e8`，**7/7 success**：core+cli+ts ×3（ubuntu/macos/windows）、tauri bundle ×3、tauri android apk。

## 安装包（/workspace/u06dl/，取自上面的 CI run）

| 文件 | sha256 | 说明 |
|---|---|---|
| `拾光_0.1.5_arm64-debug.apk`（22,315,573 B） | `eb7a0c0da111b5b786cf61d74f9a1c4311fa8bc0cccd625817d3b33db156b792` | CI universal debug APK → strip（`--strip-debug`，CI 产物已无调试段，大小不变）→ 去旧签名 → `zipalign -p 4` → box `~/.android/debug.keystore` 重签；`apksigner verify` v2+v3 通过；证书 SHA-256 `59dbe106e00efc187b10faf0c2839fd575de09a42f7a964dc94c00e309af766f`；versionCode 1005 / versionName 0.1.5；无 INTERNET 权限。Drive：https://drive.google.com/file/d/16yB8qQFCizIiBtrppE_kg2LenAa18dbS/view |
| `拾光_0.1.5_aarch64.dmg` | `687490c5e337d97f6d4b864c775b08127dff31d31fab5e3a0207aac5a7b12b58` | 未签名 |
| `拾光_0.1.5_x64_zh-CN.msi` | `7066724b946780b129b60ddb0f6d62e5d6e237107d22195ab33b8f2e76d48937` | 未签名 |

## 截图（浏览器预览 + MemoryAdapter，合成数据；不是真机）

`evidence/unit-0.6/`：01-encrypt-option、02-encrypted-export、03-unlock-prompt、04-wrong-password-rejected、05-unlocked-merge-or-overwrite、06-confirm-overwrite、07-confirm-merge-plan（含“1 条已永久删除，不会被带回”）、08-merge-success、09-mobile-encrypt-option；`screenshots.log` page errors 0，口令已打码。

## 结论

| 项 | 状态 |
|---|---|
| core 合并 / 防复活 / 冲突副本 / 撞号幂等 / 原图 sha 去重与缺失占位 | PASS（自动化测试） |
| 合并原子性与故障注入回滚 | PASS（fault-injection 测试） |
| 加密导出 / 错口令 / 篡改拒绝且数据不变 / 口令不进输出 | PASS（core + CLI 验收） |
| TS MemoryAdapter 同语义 + UI 预览 | PASS（npm test + 截图；预览加密为演示） |
| 三平台构建 + Android APK | PASS（CI 7/7） |
| Tauri 新命令（unlock/plan/merge、带口令导出）实际运行 | NOT_RUN（只在 box 上编译通过；无桌面/真机运行） |
| Android 真机：加密导出、SAF 选择加密包、解锁、合并、覆盖恢复 | NOT_RUN |
| 桌面真机（macOS/Windows）导出/合并/恢复 | NOT_RUN |
| Android 上 Argon2id 64 MiB 的耗时与内存 | NOT_RUN（debug 包已对密码学 crate 开优化，真机耗时未测） |

## 仍未做

G01 珍藏独立修订、G06 标签事务、M02–M05（时光轴分组、日历、展区、检索与标签）、多设备同步（不做，备份 ≠ 同步）、正式签名（安装包均未签名，APK 为调试密钥）、Windows NSIS（上游 504，只出 MSI）、真实缩略图解码与 HEIC、100 张照片 / 100MB 备份压测（T02/T08）。新设备只有“删除之前”的旧备份时无法得知后来的删除（已在界面注明）。
