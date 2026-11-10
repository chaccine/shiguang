# Unit-0.4 数据安全核心 2｜实现规格（Grok Bot 编写，对齐 G01/G02/G04 契约 v1.0 与任务书 v0.3）

命名对齐 Drive `00_拾光_P0数据契约_G01-G06正式产品契约_v1.0.md`：Record `status(active|trashed)`、`DeletionMarker`、`ConflictCopy`、`assetId`/`photoUseId`。
只用合成数据。core 保持零第三方依赖（std 的 `File::lock`/`try_lock` 自 Rust 1.89 稳定，工具链 1.90.0 可用）。
所有既有测试的断言不得修改（只允许为新 API 调整调用方式，且需在报告中逐条说明）。

## 1. 多进程写锁（Unit-0.1 遗留项 g）
- 两层锁，文件均位于数据根目录：
  - `.write.lock`：**每次事务**（`transact`、`commit` 的重载→比较→替换全过程，以及 Store::open 时清理 `.tmp-*`、迁移）都必须持有排他锁。获取用 `try_lock` 重试，总等待上限约 3 秒，超时返回 `STORE_BUSY`（中文消息：“另一个拾光窗口正在写入，请稍后重试；你的输入未丢失”）。持锁期间重载磁盘状态，消除 Unit-0.1 记录的竞态窗口。
  - `.instance.lock`：新 API `Store::open_exclusive(root)` 在整个 Store 生命周期持有排他锁；第二个实例返回 `STORE_LOCKED`（中文：“拾光已在另一个窗口或程序中打开。为保护你的数据，这里暂不能写入，请先关闭另一个窗口再重新打开。”）。`Store::open` 保持原语义（不持实例锁，仅事务写锁），供 CLI 与既有测试使用。Tauri 桌面/安卓改用 `open_exclusive`。
- `Store::open` 清理 `.tmp-*` 必须在持有 `.write.lock` 时进行（否则会删掉另一进程正在写的临时文件）。
- 失败时 `STORE_LOCKED` 不得写任何文件、不得清理任何文件。
- 测试：同进程两个 `open_exclusive` → 第二个 `STORE_LOCKED`，drop 第一个后可打开；**子进程测试**：用 CLI 二进制（新增 `hold-lock <ms>` 测试命令或等价方式）持有实例锁/写锁，父进程断言 `STORE_LOCKED` / `STORE_BUSY` 且 state.json 字节不变；并发子进程（例如 4 个 CLI 进程各自 create-draft 20 次）结束后 state.json 可严格解析、记录数 = 80、seq 无重复（证明无丢失更新）。

## 2. G02 删除：回收站 + 删除标记
- RecordRow 新增 `status`：`"active" | "trashed"`，`trashedAt: string|null`。
- `trash_record(record_id)`：仅正式记录（formal 存在）可移入回收站；内容（formal 与可能存在的 draft）完整保留；`list_formal` 与 `list_drafts` 不再返回 trashed 记录；新增 `list_trash()`（按 trashedAt 倒序）。
- `restore_record(record_id)`：trashed → active，内容与修订号不变。
- 对 trashed 记录执行 save_draft / attach / commit 等写操作 → `RECORD_TRASHED`，不改任何文件。
- **永久删除只能手动**：`purge_record(record_id)`（只允许 trashed）与 `empty_trash()`（清空全部 trashed）。没有任何自动/定时清理。
- 永久删除时从 records 移除整行，并在 state 新增的 `deletionMarkers` 数组写入 `DeletionMarker { recordId, deletedAt, lastContentRevision }`——**不含标题/正文/照片说明等个人内容**。同一 recordId 不可被重新创建（ID 由 seq 分配，天然不复用；`row()` 对已删除 ID 返回 `RECORD_DELETED` 而不是 NOT_FOUND）。
- 永久删除后不再被任何记录/草稿/回收站/冲突副本引用的原图：**不硬删**，移动到 `media-quarantine/<yyyymmddThhmmss>/`，返回被隔离的文件列表。隔离区本单元不自动清理（后续单元做“清理隔离区”的显式入口）。
- 跨备份防复活（G02-AC 中“B 旧备份合并”）依赖 G03 导入，本单元只提供 deletionMarkers 数据基础，报告中标 NOT_RUN/后续。

## 3. schemaVersion 迁移框架
- state.json 顶层：`version` 继续表示**容器格式版本**（仍为 1，既有 `STATE_VERSION_UNSUPPORTED` 测试保持）；新增 `schemaVersion` 表示数据结构版本。缺失 `schemaVersion` 视为 1（Unit-0.1~0.3 的文件）。当前 `CURRENT_SCHEMA_VERSION = 2`（v2 = 加入 status/trashedAt、deletionMarkers、conflictCopies）。
- 打开时：`schemaVersion > CURRENT` → `SCHEMA_TOO_NEW`（中文：“这份数据由更新版本的拾光写入，当前版本无法安全读取。请升级拾光；原数据未改动。”），**不写任何文件**。
- `schemaVersion < CURRENT`：在 `.write.lock` 下 ① 先把原 state.json 原样复制到 `backups/state.schema-v{from}.{timestamp}.json`（临时文件+fsync+rename+目录同步，与 persist 同标准），② 按迁移链 v1→v2 …逐步迁移内存对象，③ 严格校验，④ 原子写入新 state.json。任一步失败：返回 `MIGRATION_BACKUP_FAILED` / `MIGRATION_FAILED`（带 stage），原 state.json 字节不变。备份文件永不自动删除。
- 迁移链以函数表组织（`fn migrate_v1_to_v2(Json) -> Result<Json, CoreError>`），新增版本只需追加一项。
- 事务中重载磁盘时若遇到旧 schema（理论上只有旧版程序并发写入时才会发生），返回 `SCHEMA_CHANGED_ON_DISK`，不写。
- fault-injection 新增故障点：`MigrationBackup`（备份写入失败）、`MigrationWrite`（备份成功后写新 state 失败）；断言原文件字节不变、备份存在/不存在符合预期、再次打开可重新迁移成功。

## 4. 照片文件 ↔ 状态一致性（G04 最小部分）
- `Store::reconcile_media() -> MediaReport`：仅允许在 `open_exclusive` 实例上执行（否则 `STORE_NOT_EXCLUSIVE`），Tauri 启动时调用一次。
  - **孤立原图**：`media/` 下没有被任何 formal / draft / trashed 记录 / conflictCopies 引用的文件（典型来源：导入照片写完原图但状态未写入就崩溃）→ 移动到 `media-quarantine/<timestamp>/`，**绝不删除**。`media/` 下的 `.tmp-*` 半写文件同样移入隔离区。
  - **缺失/损坏原图**：被引用但文件不存在 → `missing`；字节数或 SHA-256 不符 → `corrupt`。不修改任何记录，只在报告与 `photo_status(asset_id)` 中给出，UI 显示“原图缺失”/“原图校验失败”。
  - 报告：`{ quarantined: [{assetId?, file, movedTo}], missing: [{recordId, photoUseId, assetId}], corrupt: [...], checkedAt }`。
- 预览缓存（previews/）可重建，不计入孤立原图逻辑。
- fault-injection：模拟“原图写入后、状态写入前失败”（新增故障点 `AfterMediaWrite` 或复用现有点），重启后 reconcile 把它移入隔离区，state 无悬空引用。

## 5. 冲突副本（G01 最小部分）与 UI 需要的 API
- state 新增 `conflictCopies: [ConflictCopy { conflictId, recordId, baseRevision, snapshot, createdAt, reason }]`。
- `commit` 出现 `REVISION_CONFLICT` 且磁盘草稿槽已被另一份草稿占用时：把本地草稿写入 conflictCopies（替代 Unit-0.1 “只在内存中”的限制）。
- `resolve_conflict(record_id, choice)`：
  - `"keepMine"`：用户明确选择以自己的草稿为准 → 草稿 base_revision 改为当前正式 contentRevision（之后由用户再次点“存入时光”提交；不自动提交）；
  - `"keepFormal"`：保留当前正式版 → 草稿移入 conflictCopies（可恢复，不丢失），草稿槽清空。
- `list_conflict_copies()`；`restore_conflict_copy(conflict_id)`：在草稿槽为空时把副本恢复为草稿（base = 当前正式版）。
- 冲突判定仍不使用时间戳。

## 6. 贯通层
- CLI：新增子命令 `trash`、`restore`、`purge`、`empty-trash`、`list-trash`、`reconcile`、`resolve-conflict`、`list-conflicts`、`hold-lock`（测试用）。
- Tauri 命令（snake_case）：`trash_record`、`restore_record`、`purge_record`、`empty_trash`、`list_trash`、`resolve_conflict`、`list_conflict_copies`、`restore_conflict_copy`、`media_report`、`store_status`。setup 中 `open_exclusive` 失败（STORE_LOCKED / SCHEMA_TOO_NEW / STATE_CORRUPT）**不得 panic**：AppState 保存错误，所有命令返回该错误，`store_status` 返回 `{ok:false, code, message}` 供 UI 显示全屏中文提示。
- TS：`ShiguangApi` 增加对应方法；`RecordRow` 类型加 `status`/`trashedAt`；MemoryAdapter 同语义实现（浏览器预览用）；`describeError` 为 STORE_LOCKED、STORE_BUSY、SCHEMA_TOO_NEW、RECORD_TRASHED、RECORD_DELETED、MIGRATION_* 给出中文文案；新增 tests/*.test.ts。

## 7. UI（CodeBuddy）
- 时光列表：每条“移到回收站”（二次确认）。
- 新标签页“回收站”：列表、恢复、单条永久删除（二次确认）、“清空回收站”（二次确认，说明不可撤销、照片原件移入隔离区）。
- 冲突面板：REVISION_CONFLICT 时给出两个按钮“以我的草稿为准（之后再存入）”“保留现在的正式版（我的草稿另存为冲突副本）”。
- 启动错误：STORE_LOCKED / SCHEMA_TOO_NEW 全屏中文提示。
- 照片缺失：缩略图位置显示“原图缺失”。
