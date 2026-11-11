# Unit-0.10 Task A · schema v4 / 0.1.10

范围：M01 数据、M06 主题偏好、M07 本地应用锁与备份兼容。G01–G06 不变。
不增加 M04 博物馆、M05 检索、M08、网络、定位、地理编码或云功能。

## 内容模型

`Snapshot` 在 formal、draft、conflictCopies 中同构：

- `photos[].caption` 沿用 v3 已有的使用位独立、多行、可空纯文本。不写入原图，
  不解析为 HTML，不擅加未经验证的字符上限（M01 R06）。
- `photos` 数组是唯一权威顺序；`reorder_draft_photos` 必须给出完整 photoUseId
  排列，不得缺失、重复或引用其它记录。说明随整个使用位移动，不另存一套排序。
- `coverPhotoUseId: string | null`：添加首图时设为首图；用户可选择本快照内的其它图。
  重排不改变封面（包括初始默认选择）。移除封面后回退到当前剩余首图；无图则 null。
  非空相册必须有有效封面，悬空/跨记录封面在读取、导入及写入时拒绝。
- `location: string`：默认空字符串，最多 200 个 Unicode 标量字符（TS 按码点计数）。
  完全手写、原样保存，包括空格、换行、引号、尖括号与控制字符；不自动修剪或剥离
  文本。展示必须使用文本节点或 HTML 转义。没有 GPS、EXIF 定位提取、网络或地理编码。
- `mood: null | 开心 | 平静 | 感动 | 想念 | 疲惫 | 难过`：默认 null。上游仅规定
  可选心情，没有固定集合，本单元采用 Cine 授权示例集合；未知值拒绝，null 显式清空。

所有内容写入仅作用于 draft，缺少修改草稿时从 formal 派生。`save_draft_patch`
把所有标量字段放进同一次事务；说明、封面和重排各为一次草稿事务。正式投影始终
读取 formal。commit 沿用原 contentRevision/baseRevision CAS，一次原子写完整复制
快照并清理草稿；discard 不改 formal；收藏与标签仍是独立元数据，提交不覆盖它们。
标题、地点、心情或说明单独存在都不能替代正文/安全原图的提交底线。

## 迁移与备份

`version=1` 仍为状态容器版本；`schemaVersion=4` 为新数据结构。迁移链为
v1→v2→v3→v4。v3 新字段补空地点、null 心情、首张封面（无照片为 null）；
保留已有说明、原图、顺序、正式/草稿隔离、回收站、删除标记、冲突副本、标签/收藏。
实际 v3 已有 caption 字段，不能为了“缺省说明”丢掉旧说明。

打开旧库仍持写锁，把原 state.json 原字节原子写到
`backups/state.schema-v{from}.*.json`，迁移内存并严格校验，再经现有同目录临时文件
→ fsync → 原子替换 → 目录同步的安全路径落 v4。替换前失败原 v3 文件不变，
可重新打开；成功替换后的目录同步不确定性仍沿用既有语义，不承诺回滚提交点。
新于 v4 的数据先拒绝，不清理临时文件、不创建迁移备份、不覆盖原文件。

`.sgbak` 明文容器 format 1 和加密外层 SGBAKENC v1 不变。新包内层 schemaVersion=4。
冻结的 v3 明文包和生产 Argon2id 参数加密包由 **b882029 的 v3 代码**提前生成，
位于 `core/tests/fixtures/v3/`。测试直接消费这些字节，不能用 v4 伪造“旧备份”。
旧包覆盖恢复先校验并迁移到 staging，再沿用安全副本/日志/原子切换；错口令、损坏
和新版本拒绝不改本机数据。v1/v2 备份继续走原有迁移链。

合并沿用身份 `(recordId, createdAt)`、删除防复活、内容修订胜负与冲突副本规则。
caption、cover、照片顺序、location、mood 都参与内容相等比较；分歧必须保留两份。
photoUseId 撞号改号时同步重映射封面，冲突副本也适用；重复导入保持幂等。
同一原图在一个快照里重复出现时，各使用位仍有独立身份；即使说明相同，交换它们
的顺序也必须被识别为内容分歧。MemoryAdapter 在比较前按来源映射正规化 ID，
正式/草稿/冲突快照沿用同一使用位映射，重导出后也保留来源身份，不靠忽略 ID 去重。

0.1.9 等旧版最多支持 schema v3，按其既有 manifest 版本检查，以
`BACKUP_SCHEMA_TOO_NEW` 拒绝 v4 备份；加密备份解密后同样拒绝内层 v4。
不能把 v4 文件手工改成 v3 交给旧版，否则可能丢字段。

## 设置及应用锁安全模型

v4 顶层 `settings`：`theme: light | dark | system`（默认 system）、
`appLock: null | 本机凭据和失败计数`（默认 null）。主题随备份导出、覆盖恢复；
安全合并保留本机主题，不用其它设备的偏好覆盖本机选择。

应用锁只是一道供 UI 调用的访问门禁，不加密正文/原图/数据库/磁盘。桌面的
state.json 对有文件访问权限的人可读；Android 不防 root、adb 备份或已取得本地文件
访问权的人。Task A 实现核心和命令契约，解锁屏幕、自动重锁、最近任务遮挡及真实
设备隐私验证属于后续 UI 工作；没有接入 UI 门禁前不能宣称应用已受到锁保护。

凭据使用 4–8 位 ASCII 数字，Argon2id v19，随机 16 字节盐，32 字节结果；新设置
参数 m=65536 KiB/t=3/p=1，盐/算法/版本/参数随本机 state 保存。读取限定
m∈[19456,65536]、t∈[2,6]、p∈[1,4]，防损坏数据引起无界资源消耗。
验证采用 RustCrypto `subtle::ConstantTimeEq` 对固定 32 字节结果恒时比较；不记录
明文、hash 或盐的日志，凭据 Debug 脱敏。复用锁定依赖中的 argon2/getrandom/
zeroize/subtle，无新增下载。持久化 JSON 含本机凭据，安全 IPC 视图只返回状态。

失败尝试和下次允许时间写入同一个原子状态事务。第 3 次失败后等待 1 秒，之后
每次失败等待 2、4、8…秒，上限 1 小时。等待中即使输入正确也不验证或授予成功；
重启保留失败数及截止时间。成功验证才清零。系统时钟/文件篡改可绕过这种本地 UI
限速，这是其安全边界，不是防有本地系统权限攻击者的认证。

设置只允许尚未启用时调用；更改要求旧码，关闭要求当前码，错误同样计入限速。
没有恢复后门、万能码、忘记码接口或无需当前码的 disable。忘记码后本阶段不提供
应用内重置：保留本机文件和外部备份，用户有文件访问权限时可在完全退出应用后
自行审阅修改 `settings.appLock=null`；这只是公开文件可读写的事实，不是加密恢复。
不要卸载/清空数据来尝试解锁。未来若提供便捷重置 UI，须如实说明这种保护边界。
普通 Android 用户可能无法直接读写应用专属文件，此时本阶段没有无损重置入口。
备份的独立加密口令丢失仍无法解密，应用锁码不能代替或找回它。

**便携备份始终只写 `appLock:null`**：不导出 hash/盐/失败数，避免扩散低熵数字码的
离线猜测材料，也避免跨设备意外锁住数据。覆盖恢复（包括空目标）始终保留目标原有
锁及限速；从不恢复外来锁。安全合并永不导入锁和失败计数。自动迁移备份、
pre-restore/pre-merge 本机安全副本保留原 state（可能含锁），不当成便携备份外传。

浏览器预览明确使用 **WebCrypto PBKDF2-SHA256 / 100000 次 / 随机 16 字节盐 /
32 字节结果**，标记为 `pbkdf2-sha256-preview`，只模拟合成数据的门禁契约，
不声称兼容原生 Argon2id 状态或真实 `.sgbak`。设置操作在同一 JS 上下文按存储键
排队，异步派生后重读内容并对凭据做 CAS；不承诺不同浏览器标签页之间具有原生
文件锁的事务保证。派生结果比较完整遍历 32 字节，JS 引擎不提供恒时保证。

## 核心和命令契约

| Rust Store | Tauri 命令 | TS ShiguangApi |
| --- | --- | --- |
| create_draft_with_fields / save_draft_patch | create_draft / save_draft | createDraft / saveDraft |
| set_draft_photo_caption | set_draft_photo_caption | setDraftPhotoCaption |
| set_draft_cover | set_draft_cover | setDraftCover |
| reorder_draft_photos | reorder_draft_photos | reorderDraftPhotos |
| settings / set_theme | get_settings / set_theme | getSettings / setTheme |
| set_app_lock / verify_app_lock | set_app_lock / verify_app_lock | setAppLock / verifyAppLock |
| change_app_lock / disable_app_lock | change_app_lock / disable_app_lock | changeAppLock / disableAppLock |

标量草稿补丁缺省表示不改，mood=null 表示清空（Tauri adapter 发送 clearMood），
location="" 表示清空地点；已有 create_draft/save_draft Rust 接口仍兼容。
get_settings 返回 `{theme,appLock:{enabled,failedAttempts,retryAfterMs}}`，修改设置和
锁操作返回 `{settings,durability}`，没有凭据。锁验证成功只报告此次验证，不能
代替宿主实现解锁会话、启动门禁或生命周期重锁。Tauri 设置/锁命令在 spawn_blocking
中执行；参数不派生 Debug，传入 Rust 的口令缓冲使用 Zeroizing，错误消息不回显。

## 测试和交付边界

每个拟提交边界跑 `cargo test --offline --locked --workspace`、同命令加
`--features fault-injection`、`npm test`、`npm run typecheck` 和 `npm run build`。
Node 24 另跑 `node --test --test-isolation=none tests/*.test.ts` 确认逐用例数。
既有测试仅更新新 schema 版本期望、未来版本拒绝样本、Snapshot 构造所需字段和
`unit06_merge` 中手工清空照片的夹具同时清空封面（满足获批 v4 引用规则）；
`unit07_query` 和 `unit08_stress` 的手工照片夹具补对应首张封面；
原数据保护/CAS/故障断言不删不弱化。提交说明必须注明这些获批行为变化。

历史夹具生成测试唯一 `#[ignore]`：只允许在 b882029 的 v3 核心显式运行，写入历史
夹具；当前 v4 会由版本断言拒绝。正常兼容性测试不忽略，直接校验冻结字节。
迁移与提交故障测试模拟替换前各写入阶段失败，不冒充真实设备断电测试。

本机 `.git` 只读，本轮按 RESUME 不尝试 stage/commit；前两次绿色检查点补丁和结果
已保留，最终工作树及建议提交拆分见 REPORT，不伪造提交哈希。
不合并、不推送、不跟踪 src-tauri/gen/。三端原生构建/真机、
应用锁屏幕及完整 M01/M06/M07 产品验收未执行的部分必须保持 NOT_RUN/未实现。

本机 Tauri Android `cargo check --offline --locked --manifest-path src-tauri/Cargo.toml
--target aarch64-linux-android` 因既有 `bit-set 0.11.1` 未缓存而 BLOCKED；
未联网取包、未降级依赖。命令适配的 TS 契约可测不等于原生壳已编译通过。
