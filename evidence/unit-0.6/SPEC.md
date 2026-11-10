# Unit-0.6 安全合并 + 防复活 + 可选口令加密（G03/G02）｜实现规格（Grok Bot 编写）

对齐 Drive：G01–G06 数据契约 v1.0（G02-R1..5、G03-R3/R4/R5/R6）、任务书 v0.3 T04/T05、技术路线 v0.4。
Drive 文档对加密只约定“经审查的 AEAD + 抗暴力破解口令派生，保存盐/随机数/算法版本与参数；算法与库未选”。本单元选定见 §3。
在 Unit-0.5（`.sgbak` format 1、verify、覆盖恢复）之上增量实现；既有测试断言不得修改。只用合成数据。

## 1. 身份与 ID 冲突（关键前提）
recordId / photoUseId / conflictId 由各设备本地 seq 分配（`rec-000001`…），**不同设备会撞号**。
- **记录身份 = (recordId, createdAt)**。同 recordId 且 createdAt 相同 → 视为同一条记录；createdAt 不同 → 视为**不同记录**，导入时重新分配本地新 recordId（并同步改写引用它的冲突副本）。
- 删除标记只有 recordId（契约要求不含个人内容）。为让防复活跨设备可靠，DeletionMarker **新增可选字段 `createdAt`**（schema 仍为 v2 的向后兼容扩展：旧标记缺省为 null）。purge 时写入被删记录的 createdAt。标记匹配：recordId 相同且（任一方 createdAt 为 null 或两者相等）→ 视为同一条已删除记录（null 时按 recordId 保守匹配，宁可不复活）。
- photoUseId / conflictId 撞号：导入后若与本地已有 ID 冲突则重新分配。合并结果必须通过与 open 相同的严格校验（State::from_json）且所有 ID 全局唯一，seq ≥ 所有已用编号。
- 原图 assetId 由内容哈希决定：同 assetId 同 sha256 → 去重（不复制）；同 assetId 不同 sha256（理论上的前缀碰撞）→ 不覆盖本地文件，记 `mediaConflicts` 并让引用该图的导入照片保持“原图缺失/校验失败”占位（不改记录）。

## 2. 合并语义 `Store::plan_merge(path) -> MergePlan`（只读）与 `Store::merge_backup(path) -> MergeReport`
仅独占实例；全程写锁。先完整 verify（Unit-0.5）；plan 与 merge 用同一纯函数 `merge_states(local, incoming) -> (State, MergePlan)` 计算（可单测、无 IO）。
对 incoming 每条记录 R（按 1 的身份匹配本地 L）：
| 情况 | 处理 | 计入 |
|---|---|---|
| 本地有匹配的删除标记 | **不复活**，不导入；报告 `{recordId, createdAt}` | `skippedDeleted`（UI：“已删除记录冲突，未恢复”） |
| 本地无 L、无标记 | 原样导入（含 status、draft、trashed 状态），ID 撞号则重编 | `added` |
| L 在回收站，R 为 active | **保持 L 在回收站**，不移出；若 R.formal 与 L.formal 内容不同 → R.formal 存为冲突副本（reason `merge-incoming`） | `keptTrashed` |
| L active，R trashed | 保持 L active（不因旧包把本机记录移入回收站）；内容按下一行比较 | `keptActive` |
| 两者 formal 内容相同（快照逐字段相等） | 不变；contentRevision 取二者较大 | `unchanged` |
| 内容不同 | **contentRevision 大者胜**为正式版；相等时本地胜。败者 formal 存为冲突副本（reason `merge-replaced-local` 或 `merge-incoming`），**任何一方内容都不丢** | `updated`（incoming 胜）/ `conflicts`（本地胜但留副本） |
草稿：本地有草稿 → 保留本地草稿；incoming 草稿与之不同 → 存冲突副本（`merge-incoming-draft`）。本地无草稿、incoming 有 → 导入为草稿，base_revision 设为合并后正式版 revision；若 incoming 草稿的 base 小于合并后正式 revision → 改存冲突副本（避免旧草稿悄悄成为基准）。
incoming 的删除标记：本地有匹配记录（active 或 trashed）→ **保留本地记录**，报告 `deletedInBackup`（契约 G02-R3：不因收到删除标记就抹掉本机数据）；本地无该记录 → 追加标记（并集，防将来复活）`markersAdded`。
incoming 冲突副本：记录映射存在则导入（去重：同 recordId+createdAt+快照相同视为已有），否则丢弃并计数。
照片：只复制本地缺少的被引用原图（按 assetId+sha256 去重），`mediaAdded`；包内缺失原图的引用保留（占位），`mediaMissing`。
时间戳**不参与**胜负判定（契约）。

### 原子性（与覆盖恢复同级）
1. verify → 2. 在 staging 计算合并 State，序列化并严格校验 → 3. 安全副本 `backups/pre-merge-<ts>/`（state.json + 本次将新增的原图列表，原图本身不改动，因为合并对 media/ 只增不改；可只复制 state.json）→ 4. 新原图先写 `media/.tmp-*` → fsync → rename 到 `media/<asset>`（仅新文件，记入日志）→ 5. `write_atomic(state.json)` **提交点** → 6. 删日志 → 7. reconcile。
失败（含故障注入）在提交点前：删除本次新增的原图（只删日志里记录的、本次新建的文件），state.json 不变；崩溃后 open 时依据 `.merge-journal.json` 回滚同样处理。提交点后崩溃：视为已完成，只清日志。
重复导入同一包（幂等）：第二次 plan 全部 unchanged/skipped，`added=0`，不产生新冲突副本。

## 3. 可选口令加密
**选型**：KDF **Argon2id**（RFC 9106；默认 m=64 MiB、t=3、p=1，参数写入头部；解密时接受 m∈[8 KiB, 1 GiB]、t∈[1,10]、p∈[1,4]，超出拒绝防 DoS），AEAD **XChaCha20-Poly1305**（192 位随机 nonce，无 nonce 复用风险），分块 STREAM 构造（参考 libsodium secretstream / Rogaway STREAM）：块大小 1 MiB；第 i 块 nonce = 头部 19 字节随机前缀 ‖ u32 BE i ‖ last 标志（1 字节 0/1）；AAD = 完整头部字节。截断（缺最后块/最后块标志不对）、重排、篡改、错误口令都会认证失败。
crates（RustCrypto，纯 Rust，Cargo.lock 固定）：`argon2`、`chacha20poly1305`（XChaCha20Poly1305）、`getrandom`（盐/nonce）、`zeroize`（密钥/口令缓冲清零）。理由：纯 Rust 无 C 依赖，三端+Android 交叉编译无需 NDK 额外库；广泛使用并经第三方审计（chacha20poly1305 2020 NCC 审计）；依赖少。不用 ZIP 加密（非 AEAD）。
- 容器：magic `SGBAKENC\x00\x01`（10 字节）+ u32 LE 头长度 + 头 JSON `{format:"shiguang-backup-encrypted", formatVersion:1, kdf:{alg:"argon2id", version:19, m, t, p, salt(b64 16B)}, aead:{alg:"xchacha20poly1305", noncePrefix(b64 19B), chunkSize}, plaintextBytes}` + 密文块序列。明文 = 完整的 Unit-0.5 `.sgbak`。
- 内层 manifest 的 `encryption` 仍为 `{"mode":"none"}`（它描述内层）；外层头即加密描述。`verify_backup` 遇到加密包 → `BACKUP_PASSWORD_REQUIRED`（替代 0.5 的 ENCRYPTED_UNSUPPORTED，旧码保留给未知 mode）。
- API：`Store::export_backup_encrypted(dest, app_version, password: &str, params: KdfParams)`（先导出明文到数据根内临时文件 → 流式加密到 partial → 解密校验一遍 → 发布 → 删除明文临时文件；任何失败不留明文/partial）；`backup::decrypt_backup(src, dest_plain, password) -> Result<(), CoreError>`（流式；失败删除 dest_plain）；`backup::is_encrypted(path) -> bool`；`KdfParams::default()` 与仅测试/CLI 使用的低成本参数（测试必须用低成本参数以免过慢）。restore/merge 对加密包：调用方先 decrypt 到数据根内 `.decrypt-<id>.sgbak` 再走原流程（core 提供 `restore_backup_overwrite_with_password` / `merge_backup_with_password` / `plan_merge_with_password` 包装，结束后删除明文副本）。
- 错误码：`BACKUP_PASSWORD_REQUIRED`、`BACKUP_PASSWORD_WRONG`（首块认证失败：“口令不正确，或文件已损坏”）、`BACKUP_CORRUPT`（后续块失败/结构错误）、`BACKUP_TRUNCATED`、`BACKUP_KDF_PARAMS_INVALID`、`BACKUP_PASSWORD_EMPTY`（空口令拒绝导出）。一律在写任何数据前拒绝，现有数据逐字节不变。
- 口令不得出现在：错误消息、日志、Debug 输出、测试输出、CLI argv。CLI 只从环境变量 `SHIGUANG_BACKUP_PASSWORD` 或 `--password-stdin` 读取。

## 4. 测试（先写测试再实现；core/tests/unit06_*.rs、CLI 测试）
- merge_states 纯函数表驱动：上表每一行 + 撞号（同 id 不同 createdAt → 新 id，冲突副本引用随之改写）+ photoUseId/conflictId 撞号 + 结果通过严格校验。
- **防复活**：A 导出 → A purge 记录 X → 合并 A 的旧包 → X 不出现、`skippedDeleted` 含 X；回收站中的 Y 合并旧包后仍在回收站；B 设备（不同 seed/新库）带 X 的同 id 不同 createdAt 记录 → 作为新记录导入（不是复活）。
- 旧包带删除标记、本地仍有该记录 → 本地保留，报告 deletedInBackup。
- 版本竞争：incoming revision 大 → 更新且本地旧版成冲突副本；本地大 → 保留且 incoming 成冲突副本；相等不同 → 本地胜 + 副本。
- 照片去重：已有原图不重复复制；包内缺失原图 → 占位；assetId 同 sha 不同 → mediaConflicts，本地文件不变。
- 幂等：同一包合并两次，第二次无变化（state 逐字节相同或仅允许的差异）。
- plan 只读：plan 前后数据根逐字节不变；plan 结果与 merge 报告一致。
- 故障注入（新 FaultPoint：`MergeStage`、`MergeMediaWrite`（第 k 个新原图写后失败）、`MergeStateWrite`、`CrashAfterMergeMedia`(跳过回滚模拟被杀)、`EncryptChunk`、`DecryptChunk`）：失败后数据根逐字节等于合并前（backups/ 允许新增安全副本），无 tmp/journal 残留；崩溃模拟后重新 open → 回滚为旧状态。
- 加密：往返（低成本参数）；错误口令 → PASSWORD_WRONG 且目标不变；篡改头/任一块/AAD → 拒绝；截断（去掉末块、截一半、只剩头）→ 拒绝；块重排 → 拒绝；空口令拒绝导出；加密导出失败不留明文临时文件；加密包 verify_backup → PASSWORD_REQUIRED；断言口令字符串不出现在任何错误 message / Debug 中。
- CLI：`export-backup <dest> [--encrypt]`（口令来自 env/stdin）、`plan-merge <file>`、`merge-backup <file> --yes`、restore/verify 支持加密包；测试用 env 传合成口令。

## 5. Tauri / TS / UI（Grok Bot）
- Tauri：`export_backup({password?})`、`pick_backup` 返回 `encrypted`；`unlock_backup(token, password)` 解密到应用缓存并校验；`plan_merge(token)`、`merge_backup(token)`；restore/merge 结束删除明文副本。
- TS/MemoryAdapter 同语义；capabilities merge/encryption/antiResurrection = true。
- UI：导出区“使用口令加密（可选）”+ 两次输入口令 + “口令丢失将无法找回备份内容，拾光不保存口令”提示；恢复区在校验后给出两个按钮：「合并导入（保留现有，只添加/更新）」→ 先展示合并计划 → 二次确认；「覆盖恢复（替换全部）」→ 原二次确认。加密包先要求输入口令。
- 版本 0.1.5 / versionCode 1005。
