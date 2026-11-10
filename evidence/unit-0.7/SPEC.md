# Unit-0.7 时光轴 + 日历 + 珍藏 + 标签（M02 / M03 / G01 / G06 / M05-S04~S06）｜实现规格（Grok Bot 编写）

对齐 Drive：总纲 v2.6（SG-D-021/022/023/025/030/032）、模块 02 时光轴 v1.0（T01–T10、B01–B08）、模块 03 时光日历 v1.0（C01–C12、B01–B07）、模块 05 收藏与检索 v1.0（S04–S07、B01/B02、§4.1）、P0 数据契约 v1.0（G01-R、G02-R、G06-R）。
版本 0.1.7（Android versionCode 1007）。只用合成数据；离线、零 AI、无云、无 INTERNET 权限。既有测试断言不得修改（新增可选字段仅允许调整构造方式并说明）。

## 0. 规格与代码的取舍（已记录）
- 数据契约/总纲提到 SQLite 事务；代码仍是**单文件 state.json 原子替换**（write_atomic = 临时文件 → fsync → rename），本单元继续用 JSON：一次逻辑变更 = 一次候选 State 克隆 → 严格往返校验 → 原子替换；失败则内存与磁盘都保持旧版本。这就是 G06 要求的“同一逻辑变更里更新字典、关联和去重”的事务边界。
- 衍生视图（时光轴分组、日历计数、那年今日、标签计数）**不持久化**，每次从权威 State 现算（数千条内存计算足够），因此不存在陈旧索引（G06-R3 自动满足）。
- 「那年今日」：M03 §4 写“周年时刻可在 M04 讨论，不在 M03 首轮抢先实现”；M04 已确认“今日重逢”展区（SG-D-024）。本单元按 Cine 要求做一个**只读的轻量“那年今日”列表**（同月同日、往年、正式记录），作为 M04「今日重逢」的最小入口，不做展陈/推荐/屏蔽设置。
- 标签在草稿编辑器内编辑（契约中的“草稿标签意图补丁 baseTagRevision”）本单元**不做**：标签与珍藏只通过正式记录的独立元数据操作修改（G01：不发布草稿、不被草稿覆盖）。草稿提交 commit 只改内容字段，不触碰 favorite/tags（因此天然“合并当前最新珍藏/标签”）。

## 1. 数据模型 schema v3（CURRENT_SCHEMA_VERSION = 3）
记录行（RecordRow）新增（record 级元数据，独立于 formal/draft 快照）：
- `favorite: bool`（默认 false）
- `favoriteRevision: u32`（默认 0；每次珍藏状态实际改变 +1）
- `tagIds: [string]`（默认 []；去重、按字典中出现顺序或插入顺序保存，序列化稳定）
- `tagRevision: u32`（默认 0；该记录的标签关联每次实际改变 +1，包括被标签改名以外的合并/删除影响时）
State 顶层新增：
- `tags: [{tagId, name, normName, createdAt}]` —— 标签字典。`name` = 去首尾空白后的显示名（1–40 个字符，不能为空，不能含换行/控制字符）；`normName` = name 的英文小写化（Unicode 用 `to_lowercase` 即可）并把内部连续空白折叠为单个空格；**normName 全局唯一**（M05-B01）。`tagId` 本地 seq 分配：`tag-000001`。
- `tagDictRevision: u64` —— 字典每次变更 +1。
- `tagAliases: [{fromTagId, fromCreatedAt, toTagId, mergedAt}]` —— 合并留下的重定向（不含名称，最少个人信息）。用于合并导入时把旧备份里引用“已被合并的旧标签”的记录重映射到目标标签，不复活旧标签（G01-R4）。别名链需解析到终点（A→B、B→C ⇒ A→C），不得成环。
- `tagTombstones: [{tagId, createdAt, deletedAt}]` —— 删除标签的墓碑（不含名称）。用于合并导入时不复活已删标签（G02 同理）。
迁移 v2→v3（schema.rs MIGRATIONS 追加 `(2, migrate_v2_to_v3)`）：每行补 favorite=false/favoriteRevision=0/tagIds=[]/tagRevision=0；顶层补 tags=[]、tagDictRevision=0、tagAliases=[]、tagTombstones=[]；schemaVersion=3。沿用现有迁移流程（迁移前备份、MigrationBackup/MigrationWrite 故障点、失败原文件不变）。v1→v3 链式可用。v4 文件 → SCHEMA_TOO_NEW（不改原文件）。
严格校验（State::from_json，open/merge/restore 共用）：每条记录的 tagIds 必须都存在于 tags（**无悬空引用**）、记录内不重复；tagId 全局唯一；normName 全局唯一；normName 必须等于 name 的规范化；别名的 toTagId 必须存在于 tags 且 fromTagId 不在 tags 中；墓碑 tagId 不在 tags 中；favoriteRevision/tagRevision 为非负整数。违反 → STATE_CORRUPT。
冲突副本（ConflictCopy）只含内容快照，不含元数据（不变）。

## 2. 写操作（全部走现有 transact：写锁 + 候选 State + 原子替换；失败内存/磁盘均不变）
所有元数据写只允许作用于**正式记录**（formal 存在）；trashed → `RECORD_TRASHED`；纯草稿 → `RECORD_NOT_FORMAL`；不存在 → RECORD_NOT_FOUND / RECORD_DELETED（沿用）。**不触碰 draft、contentRevision、baseRevision、formal、updatedAt 以外的内容字段**（updatedAt 可不变；不要改 committedAt）。
- `set_favorite(record_id, favorite: bool, expected_favorite_revision: Option<u32>) -> MetaOutcome{record_id, favorite, favorite_revision, tag_ids, tag_revision, durability}`：expected 给定且 ≠ 当前 → `META_REVISION_CONFLICT`（“珍藏状态已在别处改变，请刷新后重试”）；值未变 → 不写盘、revision 不变，返回当前值。
- `set_record_tags(record_id, tag_ids: &[String], expected_tag_revision: Option<u32>) -> MetaOutcome`：CAS 同上；tag_ids 去重后每个必须存在 → 否则 `TAG_NOT_FOUND`；未变不写。
- `create_tag(name) -> Tag`：规范化后为空/超长/含控制字符 → `TAG_NAME_INVALID`；normName 已存在 → `TAG_NAME_CONFLICT`（附带已存在的 tagId，message 提示可直接使用已有标签）。
- `rename_tag(tag_id, new_name) -> Tag`：同名（同一 tag 仅大小写/空白变化）允许；与**其他**标签 normName 冲突 → `TAG_NAME_CONFLICT`（UI 提示“合并或取消”，**不默默覆盖**，M05-B01 / G06-R4）。改名不改 tagId、不改任何记录的 tagRevision（关联不变）。
- `merge_tags(from_tag_id, into_tag_id) -> TagMergeOutcome{into, affected_records, durability}`：from==into → `TAG_MERGE_SAME`；任一不存在 → TAG_NOT_FOUND。**同一次原子写**：所有含 from 的记录（含 trashed 记录与草稿所属记录，只要 tagIds 含 from）把 from 替换为 into 并去重、这些记录 tagRevision+1；字典删除 from；追加别名 {from, fromCreatedAt, into}；把指向 from 的旧别名改指 into；tagDictRevision+1。
- `delete_tag(tag_id) -> TagDeleteOutcome{affected_records, durability}`：**只解除关联，不删除任何记录/照片/文字**（S05/B02）；所有含该标签的记录移除它、tagRevision+1；字典删除；追加墓碑；指向它的别名一并移除（别名的终点没了就没有意义，同时把这些 fromTagId 也写入墓碑，防止旧备份经别名复活）；tagDictRevision+1。
- `list_tags() -> Vec<TagInfo{tag_id, name, created_at, active_count, trashed_count}>`：按 name 规范化排序；计数现算（active_count 只计 active+formal 记录）。
- `tag_impact(tag_id) -> {active, trashed}`（供 UI 确认“影响 N 条记录”）。
- purge_record：记录被永久删除时其 tagIds 随之消失；标签本身保留（可为 0 条）。restore_record/trash_record 不改元数据。
- commit：保持 favorite/favoriteRevision/tagIds/tagRevision 原值（G01-R3）。新记录首次提交元数据为默认值。
- resolve_conflict / restore_conflict_copy：不改元数据。
新故障点（fault.rs）：`TagTxnWrite`（标签合并/删除在候选 State 已改好、写盘前失败）——实现上可直接复用 persist 的 TempWrite/Replace 故障点也算，但必须有针对 merge_tags/delete_tag/rename_tag/set_favorite/set_record_tags 的故障测试：失败后 state.json 逐字节不变、Store 内存状态不变（再读一次返回旧值）、重开后旧值。

## 3. 只读查询（衍生视图，纯函数可单测；Store 方法包装）
统一排序 = M02 B02：主键 eventDate（desc 或 asc）；同日：**有时刻组在前、无时刻组在后**（两种方向都如此）；有时刻组内按 eventTime（与方向一致）；同时刻或无时刻组内按 createdAt（与方向一致），最终 recordId（与方向一致）。只包含 status=active 且 formal 存在的记录，读 formal 快照（T09：有未提交草稿时仍显示旧正式版）。
`TimelineFilter { from: Option<date>, to: Option<date>（闭区间，YYYY-MM-DD）, favorite_only: bool, tag_ids: Vec<String>（任一命中 = OR）, has_photo: Option<bool>, order: Desc|Asc }`；不同条件之间 AND（S07）。
- `timeline_page(filter, cursor: Option<String>, limit: usize(1..=500)) -> TimelinePage{items: Vec<TimelineItem>, next_cursor: Option<String>, total: usize}`：cursor 为不透明字符串（编码最后一项的完整排序键：eventDate|hasTime|eventTime|createdAt|recordId），翻页**不重不漏**；数据变化后用旧 cursor 继续也不会重复返回已过排序键的项。`TimelineItem{record_id, event_date, event_time, title, excerpt(正文前 80 个字符，去换行), cover: Option<PhotoUse>(第一张照片)，photo_count, favorite, favorite_revision, tag_ids, tag_revision, created_at, is_future(event_date > 今天本地日期)}`。
- `timeline_months(filter) -> Vec<{year, month, count}>`（有记录的年月，供“跳到年/月”导航；按方向排序）。
- `calendar_month(year, month, filter?) -> Vec<CalendarDay{date, count, photo_count, has_favorite}>`：只返回有记录的日子；计数为真实条数（C02）；跨年/远年/未来均可（B04）；非法年月 → INVALID_EVENT_DATE。
- `day_entries(date, order) -> Vec<TimelineItem>`：当天全部（不截断，B02），B02 排序。
- `on_this_day(month, day, today: date) -> Vec<{year, items}>`：往年（year < today.year）同月同日的正式记录，按年倒序；2 月 29 日只匹配闰年 2-29（不挪到 2-28，记入报告“闰日：只匹配 2-29”）。
「今天」由调用方传入（Tauri/CLI 用本地日期），core 不读时区（C08：按发生日期的日历日期投影，不做 UTC 转换）。

## 4. 备份 / 合并 / 防复活
- `.sgbak` 内的 state.json 直接是 v3 State（format 1 不变）；manifest 的 `schemaVersion` 写 3；`BackupCounts` 新增 `tags`、`favorites`（旧包缺省 0，向后兼容）。v2 旧备份：verify 通过、restore 时迁移到 v3、merge 时 incoming 先迁移。
- **merge_states（纯函数）扩展**：
  1. 标签字典映射：incoming 每个标签 T：
     a) 本地墓碑匹配 (tagId, createdAt) 相同 → **不复活**；incoming 记录中的 T 引用被丢弃；计 `tagsSkippedDeleted`。
     b) 本地别名匹配 (fromTagId, fromCreatedAt) → 映射到别名终点；计 `tagsRemapped`。
     c) 本地有同 normName 的标签 → 映射到本地标签（同名即同一标签，跨设备撞号也安全）；
     d) 本地有同 tagId 但 createdAt 或 normName 不同 → 视为不同标签，分配新本地 tagId（若同 normName 已在 c 处理）；
     e) 否则新增（保持 tagId，撞号则重编），计 `tagsAdded`。
     incoming 的 tagAliases / tagTombstones 与本地并集（墓碑：本地若仍有该 (tagId,createdAt) 的活跃标签 → 保留本地标签不删除，计 `tagsDeletedInBackup`，同 G02-R3）。
  2. 记录元数据（按记录身份匹配后）：
     - favorite：favoriteRevision 大者胜；相等但值不同 → 本地胜；
     - tagIds（先经第 1 步映射、去重、丢弃被跳过的）：tagRevision 大者胜；相等但集合不同 → 本地胜；
     - 元数据与内容独立判定：内容冲突副本规则不变（时间戳不参与胜负）。
     - 新导入记录：带映射后的元数据。
     - 防复活：被跳过的已删除记录不导入，其标签引用自然丢弃。
  3. 幂等：同一包合并两次，第二次 tags/favorite/tagIds 无变化，`MergeCounts` 新增字段全 0。
  4. 合并结果必须通过 §1 严格校验（无悬空 tagId、normName 唯一）。
  MergeCounts 新增：`tagsAdded, tagsRemapped, tagsSkippedDeleted, tagsDeletedInBackup, favoritesUpdated, tagLinksUpdated`。
- 覆盖恢复：整库替换（含标签/珍藏），沿用 0.5 流程。

## 5. CLI（cli/src/main.rs，JSON 输出，沿用现有风格）
`favorite <recordId> <on|off> [--expect <rev>]`、`tags`、`tag-create <name>`、`tag-rename <tagId> <name>`、`tag-merge <fromTagId> <intoTagId> --yes`、`tag-delete <tagId> --yes`、`tag-set <recordId> [tagId...] [--expect <rev>]`、`timeline [--from D] [--to D] [--favorites] [--tag ID]... [--asc] [--limit N] [--cursor C]`、`calendar <YYYY-MM>`、`day <YYYY-MM-DD>`、`on-this-day <MM-DD> [--today YYYY-MM-DD]`。

## 6. 测试（先写测试再实现）
core/tests/unit07_schema.rs、unit07_meta.rs、unit07_tags.rs、unit07_query.rs、unit07_backup.rs、unit07_faults.rs（#![cfg(feature = "fault-injection")]），cli/tests/unit07_cli.rs：
- 迁移 v2→v3 与 v1→v3；字段默认值；迁移故障注入原文件不变；v4 拒绝；严格校验（悬空 tagId、重复 normName、别名指向不存在、墓碑与活跃标签同 id）→ STATE_CORRUPT。
- G01：旧草稿存在时 set_favorite → 草稿不变、正式内容不变、contentRevision 不变；随后 commit 草稿 → 正文为草稿新版、favorite 保留最新值、tagIds 保留；CAS 冲突 → META_REVISION_CONFLICT 且无写盘；值未变不写盘。trashed/纯草稿拒绝。
- G06 标签：create 去空白/大小写同名冲突；rename 冲突提示且不覆盖；merge 去重（记录同时有 from 和 into）、affected 计数、别名、trashed 记录也被改；delete 只解除关联、记录与照片完好、墓碑；别名链解析；每个操作的故障注入：state.json 逐字节不变 + 内存不变 + 重开不变（无半套关联）。
- 查询：B02 排序全组合（有/无时刻、同时刻、asc/desc）；未来标记；草稿不出现/旧正式版显示；修改日期提交后从旧日期组移到新日期组且无重复；分页 3000 条合成记录 limit=50 全部翻完不重不漏且与一次性全量顺序一致、翻页间插入新记录不重复；favorite/tag OR/日期范围/hasPhoto AND 组合；calendar_month 计数（同日 3 条 =3）、草稿不计数、改日期后旧日 -1 新日 +1、空月份空列表、远年/未来；day_entries 全量；on_this_day 往年、排除今年与未来、闰日。
- 备份：v3 往返（标签、珍藏、别名、墓碑完整）；v2 旧包 restore → v3；merge：同名标签跨设备映射（不同 tagId 同名 → 本地 id）、同 tagId 不同名 → 重编、本地已删标签不复活（记录导入但无该标签）、本地已合并标签旧包 → 重映射到目标、favorite/tag revision 胜负、幂等二次合并 0 变化、合并后严格校验通过；被跳过的已删除记录不带入标签。
- CLI：上述子命令端到端（合成数据）。
完成判定：`cargo test --locked --offline`、`cargo test --locked --offline -p shiguang_core --features fault-injection`、`cargo clippy --locked --offline --all-targets -- -D warnings` 全绿。

## 7. Tauri / TS / UI（Grok Bot + CodeBuddy）
- Tauri 命令：`set_favorite`、`set_record_tags`、`list_tags`、`create_tag`、`rename_tag`、`merge_tags`、`delete_tag`、`tag_impact`、`timeline_page`、`timeline_months`、`calendar_month`、`day_entries`、`on_this_day`（today 用设备本地日期）。
- TS 类型 / ShiguangApi / MemoryAdapter 同语义（含 3000 条合成数据性能测试）。
- UI：「时光轴」页改为年/月/日分组 + 增量加载（IntersectionObserver / 滚动到底加载下一页）+ 只渲染已加载页 + “跳到年月”选择 + “回到最近” + 珍藏/标签筛选条 + 卡片珍藏星标快捷切换 + 未来时光标记 + 缩略图；新增「日历」页（7 列周一起始、点/数量、9+、上下月、年月选择、回到今天、点日期看当天列表、空日“这一天还没有留下时光”+“记录这一天”预填日期、那年今日列表）；「标签」管理（新建/改名/合并/删除，冲突提示合并或取消，影响条数确认）；记录卡片上编辑标签（选择已有/新建）。手机宽度下底部导航可滚动。
