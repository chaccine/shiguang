# Unit-0.5 最小完整备份与恢复（G03 最小版）｜实现规格（Grok Bot 编写）

对齐 Drive：`00_拾光_P0数据契约_G01-G06正式产品契约_v1.0.md` G03-R1/2/4/5/6、G02-R4；任务书 v0.3 P0-T03/T04；技术路线 v0.4 BackupPort/PlatformFilePort。
只用合成数据。**core 保持零第三方依赖**（不压缩；原图本身多为已压缩格式，压缩收益小，且避免引入 zip/flate 依赖与 ZIP 炸弹/路径穿越攻击面）。
既有测试断言不得修改。备份 ≠ 同步。

## 0. 本单元范围
做：导出（一致性快照）→ 完整校验 → 覆盖恢复（先内部安全副本、原子切换、失败回滚、可崩溃恢复）。
不做（UI/文档标「未实现」）：安全合并、口令加密、跨备份防复活。容器为其预留：manifest `encryption: {"mode":"none"}`、`deletionMarkers` 随 state 一起进包。

## 1. 数据根现状（备份对象）
`state.json`（records 含正式/草稿/回收站、deletionMarkers、conflictCopies、seq、seed、schemaVersion）+ `media/<asset files>`（原图）。
`previews/` 是可重建缓存，**不进包**。`backups/`、`media-quarantine/`、锁文件、`.tmp-*` 不进包。

## 2. 容器格式 `.sgbak`（format 1，无压缩、无加密）
```
[8B magic "SGBAK\0\0\x01"]
[8B u64 LE manifestLen][manifest JSON UTF-8, manifestLen bytes]
[entries: 按 manifest.entries 顺序依次拼接原始字节]
[trailer 48B: 8B magic "SGBAKEND" + 32B sha256(之前全部字节) + 8B u64 LE 之前全部字节总长]
```
manifest JSON（键用 camelCase）：
```
{ "format":"shiguang-backup", "formatVersion":1, "schemaVersion":2, "appVersion":"0.1.4",
  "exportedAt":"<ISO UTC>", "encryption":{"mode":"none"}, "compression":"none",
  "counts":{"formal":n,"drafts":n,"trashed":n,"deletionMarkers":n,"conflictCopies":n,"mediaFiles":n,"missingMedia":n},
  "missingMedia":[{"assetId":"…"}],
  "entries":[{"path":"state.json","size":n,"sha256":"hex"},{"path":"media/<file>","size":n,"sha256":"hex"}, …] }
```
- entry path 白名单：恰为 `state.json`，或 `media/<name>`，name 仅 `[A-Za-z0-9._-]`、不以 `.` 开头、长度 ≤ 128；禁止 `..`、`/`、`\`、绝对路径、重复路径。state.json 必须存在且恰好一个。
- 上限：manifest ≤ 8 MiB，entries ≤ 100000，单文件/总量 ≤ 包文件实际长度（防伪造大小导致巨量分配）；读取用流式 + 固定缓冲，不把整个包读进内存。
- appVersion 由调用方传入（CLI/Tauri 传 CARGO_PKG_VERSION / 应用版本）。
- 被引用但磁盘缺失（或校验失败）的原图：不阻止导出，记入 `missingMedia` 并计数，导出结果把它报告出来（UI 提示“有 N 张原图缺失，未包含在备份中”）。只打包被引用的原图（formal/draft/trashed/conflictCopies 引用），按文件名排序，保证确定性。

## 3. 导出 `Store::export_backup(dest: &Path, app_version: &str) -> Result<ExportReport, CoreError>`
- 在 `.write.lock` 下：重载磁盘 state（同 candidate_state 语义），基于这一份快照确定 entries。为缩短持锁时间可以：持锁期间把 state.json 字节读入内存 + 计算引用的 media 列表与每个文件 sha256/size（原图不可变、只追加，导出期间持锁足以保证一致），然后在锁内写包（MVP 允许整个导出持锁；STORE_BUSY 由其它写者承担）。
- 写到 `dest` 同目录的临时文件 `.<name>.partial-<pid>-<n>`，写完后**重新打开临时文件做一次完整校验**（复用第 4 节 verify），通过后 fsync + rename 到 dest + 父目录同步；任何失败删除临时文件、不留下 dest、不改动数据根任何文件（state.json、media/ 字节与 mtime 不变）。dest 已存在 → `BACKUP_DEST_EXISTS`（Tauri 层先导出到应用内临时位置再复制到用户选择的位置，见第 7 节）。
- 写包时对每个 media 文件边读边算 sha256，若与快照阶段算出的不一致 → `BACKUP_SOURCE_CHANGED` 失败。
- ExportReport：`{ path, bytes, sha256(整个包), manifest 摘要(counts, exportedAt, schemaVersion, appVersion), missingMedia }`。
- 空库（无 state.json 或 0 记录）也可导出（state.json 用当前内存空状态序列化）。

## 4. 校验 `shiguang_core::backup::verify_backup(path: &Path) -> Result<BackupInfo, CoreError>`（不需要 Store）
严格顺序，任一失败即返回，**绝不写任何文件**：
1. 长度 ≥ 8+8+48，magic 正确，否则 `BACKUP_INVALID`（“这不是拾光备份文件，或文件已损坏”）。
2. trailer magic 存在且记录总长 = 文件长度-48，否则 `BACKUP_TRUNCATED`（“备份文件不完整（可能拷贝中断）”）。
3. 流式计算 sha256(除 trailer 外全部字节) 与 trailer 比较，不等 → `BACKUP_CORRUPT`（“备份文件内容被修改或损坏”）。
4. manifest 解析、字段齐全、format/formatVersion 支持（formatVersion>1 → `BACKUP_FORMAT_TOO_NEW`），encryption.mode 必须 "none"（否则 `BACKUP_ENCRYPTED_UNSUPPORTED`：“此备份已加密，当前版本尚不支持口令解密”），schemaVersion > CURRENT → `BACKUP_SCHEMA_TOO_NEW`（“备份来自更新版本的拾光，请先升级”），path 白名单/重复/上限 → `BACKUP_INVALID`。
5. entries 大小之和 + 头 + manifest = trailer 前长度，否则 `BACKUP_CORRUPT`。逐 entry 流式算 sha256 与大小比对，不符 → `BACKUP_CORRUPT`（message 中带 path）。
6. 解析 state.json：严格 parse + 按 schema::migrate（允许旧 schema，恢复时迁移）+ State::from_json；失败 → `BACKUP_CORRUPT`。counts 与 state 实算不一致 → `BACKUP_CORRUPT`。state 中引用、不在 missingMedia 的 asset 必须在 entries 里，否则 `BACKUP_CORRUPT`。
- BackupInfo：manifest 摘要（counts、exportedAt、appVersion、schemaVersion、bytes、missingMedia 数）。供 UI 恢复前展示。

## 5. 覆盖恢复 `Store::restore_backup_overwrite(path: &Path) -> Result<RestoreReport, CoreError>`
仅允许 `open_exclusive` 实例（否则 `STORE_NOT_EXCLUSIVE`）；全程持 `.write.lock`。阶段（每阶段都有 fault-injection 故障点）：
1. **verify**：完整校验（第 4 节）。失败 → 原样返回校验错误，不改任何文件。
2. **stage**：在数据根下建 `.restore-staging-<ts>/`，把 state.json（如 schema 旧则迁移后的版本）与 media 文件流式解出并**逐个重算 sha256**，fsync 文件与目录。失败 → 删除 staging，返回 `RESTORE_FAILED`(stage=stage)，现有数据不变。
3. **safety backup**：把当前 `state.json` 与 `media/` 全部文件复制到 `backups/pre-restore-<ts>/`（复制后逐文件校验 sha256 与大小，fsync），并写 `backups/pre-restore-<ts>/SAFETY.json`（时间、原 counts）。失败 → 删除该半成品目录与 staging，返回 `RESTORE_SAFETY_BACKUP_FAILED`，现有数据不变。安全副本**永不自动删除**。
4. **switch**（提交点设计，允许崩溃恢复）：
   a. 写日志 `.restore-journal.json`（write_atomic）：`{phase:"switching", staging, old:".restore-old-<ts>", safety}`。
   b. `rename(media, old/media)`；`rename(staging/media, media)`；
   c. `write_atomic(state.json, staging/state.json 字节)` ← **提交点**；
   d. 删除日志（commit 完成），然后把 `old` 目录移入 `backups/pre-restore-<ts>/replaced/`（或直接删除 old，因为 safety 里已有完整副本——**选择：不删除，移到 backups 内**，保证不硬删原图）；删除空 staging。
   - b/c 任一步失败：按日志回滚（media 换回、state.json 未替换则保持旧字节），删除日志，返回 `RESTORE_FAILED`(stage=switch)；回滚后 state.json 与 media/ 与恢复前逐字节一致。
5. **reopen**：内存状态改为新 state，执行 `reconcile_media()`，返回 RestoreReport `{ restoredCounts, safetyBackupDir, mediaReport }`。
- **崩溃恢复**：`Store::open` / `open_exclusive` 在持写锁时若发现 `.restore-journal.json`：若 state.json 已等于 staging/state.json 字节（或 staging 已不存在且 media 为新）→ 视为已提交，完成第 d 步；否则回滚到旧数据。之后才清理 `.tmp-*`。无论哪种，结果只能是“完整旧状态”或“完整新状态”。残留且无日志的 `.restore-staging-*` 在 open 时删除（只删 staging，不碰其它）。
- 恢复不改变 `.instance.lock`/`.write.lock` 文件。previews/ 恢复后清空并按需重建（可删，因为是缓存）。

## 6. 故障注入（feature `fault-injection`，在 fault.rs 追加 FaultPoint）
`BackupWrite`（导出写包中途）、`BackupFinalize`（rename 前）、`RestoreStage`、`RestoreSafety`、`RestoreSwitchMedia`（b 之后、c 之前）、`RestoreSwitchState`（c 中失败）、`RestoreAfterCommit`（c 之后 d 之前：模拟崩溃，返回错误但磁盘应被视为已提交——测试用“drop 后重新 open”验证完成为新状态）。
另：为崩溃语义，测试可以用 `fault::set(RestoreSwitchMedia)` 后不走回滚的变体（例如 `FaultPoint::CrashAfterMediaSwap`：返回错误且跳过回滚，模拟进程被杀），重开后必须回滚为旧状态。

## 7. 必须有的测试（core/tests/unit05_backup.rs、unit05_faults.rs；先写测试再实现）
- 往返：构造含正式记录（多条、含照片与 caption、同一原图两处使用）、草稿（新建 + 修改已发布）、回收站、DeletionMarker（purge 后）、冲突副本、缺失原图（删掉某 media 文件）的合成库 → 导出 → 新空目录 open_exclusive → 恢复 → 逐记录比对（state_json 除可接受的差异外完全相等：records/deletionMarkers/conflictCopies/seq/seed）、逐 media 文件 sha256 一致；missingMedia 被报告；重新 open 正常、reconcile 无 quarantine。
- 覆盖：库 A 导出，库 B（内容不同）恢复 A → B 内容 = A；`backups/pre-restore-*` 中 state.json/media 与恢复前的 B 逐字节一致。
- 导出不改源：导出前后数据根每个文件字节相同（排除锁文件）。
- 空库导出/恢复。
- 篡改：改 media 一个字节（同时重算 trailer 与否两种）→ `BACKUP_CORRUPT`；改 manifest 中 sha256 → `BACKUP_CORRUPT`；截断（各种长度，含 0、<header、截掉 trailer 一半）→ `BACKUP_TRUNCATED`/`BACKUP_INVALID`；非备份文件 → `BACKUP_INVALID`；schemaVersion 99 → `BACKUP_SCHEMA_TOO_NEW`；encryption mode "aes" → `BACKUP_ENCRYPTED_UNSUPPORTED`；路径穿越 `media/../x`、`../state.json`、重复 path → `BACKUP_INVALID`。上述每种情况都断言目标库所有文件字节不变、无 staging/journal 残留。
- 旧 schema（v1 state）的包可以恢复并迁移到 v2。
- 非独占 Store 恢复 → `STORE_NOT_EXCLUSIVE`。
- 故障：每个 FaultPoint 下，失败后目标库与恢复前逐字节一致（除 backups/ 下允许新增的完整安全副本）、无残留 staging/journal/partial；RestoreAfterCommit 重开后为完整新状态；CrashAfterMediaSwap 重开后为完整旧状态；BackupWrite/BackupFinalize 后 dest 不存在、无 partial 残留。
- CLI：`export-backup <dest>`、`verify-backup <file>`、`restore-backup <file> --yes`（无 --yes 拒绝）；cli 测试至少 1 个往返。

## 8. Tauri / TS / UI（第二阶段）
- Tauri 命令：`export_backup_to_temp`（core 导出到 `app_cache_dir/exports/拾光备份-<yyyyMMdd-HHmmss>.sgbak`，返回 ExportReport）、`save_backup_as`（桌面：dialog 选保存路径；Android：dialog save → SAF content URI，用 tauri-plugin-fs 打开写入；返回用户可读位置）、`pick_and_verify_backup`（dialog 选文件 → 复制到 app 缓存 `imports/` → verify → 返回 BackupInfo + token）、`restore_backup(token)`（覆盖恢复，返回 RestoreReport）、`share_backup`（若 SAF 不稳定的退路，可不做）。
- 插件：tauri-plugin-dialog + tauri-plugin-fs（仅 Rust 侧调用，capabilities 只加所需最小权限；不加 INTERNET）。
- TS：ShiguangApi `exportBackup()`, `verifyBackup()`, `restoreBackup()`；MemoryAdapter 同语义（内存中 JSON 序列化包 + sha256，可模拟损坏）。describeError 覆盖全部 BACKUP_*/RESTORE_* 中文文案。
- UI：新增「设置/数据」页：导出备份（成功显示位置、大小、记录数、缺失原图提示、“这是明文备份，请妥善保管”提示）；从备份恢复（选文件 → 显示备份信息 → 强提示二次确认：“恢复会用这份备份**替换当前全部数据**（包括草稿、回收站、冲突副本）。旧备份中可能包含你后来已删除的内容。恢复前会自动在本机保留一份当前数据的安全副本。” → 成功提示安全副本位置）；「安全合并（未实现）」「口令加密（未实现）」「防复活检查（未实现，依赖合并）」灰色并说明；提示“本机数据卸载会丢失，请把备份存到设备外”。
