# Unit-0.4 数据安全核心 2｜验收报告

> 2026-11-09（Asia/Shanghai）· 分支 `feat/unit-0.4-data-safety-2`（基线 `main@fffa7ac`）· PR https://github.com/chaccine/shiguang/pull/4（**未合并，由 Cine 决定**）
> 只用合成数据。正式基准 rustc 1.90.0（box 用户级 rustup + GitHub Actions）。Drive 只读对齐：任务书 v0.3、G01–G06 数据契约 v1.0、总纲 v2.6（未改 Drive）。

## 提交与执行者
| 提交 | 内容 | 执行者 |
|---|---|---|
| e526955 | 测试先行：SPEC + API 桩 + 58 项新测试（预期 FAIL）；既有断言未改 | Codex `gpt-6.1-sol` high（Team，workspace-write） |
| d87e7f8 | core/cli 实现：写锁、schema v1→v2 迁移、回收站/DeletionMarker/隔离区、reconcile_media、冲突副本 | Codex `gpt-6.1-sol` high（Team） |
| 024de23 | Tauri `open_exclusive` 不 panic + 新命令；TS API / MemoryAdapter / 中文错误文案 | Codex `gpt-6.1-sol` high（Team） |
| 79f4cbe | 磁盘草稿槽被占时 commit 不写盘（恢复 Unit-0.1 断言）；新增 `save_conflict_copy` | Grok Bot |
| 54dbe1e | 版本 0.1.2（Android versionCode 1002） | Grok Bot |
| 96e2708 | UI：回收站 / 确认框 / 冲突二选一 / 启动阻断 / 原图缺失 | CodeBuddy `deepseek-v4.1-flash`（`-p`，acceptEdits，工具限 Read/Edit/Write/Glob/Grep，无 `-y`）主体；进程无输出且语法断裂后由 Grok Bot 补齐事件绑定与 boot |
| 33ddf06 | 预览截图脚本 + 11 张截图；`RECORD_NOT_FORMAL`；手机标签不换行 | Grok Bot |
| f7e79ad | 本机全量验证日志 | Grok Bot |
| 939fba2 | Windows：`tree()` 跳过被排他锁占用的 `.instance.lock`/`.write.lock`（ERROR_LOCK_VIOLATION） | Grok Bot |

## 本机验证（box，rustc 1.90.0）
| 项 | 结果 |
|---|---|
| `cargo test --locked` | **PASS 87**（既有 52 + Unit-0.4 新增 35：lock 2 / trash 12 / schema 5 / media 6 / conflict 5 + cli multiprocess 5） |
| `cargo test --locked -p shiguang_core --features fault-injection` | **PASS 94**（+ Unit-0.1/0.2 故障 + unit04_faults 3） |
| `cargo build --locked -p shiguang` | PASS |
| `npm test` | **PASS 79/79**（既有 59 + unit04 20） |
| `npm run typecheck` / `npm run build` | PASS / PASS |
| `bash scripts/run_acceptance.sh` | PASS |
| 浏览器预览截图（MemoryAdapter，合成数据） | PASS 11 张，见下；**预览模拟，非真机** |
| Tauri 本机构建 | **BLOCKED**（缺 webkit2gtk/pkg-config，未用 sudo） |
| Windows / macOS / Android 真机窗口与回收站/写锁行为 | **NOT_RUN**（等 Cine） |

## CI
PR run（head `939fba2`）：https://github.com/chaccine/shiguang/actions/runs/42609772281 —— **7/7 PASS**。
（同提交 push run：https://github.com/chaccine/shiguang/actions/runs/42609764068）

| Job | 结果 |
|---|---|
| core+cli+ts (ubuntu / macos / windows) | PASS ×3（Windows 在 939fba2 修复 tree() 锁文件读取后通过） |
| tauri bundle (ubuntu / macos / windows) | PASS ×3（Linux .deb / macOS dmg / Windows MSI） |
| tauri android apk (ubuntu-latest) | PASS：artifact `shiguang-Android-arm64-debug-apk` |

此前失败：run 42609030635 Windows `unit04_lock::rejected_exclusive_open_never_cleans_or_changes_any_file` 因读取被锁的 `.instance.lock`（ERROR_LOCK_VIOLATION）→ 已在 939fba2 修复。

### 产物（/workspace/u04dl/，Asia/Shanghai 本机整理）
| 文件 | 大小 | sha256 |
|---|---|---|
| `拾光_0.1.2_arm64-debug.apk` | 18,965,502 | `20e877ee371924f2cb858a5edf76f6ec667621764d74ed1c38cfff8cd991d3ed` |
| `拾光_0.1.2_aarch64.dmg` | 3,122,366 | `b83b2ce319e4b930623d2f885079324525be4f4f731914b42404922251329241` |
| `拾光_0.1.2_x64_zh-CN.msi` | 3,088,384 | `9ce86454c6997f37ef7ff442a1d6494ea6a270072bf22cf222acb47bbb9077aa` |

APK：CI 产物已 strip；box 去旧签名 → zipalign → `apksigner` 用 `~/.android/debug.keystore`（alias androiddebugkey）重签；证书 SHA-256 `59dbe106…` 与已装 0.1.1 相同；versionName 0.1.2 / versionCode 1002 → 应可覆盖升级。`apksigner verify`：v2+v3 PASS。安装包均**未正式签名**。

## 语义要点（对齐 G01/G02/G04）
1. **写锁**：`.write.lock` 覆盖事务全过程（含 open 清理 `.tmp-*`）；`open_exclusive` 持 `.instance.lock`，第二实例 `STORE_LOCKED` 中文提示；CLI/既有测试仍用 `Store::open`。
2. **G02**：`active → trashed → 手动永久删除`；`DeletionMarker` 仅 `recordId/deletedAt/lastContentRevision`；原图移入 `media-quarantine/`，**不硬删**；无自动清空。跨备份防复活（合并导入）依赖 G03 → **NOT_RUN / 后续**。
3. **schemaVersion**：缺省=1；当前=2；先备份到 `backups/state.schema-v{from}.{ts}.json` 再迁移；更新版本 → `SCHEMA_TOO_NEW` 不改写。
4. **照片一致性**：`reconcile_media`（仅独占）隔离孤立原图与半写 `.tmp-*`；missing/corrupt 只报告。
5. **冲突副本**：磁盘草稿槽被占时 commit **不写盘**（Unit-0.1 语义）；`save_conflict_copy` / `resolve_conflict(keepMine|keepFormal)` 显式持久化；UI 二选一。

## 截图（evidence/unit-0.4/，浏览器预览）
| 文件 | 内容 |
|---|---|
| 01-timeline-trash-button.png | 时光列表「移到回收站」 |
| 02-confirm-move-to-trash.png | 应用内确认框 |
| 03-trash-view.png | 回收站列表（恢复/永久删除） |
| 04-confirm-purge.png | 永久删除确认（说明隔离区） |
| 05-trash-empty-after-restore.png | 恢复后空回收站 |
| 06-conflict-choice.png | 冲突二选一面板 |
| 07-conflict-copy-saved.png | 冲突副本列表 |
| 08-store-locked.png | STORE_LOCKED 全屏 |
| 09-schema-too-new.png | SCHEMA_TOO_NEW 全屏 |
| 10-photo-missing.png | 「原图缺失」占位 |
| 11-mobile-trash.png | 手机断点回收站 |

复现：`npm run screenshots:u04`。

## 已知限制 / 后续（不得记为通过）
- G03 备份合并防复活、G01 珍藏独立修订、G06 标签事务：未做。
- Windows NSIS .exe：仍 BLOCKED（上游 504）；仅 MSI。
- CI debug 签名每次不同；侧载包由 box `~/.android/debug.keystore` 重签后才能覆盖已装的 0.1.1。
- 真机写锁、回收站、隔离区、冲突选择：**NOT_RUN**。
- CodeBuddy UI 一轮未干净收尾，由 Grok Bot 补齐；未换 Qoder。

## 证据
`evidence/unit-0.4/SPEC.md`、`01-*.log`、`02-*.log`、`03-*.log`、`final.log`、截图；CI artifacts（保留约 14 天）。
