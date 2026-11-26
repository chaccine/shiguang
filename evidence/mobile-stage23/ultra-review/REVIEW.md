# U011 首屏计时与 T4.2b 候选迁移审查

**优先处理候选迁移的回滚缺口。** 最后一次目录同步失败时，如果进程在补偿改名前退出，或补偿改名本身失败，下一位恢复者可以把未经确认的安装当作已提交，保留候选并解除写入封锁。该分支可以从源码确定，仅存在于单元测试编译的候选入口。生产 writer 仍为 outer 1 / schema 5。

**原始 313.050 ms 超时的原因仍为 INCONCLUSIVE，默认 npm 门禁仍为 BLOCKED。** 唯一一次后续带探针观测把大部分计时定位在 JSON 解析。本轮只读现有源码与证据，发现迁移问题后停止可选调查。同路径失败启动累计 **1/3**，本轮新增 **0**。审查基准为工作树 HEAD `a87573d04763f97f575a4fbd060df00696ad351e` 和未提交候选。页末列出两组哈希核对结果。

## M1 · CONFIRMED defect · 未确认的迁移可被恢复为已提交

| 同一步骤的两种历史 | 恢复者拿到的内容 | 按候选已有故障契约应有的结果 |
| --- | --- | --- |
| 安装已验证候选，clearing 已同步。改名为 synced 后，第六次目录同步失败，进程在补偿改名前退出，或补偿改名失败且 synced 仍可见 | synced、候选 state、正确的旧备份 | 回滚未提交安装，精确恢复旧字节。在结果无法判定时继续封锁普通写入 |
| 同样的改名完成，目录同步成功，随后在删除收据前被中断 | 同名收据、同一候选 state、同一旧备份 | 保留已确认候选 |

**实际行为。** 两条历史在进程重开时可以呈现完全相同的名称、内容及哈希。恢复先验证备份、比对 state 摘要并检查新版本对，再对 synced 分支同步目录、删除收据并返回成功。此刻的同步能确保持久化当前所见，但无法证明上一个进程在中断前已同步。第一条历史因而跳过原子恢复旧文件的分支。后果是旧 reader 拒绝 outer 2 的活动状态，尽管可验证的旧备份仍在。风险落在 G03 的恢复决策；没有观察到原图丢失或生产数据损坏。[改名、同步与补偿](/workspace/shiguang-app/core/src/migration.rs:150) · [恢复分支](/workspace/shiguang-app/core/src/migration.rs:195) · [未提交迁移的回滚契约](/workspace/shiguang-app/evidence/mobile-stage23/PLAN.md:26)

**可证伪的后续测试。** 在 v3、v5 的一次性合成副本上，分别在第六次目录同步报告失败后、补偿改名前模拟进程中断，并覆盖补偿改名返回错误且 synced 仍存在的情况。先断言普通 writer 被封锁，再由新持有者恢复。断言旧 state 的原字节和 SHA-256、备份原字节、每项原图的名称与摘要，并检查最终 fence。对照组在同一步同步成功后中断，应保留候选。现有测试在第六次同步失败后允许补偿改名顺利完成，然后断言恢复旧字节；另一测试只在已确认提交后中断。当前两条恢复路径读到相同证据时都会保留候选。本轮没有执行该故障测试。[第六次同步与旧字节断言](/workspace/shiguang-app/core/src/migration/tests/faults.rs:55) · [已确认收据对照](/workspace/shiguang-app/core/src/migration/tests/faults.rs:275) · [当前注入点](/workspace/shiguang-app/core/src/fault.rs:23)

**优先级。** 下一小步是补齐这对区分提交前后的测试，再让可持久证明的提交点与恢复判定一致。任何修订都须同时满足两组结果。仅依靠第二次打开时同步成功、再次比较两个摘要或无条件回滚 synced，均无法区分这两条历史。

### 已核对的迁移步骤

| 环节 | 源码与现有证据支持的行为 |
| --- | --- |
| 互斥与普通 writer | 候选 install/recover 先取实例锁，再取写锁，涵盖读源、校验、替换和收尾。普通 Store 的共享写锁入口取得锁后检查 pending、clearing、synced 三个名字；旧句柄的 persist 也经过这里。打开时还可能先由版本预检拒绝。旧字节仍可见时已有旧句柄被 fence 的用例。[候选取锁](/workspace/shiguang-app/core/src/migration.rs:229) · [Store 写锁](/workspace/shiguang-app/core/src/store.rs:1744) · [旧句柄](/workspace/shiguang-app/core/src/migration/tests/faults.rs:260) |
| 源版本与导入日志 | 安装先检查旧版本对；有导入日志则在同一锁内调用原恢复流程，再重读源和摘要。恢复迁移时若同时有导入意图，则拒绝。构造器与验证器在备份已验证且两把锁仍持有时运行。[安装顺序](/workspace/shiguang-app/core/src/migration.rs:231) · [相斥意图](/workspace/shiguang-app/core/src/migration.rs:188) · [两把锁的测试](/workspace/shiguang-app/core/src/migration/tests.rs:436) |
| 原字节与安装 | 复制锁内读取的原文件到按旧版本及 SHA-256 命名的位置，复核摘要，并同步备份文件、backups 目录、库根。校验重新解码的候选及其领域往返，再复核备份和活动源。先持久发布 pending，再同目录临时写、文件同步、原子替换、目录同步并复核新摘要。测试比较原位 formal/draft、回收站、冲突副本与有序照片，并核对命名原图。[备份与发布](/workspace/shiguang-app/core/src/migration.rs:242) · [原子替换](/workspace/shiguang-app/core/src/persist.rs:82) · [候选往返](/workspace/shiguang-app/core/src/migration/tests.rs:127) |
| 日志与普通回滚 | 日志限制为普通文件、至多 1024 字节、恰好三个字段，两摘要须合法且不同，备份名须匹配版本及旧摘要。恢复验证旧备份可按旧规则解码；多个阶段名、坏备份或第三种 state 均阻断。pending/clearing 遇旧字节则保留，遇候选则用原备份原子还原，复核旧摘要、同步文件与目录再收尾。M1 位于随后判断提交结果的收据分支。[日志与备份验证](/workspace/shiguang-app/core/src/migration.rs:105) · [恢复](/workspace/shiguang-app/core/src/migration.rs:183) |

## M2 · POSSIBLE hotspot or residual risk · 首份备份复制中断会阻塞重试

备份复制以 `create_new` 直接打开最终的摘要文件名。若中断留下半份文件，此时尚无 pending，活动 state 仍是原件。下次 install 发现目标已存在，会保留它并在摘要不符时拒绝；无迁移记录的 recover 直接返回。这里的残余风险是迁移需要人工处置，拒绝覆盖可疑备份本身符合数据保护要求。现有测试预置了错误或截断的备份，证实会拒绝且保留原件。要确定实际中断的影响，可在一次性副本上让首次复制在写入部分字节后中止，再连续执行恢复与安装，比较活动 state、备份及原图；若最终文件从未暴露部分字节，该中断路径的风险即排除。[直接创建最终文件](/workspace/shiguang-app/core/src/backup.rs:1009) · [重试入口](/workspace/shiguang-app/core/src/migration.rs:247) · [预置截断文件用例](/workspace/shiguang-app/core/src/migration/tests.rs:391)

## U011 的 150 ms 究竟量了什么

| 顺序 | 是否计入 homeSummary adapter | 代码路径 |
| --- | --- | --- |
| 建立 5,000 条合成行、加照片与标志，组装 outer 1/schema 5，序列化后写入 Map 一次 | 否 | `tests/unit011-museum.test.ts:422–428`，`tests/support/museum.ts:18–40,46–65` |
| 构造 MemoryAdapter | 否 | 该 fixture 未设 deferOpen。构造器立即读取同一键、解析、迁移至内存 v5 并完成全库校验，再赋给 this.state；fixture 随后注入固定 today，记录初始字串与写入计数。见 `src/platform/memory-adapter.ts:98–114` |
| 先算纯领域 expected | 否，独立计时且要求 <150 ms | 针对原始 rows 和固定日期扫描一次，产生七项计数；不读取存储。见 `tests/unit011-museum.test.ts:445–446`，`src/domain/museum.ts:97–107` |
| 新取时间戳，调用并 await adapter.homeSummary | **是，严格 <150 ms** | 默认日期求值 → 启动/一次性错误检查 → Map.getItem → JSON.parse → 版本、迁移、行、墓碑、冲突、快照、照片、资产、标签及设置校验 → 领域日期检查和计数 → Promise 恢复后取终点。读的是整个存储字串。见 `tests/unit011-museum.test.ts:439,447`，`src/platform/memory-adapter.ts:124–196,882–883` |
| 记录舍入后的数字、核对相等性和两个预算；后续查询 | 否 | 断言使用未舍入的用时。其余七对查询、两个照片续页时钟、最终摘要及字串/写次数断言均在后面。200 ms 例外只属于 reunionPage adapter。见 `tests/unit011-museum.test.ts:448–464` |

原始日志在第一个 adapter 预算断言结束该用例；此前两种摘要相等且 domain 预算已通过。**786.313605 ms** 是到失败为止的整个 U011 用例，**313.050 ms** 是其中的 adapter 时钟。缺少原次调用的阶段、CPU、GC 和线程等待数据；候选变更前后的相关 JS 源码相同也不足以归因。独立默认结果为 **284 通过、1 失败**。[原始 npm 日志](/workspace/shiguang-app/evidence/mobile-stage23/migration-safety-independent/npm.log.gz) · [独立门禁记录](/workspace/shiguang-app/evidence/mobile-stage23/MIGRATION_SAFETY_BLOCKED.md)

**与首屏的对应。** 博物馆首页确实调用 museumHomeSummary。UI 为六项查询共享一个 today 并用 Promise.all 等待结果，然后绘制卡片；MemoryAdapter 的读取和解析在各次调用中同步执行。普通浏览器预览使用 localStorage、deferOpen 和启动时的 storeStatus 重载；原生 Tauri 走 IPC。时光轴先取标签和 timelinePage，再更新月份。U011 量到预览适配器的一项真实查询；从启动到绘制、其余五项、时光轴及原生耗时都没有包含在这 313.050 ms 中。[首页](/workspace/shiguang-app/src/ui/museum.ts:178) · [浏览器适配器选择](/workspace/shiguang-app/src/ui/main.ts:184) · [打开检查](/workspace/shiguang-app/src/ui/main.ts:431) · [时光轴](/workspace/shiguang-app/src/ui/main.ts:1058) · [原生入口](/workspace/shiguang-app/src/platform/tauri-adapter.ts:96)

## H1 · POSSIBLE hotspot or residual risk · 相同输入的第二次解析

后续默认并发的带探针观测中，fixture 为 6,847,994 UTF-8 字节。构造阶段在计时外解析一次（32.793 ms）；首个摘要在计时内再次读取、解析并校验相同内容。该 adapter 时钟为 **132.048 ms**，主线程 CPU **123.539 ms**、可运行等待 **4.390 ms**。其中 JSON 解析占 **112.267 ms**（约 85%），主线程系统态 CPU **90.454 ms**；行与冲突头、快照/照片/资产、标签/设置三段分别约 10.633、5.560、2.195 ms，领域日期检查和计数循环约 1.153 ms。此时钟没有相交的已记录 GC 条目。系统态时间的具体来源及原次 313.050 ms 的分解均未知。全库重复工作已由源码和这次轨迹定位；可安全省去多少，以及在实际首页有多少次命中，仍需验证。[阶段数据](/workspace/shiguang-app/evidence/mobile-stage23/home-summary-investigation/measurements.json) · [观测局限](/workspace/shiguang-app/evidence/mobile-stage23/home-summary-investigation/REPORT.md) · [启动计数](/workspace/shiguang-app/evidence/mobile-stage23/home-summary-investigation/ledger.json)

**待 Cine 确认的最小优化。** 仅考虑单个适配器第一次 museumHomeSummary。成功打开并完成现有全量校验时，可短暂保留该次的非空原始字串及对应的只读快照。摘要仍在原时钟内按原顺序处理日期默认值、故障检查，并从同一 storage/key 读取一次。只有当前字串与打开时的字串逐字符完全相同、快照仍对应同一次校验且未被修改，才用该快照重新计算当日七项计数。字串变化时，对本次刚读到的值走完整解析/迁移/校验；即使长度、seq 或修改时间相同也如此。每条分支都消费并释放这次复用资格。应用预览的对应打开点是成功的 storeStatus；若只在 eager 构造器保留快照，实际 deferOpen 预览未必受益。

- **所有权与失效。** 限单实例、单键、只读、一次使用。不能把可供写操作修改的对象从重载公共入口借出。任何本地写尝试（含失败）、重置、导入/合并/覆盖、状态替换、打开失败都废弃此前资格。跨实例或外部替换靠每次权威读取及全文相等判定；正确性不依赖通知送达。无存储或缺键按现有 `copy(this.state)` 语义处理，读取抛错仍报 IO_ERROR，不能拿上次快照顶替。查询不得改变 this.state 对冲突处理的既有含义。[读取与持久化](/workspace/shiguang-app/src/platform/memory-adapter.ts:129) · [本地冲突快照](/workspace/shiguang-app/src/platform/memory-adapter.ts:539)
- **错误与 G01–G06 边界。** 保留启动错误、failNext 的一次性语义、SCHEMA_TOO_NEW、STATE_CORRUPT 及 INVALID_EVENT_DATE 的先后。今日日期逐次求值，七项计数逐次派生；hiddenCount 在 active/formal 筛选前统计。保留正式/草稿/冲突隔离、删除与防复活、导入后新状态、照片使用位/原图/封面、日期与派生视图、标签及墓碑校验。摘要不读媒体载荷、不写存储、备份、索引或摘要。保留本地存储读取期间既有的一致性边界。[错误顺序](/workspace/shiguang-app/src/platform/memory-adapter.ts:882) · [计数规则](/workspace/shiguang-app/src/domain/museum.ts:97) · [现有投影断言](/workspace/shiguang-app/tests/unit011-museum.test.ts:348)
- **验证与反证。** 用可计数的合成存储证明命中仍 getItem；冷启动、eager、deferOpen、无存储/缺键均与原路径对照。覆盖共享键的两个实例、等长不同值、外部损坏或新版本、getItem 抛错、失败写、恢复/合并、草稿到正式、隐藏/回收/永久删除、照片/标签变化、跨本地午夜/闰日及显式非法日期和错误优先级。比较七项输出、错误码、存储原字节及写次数；不同输入必须走全量校验。另验其余查询与旧状态行为。性能验证保留原 U011 和默认并发，并区分预览实际打开路径。若全文比较、保留大字符串/对象带来的堆压力或低命中率抵消收益，应舍弃该优化。一次低于阈值的样本无法证明原事件已修复。

## A1 · REJECTED or out-of-scope suggestion that would weaken default acceptance

将 homeSummary 或其他 adapter 调到 200 ms、把读取/解析/校验挪出时钟、以 domain 或整用例耗时代替 adapter 时钟、默认串行/隔离/绑核、重试挑绿、仅靠上次计数通过用例，都会改变验收对象或样本选择。保留第 447 行的原始时钟和第 450–453 行的严格断言。[预算定义](/workspace/shiguang-app/tests/unit011-museum.test.ts:447)

## 交付结论与完整性

- **(a)** 原始超时原因 **INCONCLUSIVE**；默认门禁 **BLOCKED**。
- **(b)** **1 项 CONFIRMED defect**（M1，候选恢复决定）；**2 项 POSSIBLE**（M2，半份首备份的重试处置；H1，重复解析的优化空间）。A1 汇总拒绝的验收变更。
- **(c)** 先验证并修正 M1 的提交判定。H1 的逐字相等、一次性只读复用方案待 Cine 确认，收益未经测量。
- **(d) NOT_RUN** · 本轮未启动 npm/cargo、单测、性能观测或 profiler，未运行 M1/M2 故障序列或 H1 优化实验；未运行候选 v6 包读取、校验、覆盖恢复、两次合并、再导出、使用位身份碰撞、编辑器/T5、浏览器/原生/设备或物理掉电验证。未实施修复或激活 schema 6。

审查开始与结束均从仓库工作树逐文件读取原字节，对照两个指定清单的长度及 SHA-256。候选 **9/9**、oracle **10/10** 两次均匹配，差异 **0**。清单本身的 SHA-256 分别为 `dc0388e2f9f28d4815f7db0871e97321a4d41d70073193fb06b96ed426ab135e` 和 `b2cc77569732c2b817de4b6bb7597e823adac5cc80f4b68d58cb8ac9fedc6151`。本轮仅在指定审查目录写入两份交付物。[候选清单](/workspace/sg-stage23/home-summary/CANDIDATE_PREIMAGE.json) · [oracle 清单](/workspace/shiguang-app/evidence/mobile-stage23/perf-investigation/ORACLE_PREIMAGE.json)
