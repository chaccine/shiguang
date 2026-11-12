# Unit-0.11 Task A · M04 数据层 · 0.1.11

分支 `unit-0.11`，起点 main `362d305`（0.1.10）。本轮续接已提交的
`ddc9b72`（Rust 投影、持久化、版本）与 `5389f31`（TS、两 adapter、重置入口），
补充 TS 回归、规格和 README 中遗漏的当前版本/备份 schema 说明；不修改既有测试断言。
本轮没有提交；`.git` 只读，由编排侧提交。

依据 `/workspace/specs/m04.md`、`m04_audit.md` 定稿（SG-D-024），G01–G06、
M06/M07/总纲，以及 Unit-0.7 查询、Unit-0.8 压测和 Unit-0.10 schema/设计系统。
本任务完成数据查询与接口；F01/F06、B04/B08 的展馆 UI、返回位置、媒体失败呈现和设备体验仍待后续工作。
F07 手工主题展为第二阶段，本次无入口或假按钮；未增加 M05 搜索、M08、云端或 AI。

## 数据来源与日期规则

- 正式来源统一为 `status=active && formal != null`。所有投影读当前 `formal`，不读
  `draft` 或冲突快照；编辑草稿存在时仍展示旧正式内容。提交后即时重新派生，回收站/永久删除不参与。
- 展览是按 `recordId` 引用的临时投影；摘要/照片说明仅作响应数据，不另存故事、原图或展览成员列表。
  阅读继续按记录 ID 读取正式版。无标题保留空值，照片墙使用 `title=null`；无图不补默认图片。
- `eventDate` 是 `YYYY-MM-DD` 纯日历日期；可选 `eventTime` 不补零点。
  “今天”由调用端按设备当前本地时区生成（TS `localToday()` 的本地年月日；原生调用/CLI 沿用既有本地日期规则），
  core 只接受注入日期，不从 UTC 时间戳推算。跨时区不转换发生日期，系统时间戳仅用于稳定排序/审计。
  所有含 today 的 API 可注入，测试固定 `2026-11-12` 并覆盖跨年/闰日。
- **那年今日范围冲突的处理：以 M04-F02/B01 定稿为准，只匹配往年精确月日，不增加 ±N 天“相近日期”窗口。**
  M03 保持轻量只读列表，不扩展为展陈；Rust `query::on_this_day` 与 M04 `reunion_page`
  共用 `museum::reunion_rows`，TS `onThisDay` 与 `museumReunionPage` 共用 `timeline.reunionRows`。
  两个入口对相同月日/today 的候选 ID 及顺序有一致性测试，包含隐藏偏好。

## Schema v5 与 F10 暂时不看

`version=1` 容器不变，`schemaVersion=5`。在 `RecordRow` 新增严格布尔
`museumHidden: boolean`（Rust `museum_hidden`），新行默认 false。它属于记录元数据，
不进入 `formal`/`draft`/冲突内容快照，也不增加或改变正文、珍藏、标签修订和审计时间。
`set_museum_hidden` 只允许活动正式记录；草稿、回收站、永久删除记录分别拒绝。
提交旧编辑草稿保留最新隐藏/珍藏/标签值（G01）。

F10/B07 的明确取舍：**隐藏只减少自动推荐，不影响用户主动浏览。**

| 视图 | 隐藏记录 | 未来日期记录 |
| --- | --- | --- |
| 今日重逢 / M03 那年今日 | 排除 | 排除；也排除今年 |
| 再看一段 | 排除 | 排除 |
| 年度精选 | 排除 | 排除 |
| 珍藏展柜 | 若仍珍藏则保留 | 保留并标 `isFuture` |
| 照片展墙 | 保留 | 保留并标 `isFuture` |
| 年份统计 / 年室全部记录 | 保留 | 保留，卡片标 `isFuture` |
| 时间轴 / 月历 / 当天列表 | 保留 | 沿用既有未来标注 |

“恢复所有暂时不看”调用 `reset_museum_hidden`，清除所有仍存在行的标记，包含回收站；
只改变偏好，不改变删除状态，不创建已永久删除的记录。设置中已有重置入口；博物馆内逐条隐藏 UI 待后续。
`hiddenCount` 包含回收站，以便重置入口报告完整数量。无变化操作不写权威状态。

迁移链 v1→v2→v3→v4→v5 保留：v4→v5 仅给每行补 false，保留正文、发生日期、
说明、照片顺序、封面、地点/心情、未提交草稿、冲突副本、回收站、删除标记及已有元数据。
v3 先按 Unit-0.10 规则补快照字段和设置，再补隐藏标记。原生开库迁移先保存旧文件原始字节到
`backups/state.schema-v{from}.*.json`，严格验证候选后原子替换；重开不重复迁移。
迁移备份/替换故障保留可读旧库，较新 schema 在写入前拒绝。v5 缺失或非布尔标记按损坏拒绝。
MemoryAdapter 使用相同字段和迁移结果，在内存迁移，下一次实际写入才保存 v5；其预览不模拟原生迁移备份文件。

## 备份、恢复、合并（G02–G06）

- `.sgbak` 明文 format 1、加密 SGBAKENC v1 不变；新 manifest/state schema 均为 5。
  隐藏偏好随完整状态导出与覆盖恢复；正式/草稿隔离、照片使用位及原件引用保持。
  原生测试覆盖 v5 明文/加密往返、重新封装且校验有效的 v4 包恢复/合并，以及冻结 v3 兼容路径。
  MemoryAdapter 的带口令包只是已有预览模拟，不是原生加密算法验证。
- 旧包先验证 manifest 与 state 版本一致和完整性，再迁移，v4/v3 隐藏默认 false。
  旧版应用不能读取 v5；不允许手改 schema 绕过兼容检查。
- **合并隐藏规则为并集（逻辑 OR）**：在稳定记录身份与删除账本判定之后，对同一记录合并
  `local.museumHidden || incoming.museumHidden`，不看时间戳，不影响正文胜负或其他元数据修订。
  新导入记录携带其标记；撞号但身份不同的记录改号后各保留偏好，不给本机同号记录误加隐藏。
  返回计数 `museumHiddenUpdated`，重复合并不再产生语义变化。
- 此最小方案无独立偏好修订/解除墓碑：**重置后再导入包含 true 的旧包可能重新隐藏记录**，
  可再次重置。覆盖恢复则明确恢复备份中的偏好值。此取舍保守地避免旧 false 静默取消用户的屏蔽。
- 隐藏合并不能复活内容：本机回收站保持回收站，永久删除账本命中则跳过记录与偏好；
  无本机/备份删除历史的新设备仍不能推断旧包之后的删除，沿用 G02 能力边界。
- 原生操作沿用候选状态校验、受保护持久化、恢复点及回滚。临时文件写/替换故障和锁降级路径
  有原生故障测试；MemoryAdapter 有注入写失败后原数据/重开数据不变的测试。
  不把合成故障注入称为真实断电或真实设备安全验收。

## 展区查询契约

共同排序复用 M02：发生日期按方向；同日有时刻组永远优先，再按时刻、`createdAt`、
`recordId` 按该方向排序。常规页限 1–500；响应包含 `total`、`nextCursor`。
游标保存最后条目的完整排序键，采用严格“在它之后”判定，固定数据集不重不漏、删除边界项仍可续翻。
每次查询读取当前权威数据，不保存分页快照；修改排序字段后应刷新列表。

| 区域 | 规则与返回值 |
| --- | --- |
| F02 今日重逢 | 正式、未隐藏、发生年月日的年份小于 today.year 且月日等于 today；创建日期无关。2-29 只在 2-29 匹配，不挪至 2-28 或 3-1，2100 非闰年。按年倒序且年内复用 M02 顺序，组含 `year/yearsAgo/label="X 年前的今天"`。首页最多 6 条，`total` 是全部候选数；同一游标分页供“查看全部”，跨页年组可以延续。无命中返回空组。 |
| F03 珍藏展柜 | 仅当前 `favorite=true` 的正式记录，desc 默认、可 asc；纯文字与照片同等。不另建收藏状态，取消珍藏下次查询立即消失。隐藏/未来记录仍可主动浏览。 |
| F04 照片展墙 | 每个正式 `photos[photoIndex]` 一个 tile；按记录 M02 顺序，再按记录内照片位置正序，封面不改变顺序。带 `recordId/title-or-null/eventDate/eventTime/isFuture/photoIndex/photoUseId/assetId/caption/thumbnailKey`。相同原图多次使用是不同 tile，说明独立。缩略键沿用 `{assetId}.thumb-v2.png`（位于 previews/），查询不读、复制或解码媒体。照片游标含方向、完整记录排序键及照片下标，拒绝跨方向或损坏游标。 |
| F05 年度展室 | 只列实际有正式记录的年份，倒序；每年真实 `recordCount/photoCount` 和按一月至十二月的 12 个记录计数。年室全部记录可分页/切方向。精选最多 6 条，在该年非隐藏、非未来正式记录中优先珍藏、其次有照片、最后其他，各组再按 M02 desc；确定且不随房间排序变化。空年 `summary=null`、空页和空精选，无假回顾。 |
| F08 再看一段 | 池为未隐藏且 `eventDate<=today` 的正式记录。先按 recordId 正序规范化，再以 UI 传入 uint32 seed 执行 xorshift32（13/17/5）+ Fisher–Yates；seed=0 用 `0x6d2b79f5`。洗牌后按未在 previousIds 中/已出现稳定分区，优先选未出现项，池不足才补最少重复。每次 1–50 条，同次无重复；返回 `eligibleTotal`。Rust/TS 共享 seed 0/1/42/uint32-max 的预期序列。 |
| F01/F11 首页摘要 | 单次扫描返回 `recordCount/reunionCount/favoriteCount/photoCount/yearCount/eligibleCount/hiddenCount`。照片数按使用位，年份按实际正式发生年份；隐藏计数范围见上。无排序、正文复制或媒体 I/O，供 UI 决定空态。空库全部为 0，单条不复制凑数。 |

## 接口与性能

Rust `Store`、Tauri 命令、TS `ShiguangApi`、MemoryAdapter 与 Tauri adapter 同步：
`museum_reunion_preview/page`、`museum_favorites_page`、`museum_photos_page`、`museum_years`、
`museum_year_room`、`museum_reshuffle`、`museum_home_summary`、`set_museum_hidden`、`reset_museum_hidden`。
TS 使用对应 camelCase；两 adapter 的日期、方向缺省和显式参数有测试。

沿用 Unit-0.7：所有派生视图每次从权威记录现算，不落盘索引或随机状态，无索引失效窗口（G06）。
记录筛选/计数为扫描；排序查询约 O(n log n)，照片页另扫描使用位，年份统计不排序全部正文；
无两两记录比较或逐条文件访问。原生 summary 只读已加载 State，MemoryAdapter 包含预览 JSON 重新读取/验证成本。

Rust 压测复用 `unit08_stress` 的 `unit07_support::synthetic_rows`：5000 正式记录、
5000 使用位共享 32 张本地生成的小 PNG；本轮 state.json 为 6,593,002 字节。
不代表 5000 张相机原图、UI 图片解码/布局、开库或端到端 IPC 延迟。
每项 debug 查询断言 <150 ms；测试还核对查询前后内存/磁盘状态一致、previews 未生成。

2026-11-13 沙箱，Rust 1.90.0，`core/tests/unit011_stress.rs` debug / release 单次测量（毫秒）：

| 查询 | Rust debug | Rust release（信息性） |
| --- | ---: | ---: |
| homeSummary | 2.642 | 0.285 |
| reunionPreview | 1.642 | 0.156 |
| reunionPage | 1.719 | 0.133 |
| favoritesFirst | 1.419 | 0.272 |
| photosFirst | 7.222 | 1.197 |
| photosNext | 7.166 | 1.119 |
| years | 2.159 | 0.130 |
| yearRoomFirst | 1.898 | 0.194 |
| reshuffle | 0.613 | 0.090 |

TS 使用相同发生日期/时刻/ID/正文分布，5000 使用位共享一个合成 asset 描述，不解码图片。
`tests/unit011-museum.test.ts` 测试纯函数与包含 JSON 重读的 MemoryAdapter，逐项断言 <150 ms；
首次单独运行纯函数约 1.1–4.0 ms、adapter 首页约 17.7–30.0 ms，照片续页约 22–23 ms。
耗时是信息性采样，150 ms 是宽松回归门限，不作设备性能承诺。

复现（所有依赖使用缓存，无网络；输出写 /tmp）：

```sh
export PATH=$HOME/.cargo/bin:$PATH
export CARGO_NET_OFFLINE=true
SHIGUANG_MUSEUM_STRESS_OUT=/tmp/unit011-rust-stress.json cargo test --locked -p shiguang_core --test unit011_stress -- --nocapture
SHIGUANG_MUSEUM_STRESS_OUT=/tmp/unit011-rust-stress-release.json cargo test --locked --release -p shiguang_core --test unit011_stress -- --nocapture
node --test --test-isolation=none tests/unit011-museum.test.ts
```

## 验证边界

新增 TS 文件包含 19 项测试，复用既有 `tests/support/museum.ts`；本次未修改产品查询代码，
M03 共享实现已在前序提交中完成。未削弱或改写 G01–G06 / 既有断言。
2026-11-13 本地完整回归，Rust 1.90.0、Node v24.22.1、npm 11.21.1；
先设置 `PATH=$HOME/.cargo/bin:$PATH` 和 `CARGO_NET_OFFLINE=true`，仅使用缓存依赖：

| 命令 | 实际结果 | 本轮日志 |
| --- | --- | --- |
| `cargo test --locked --workspace` | PASS：231 passed / 0 failed / 1 ignored | `/tmp/unit011-cargo.log` |
| `cargo test --locked -p shiguang_core --features fault-injection` | PASS：280 passed / 0 failed / 1 ignored | `/tmp/unit011-fault-injection.log` |
| `npm test` | PASS：22 个文件 / 0 failed | `/tmp/unit011-npm.log` |
| `node --test --test-isolation=none tests/*.test.ts` | PASS：189 项 / 0 failed / 0 skipped（含新增 19 项） | `/tmp/unit011-npm-cases.log` |
| `npm run typecheck` | PASS | `/tmp/unit011-typecheck.log` |
| `npm run build` | PASS | `/tmp/unit011-build.log` |
| Rust museum stress，debug / release | 各 1 passed；所有采样 <150 ms | `/tmp/unit011-rust-stress.log`、`/tmp/unit011-rust-stress-release.log` |
| `git diff --check` | PASS | 本地检查 |

Rust 两套计数各包含正常 core 用例，不能相加；stress 已含在 workspace/fault-injection 中，
单独采样不再加入总数。npm 的文件计数与 189 项逐项计数也是同一套测试的不同运行模式。
唯一 ignored 是历史 v3 夹具生成器（仅能在未修改的 v3 core 显式运行）；
冻结历史夹具的兼容性用例实际执行。日志留 /tmp，规格中的计数和耗时为本轮实测。

NOT_RUN：浏览器/截图（沙箱禁止运行 Chrome，交编排侧）、原生 Tauri IPC 实机调用、
Android/macOS/Windows 安装升级、跨端文件提供器、读屏及实际布局、大尺寸媒体和真实断电。
NOT_DONE：四区展馆 UI、照片查看与故事返回定位、逐条隐藏交互及展馆空态；F07 为第二阶段范围外。
本 Task A 不宣称 M04 整体产品验收通过。

Cine 待决问题：Task A 无阻塞问题；上述 F10 范围、旧包可能重新隐藏及 exact month-day
规则已按本任务授权落实并记录。下一阶段需要按 M06 细化展区 UI 并由编排侧进行浏览器/设备验收。

## Task B · 四区 UI 与验证补充

已以 `src/ui/museum.ts` + `museum.css` 替换建设中：四区预览/入口、同日年组、
珍藏日期双向分页、PhotoUse 展墙/查看器/正式故事、年度分布/精选/全部记录。
分页首批/续批各 24；年份列表也增量加载。阅读和嵌套返回重新查询，保留排序、加载量与双滚动偏移；
照片使用真实缩略 API、lazy 与固定衬框，说明为纯文本，HEIC 失败保持占位。
F10 只在自动推荐处提供隐藏，带撤销；我的隐私页重置复用 Task A，主动浏览仍包含隐藏记录。
再看一段使用既有 seed/previousIds 契约；不复制故事、媒体或创建另一套展览成员状态。

两主题新 token 与对比度、焦点/按键、错误回退及 5000 条首页渲染预算见
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) 与 [UNIT0.11_REPORT](../UNIT0.11_REPORT.md)。
本次没有版本或数据层变更，不改变 G01–G06。F07 无入口；M05/M08 无新增。
截图脚本只做语法检查，报告保留编排侧 CI/截图 pending；Node DOM 测试不代表真实布局、解码或读屏通过。
