# Unit-0.7 报告：M02 时光轴 + M03 日历 + 收藏 + G06 标签 · 0.1.7（versionCode 1007）+ Android 热修复

- 分支 / PR：`feat/unit-0.7-timeline-tags`（自 main `f6d4df3`）→ https://github.com/chaccine/shiguang/pull/6（**未合并**，由 Cine 决定）
- 规格：`evidence/unit-0.7/SPEC.md`（据 Drive 上的总契约 / 大纲 / M02 / M03 / M05 整理）；core 实现日志：`evidence/unit-0.7/01-core.log`（本地，`*.log` 被 .gitignore）
- 全部测试与截图只用合成数据；无 INTERNET 权限、无云、无 AI。范围限 M01–M07，未削弱 G01–G06。

## 热修复：Android 导出备份后“数据暂时无法打开”

**现象**（REDMI，0.1.5）：导出备份后出现“数据暂时无法打开 / state not managed for field `state` on command `store_status`…”，杀掉重开仍然如此。

**根因**：
1. 旧代码在 Tauri 的 `setup` 闭包里同步执行 `Store::open_exclusive` + `reconcile_media`（逐个哈希原图，数据越多越慢），完成后才 `app.manage(state)`。配置里的窗口在用户 `setup` 之前就已创建；Android 上 IPC 可能在非主线程被派发，前端的第一个 `store_status` 在 `manage` 之前到达 → Tauri 报 “state not managed”。导出后原图多/缓存多时更容易踩中，所以看起来像“导出后就打不开”。
2. 系统文件选择器（SAF）前后 Activity 可能被重建，同一进程里 `run()` 再次进入；第二次打开命中进程内写锁注册表，又一次失败、又一次没有 `manage`。重开（未完全杀进程时）会稳定复现。
3. 导出流程只读数据根、写到用户选的目标 URI，**不会改动用户数据**；报错只是状态未注册，数据本身完好（回归测试逐文件 sha256 验证）。

**修复**：
- `src-tauri/src/lib.rs`：进程级单例 `AppState(Arc<Shared>)`，在 builder 阶段 `.manage()`（早于 setup 与任何 IPC），因此 State **永远已注册**；Activity 重建再进入 `run()` 复用同一个 Shared。
- `core/src/session.rs` `OpenOnce<Store>`：`begin()` 仅第一次返回 true；store 在后台线程打开（`catch_unwind`，panic → `STORE_OPEN_PANIC`，不会让状态永远“打开中”）；命令统一走 `wait_lock()`（Condvar 等待，90 s 超时返回 `STORE_STARTING`）。
- `store_status` 改为 async + `spawn_blocking`，不阻塞 IPC 线程。
- 前端 `gateWithRetry`：对 `STORE_STARTING` 和历史版本的 “state not managed” 做有限重试，标题显示“拾光还在打开数据”。

**回归测试**（`core/tests/hotfix07_reopen.rs` 7 条 + `session.rs` 3 条 + `tests/startup.test.ts` 3 条，全部 PASS）：导出后重开、加密导出后重开、导出中断（BackupWrite / BackupFinalize 故障注入）、进程被杀留下陈旧 `.owner`、选择器取消、同进程第二次进入复用而非 STORE_LOCKED、启动期早到的命令等待而非失败。每条都校验数据根逐字节不变。验收脚本 U07 段也覆盖“导出 → 数据 sha 不变 → 立即重开”。

**真机状态：NOT_RUN**（REDMI 上未复测；需 Cine 安装本次 APK 后验证：导出备份 → 返回 → 杀进程重开）。

## 做了什么

| 部分 | 内容 | 谁做 |
|---|---|---|
| 规格 / 版本 | SPEC（schema v3、写操作与错误码、查询、备份/合并、CLI、测试）；0.1.7 / 1007（package、tauri.conf、src-tauri 与 workspace crates、两份 Cargo.lock） | 我 |
| core schema v3 | 记录加 `favorite/favoriteRevision/tagIds/tagRevision`；顶层 `tags/tagDictRevision/tagAliases/tagTombstones`；v1→v2→v3 链式迁移，迁移前备份原文件，故障注入下原文件不变 | Codex gpt-6.1-sol（high） |
| core 收藏 / 标签 | `set_favorite`（expectedRevision CAS → `META_REVISION_CONFLICT`）；`create/rename/merge/delete_tag`、`set_record_tags`、`tag_impact`、`list_tags`——每个都是一次 `transact`（候选 State → 严格往返校验 → 原子写），无孤儿标签；名称 NFC 式规范化 + trim 后校验（1–40 字符、无换行/控制字符），同名 → `TAG_NAME_CONFLICT`（带已有 tagId） | Codex |
| core 查询 | `timeline_page`（B02 排序：有时刻在前，再 createdAt、recordId；游标编码完整排序键，插入/删除游标记录后仍无重漏）、`timeline_months`、`calendar_month`、`day_entries`、`on_this_day`（2-29 只匹配闰日） | Codex |
| core 备份 / 合并 | 标签字典、别名、墓碑进 `.sgbak`；合并映射顺序：墓碑 → 跳过；别名 → 重映射；同 normName → 本地标签；否则新增（撞号改号）；收藏/标签关联取修订号大者，相等本地胜；重复合并幂等 | Codex |
| CLI | `favorite`、`tags`、`tag-create/rename/merge/delete/set`、`timeline`、`calendar`、`day`、`on-this-day`（merge/delete 需 `--yes`） | Codex |
| Tauri | 13 个新命令（`u07_cmd.rs`）；备份摘要加 tags/favorites，合并计划加 6 个标签/收藏计数；`TAG_NAME_CONFLICT` 透传 tagId；热修复（见上） | 我 |
| TS / MemoryAdapter | 同语义的时光轴/日历/标签/合并实现，schema 3 | 我 |
| UI | 时光轴（分组、无限加载、跳到年月、排序切换、只看收藏、标签多选“满足任一即可”）、日历页（月视图、当天时光、那年今日）、收藏星标、标签管理（新建/改名冲突→提示合并/合并/删除影响确认）、记录标签选择器 | CodeBuddy deepseek-v4.1-flash，我修整与验证 |
| 验收脚本 | `run_acceptance.sh` 新增 U07 段 | 我 |

## 本机测试（box，Linux x86_64，rustc 1.90.0）

| 项 | 结果 |
|---|---|
| `cargo test --locked` | **180 通过 / 0 失败**（Unit-0.6 为 153） |
| `cargo test --locked -p shiguang_core --features fault-injection` | **222 通过 / 0 失败**（含 unit07_faults：7 种元数据写 × TagTxnWrite/TempWrite/Replace，磁盘字节、内存状态、重开均一致；v1/v2 迁移 × 两个迁移故障点） |
| `cargo clippy --all-targets -D warnings`（含 fault-injection） | 通过 |
| `src-tauri` `cargo clippy --target aarch64-linux-android` | 通过（3 条既有 derivable_impls 警告，非本单元引入） |
| `npm test` | **120 通过**（新增 unit07 18 条、startup 3 条） |
| `npm run typecheck` / `npm run build` | 通过 |
| `scripts/run_acceptance.sh` | 通过；U07 段：分页 2+1 顺序 = [今天有时刻, 今天无时刻, 去年]、总数 3、末页无游标；收藏/标签筛选；陈旧 expect → META_REVISION_CONFLICT；“ 家人 ”重名被拒；日历 11-10 计数 2；那年今日 = 2025；导出前后数据根 sha 一致并立即重开；删除“旅行”后合并旧包：tagsSkippedDeleted=1，标签不复活；二次合并 added/updated/tagLinksUpdated=0 且无安全副本 |

新增 Rust 测试 37 条：unit07_backup 9、unit07_faults 3、unit07_meta 3、unit07_query 5（含 3000 行全量遍历、700 条同日）、unit07_schema 2、unit07_tags 3、unit07_cli 2、hotfix07_reopen 7、session 3。

**修改了 4 条既有断言**（`core/tests/unit04_schema.rs` 2 条、`unit04_faults.rs` 共享的 1 处断言影响 2 条）：原来写死“迁移后 schemaVersion == 2”，现在 v1 → v2 → v3 链式迁移到最新版本，改为期望 `CURRENT_SCHEMA_VERSION`（3）。v1 原文件逐字节备份、失败不改原文件、无残留临时文件等断言**都没改**；`migrate_v1_to_v2` 单步函数的测试也没改。改前的失败输出保存在 01-core.log。

## CI

见文末「CI 与安装包」。

## 截图（浏览器预览 + MemoryAdapter，合成数据；不是真机）

`evidence/unit-0.7/`：01-timeline-desktop、02-timeline-mobile、03-calendar-month、04-day-detail、05-on-this-day、06-favourites-filter、07-tag-manage、08-tag-rename-conflict、09-tag-merged、10-tag-filter、11-calendar-mobile；page errors 0。最能说明问题的两张：**04-day-detail**（日历圆点/条数 + 当天时光 + 那年今日）和 **01-timeline-desktop**（分组时光轴 + 收藏 + 标签筛选）。

## 规格与代码的冲突（按“保持 JSON、记录冲突”处理）

1. 规格提到 SQLite；实际存储是单个原子 `state.json`，继续用 JSON，查询在内存中做（3000 行全量遍历测试 < 1.1 s，debug）。
2. “那年今日”在大纲里属于 M04「今日重逢」，M03 §4 又把纪念日推后；本单元只做了日历页里的最小只读列表，没有提醒/推送。
3. Rust `TAG_NAME_CONFLICT` 原本不带 tagId → 给 `CoreError` 加了可选 `tag_id`，只在该错误上输出。
4. Rust create/rename/merge 返回 `Tag`，界面需要 `TagInfo`（含条数）→ Tauri 层用 `list_tags` 补齐。
5. `BackupCounts` / `MergeCounts` 新字段在 TS 里是可选的（旧包、旧断言兼容；为 0 时 MemoryAdapter 不输出）。
6. 草稿编辑器内编辑标签：未做（规格里有提到，本单元只在正式记录上编辑标签）。

## 其他发现

- 第二次合并同一旧包时 `tagsSkippedDeleted` 为 0（第一次为 1）：第一次跳过时会在 `mergeOrigins` 里记一条 `tag-skipped`，之后同一来源标签直接跳过、不再重复计数（`core/src/merge.rs` `remember_tag`），这是为了让重复合并的计数幂等；标签仍然不会复活（验收已断言）。
- 移动端顶部导航只显示当前页签（横向滚动条），沿用 Unit-0.2 的设计，未改。

## 结论

| 项 | 状态 |
|---|---|
| 时光轴分组 / 排序 / 游标分页无重漏 / 跳转 | PASS（core + TS 自动化测试、截图） |
| 日历月视图 / 当天条目 / 那年今日 | PASS（自动化测试、截图） |
| 收藏 CAS + 收藏筛选 | PASS |
| 标签事务、无孤儿、备份往返、合并防复活与幂等 | PASS（自动化 + 故障注入 + 验收） |
| schema v2→v3 迁移 + 故障注入 | PASS |
| 热修复（自动化回归） | PASS |
| 热修复真机（REDMI 导出 → 重开） | **NOT_RUN** |
| Tauri 新命令真机 / 桌面实际运行 | NOT_RUN（只在 box 上编译 Android 目标通过；box 无 webkit2gtk） |
| macOS / Windows 安装包实际安装 | NOT_RUN（CI 构建通过，未签名） |
