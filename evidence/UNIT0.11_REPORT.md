# Unit-0.11 报告草稿：M04 回忆博物馆 · 0.1.11

- 分支 `unit-0.11`；基线 main `362d305`（0.1.10）。Task A 已提交的数据层见 [SPEC](unit-0.11/SPEC.md)。
  本报告补 Task B：四区 UI、展陈主题、照片查看、返回上下文、推荐偏好及验证。
- 依据 `/workspace/specs/m04.md` + `m04_audit.md` 定稿、G01–G06、M06/M07/outline，
  及 Unit-0.7 查询设计、Unit-0.8 压测、Unit-0.10 SPEC/设计系统/报告。
- 版本保持 Task A 的 **0.1.11**，本次未再改版本、schema、TS 领域模型、MemoryAdapter、Tauri adapter 或 Rust core。
  四者沿 Task A 同一契约；新 UI 直接调用现有接口。只用合成数据，无网络/云/AI 功能、外部资源或权限变更。
- `.git` 只读：本代理未 stage/commit/push。工作期间编排侧写入检查点 `bfe5d77`、`8389564`、`7b4ceac`；
  不把这些提交归为本代理执行。未读取或改动 `src-tauri/gen/` 内容，既有未跟踪目录不纳入交付。
- CI: GitHub Actions run 43291167304（PR #9，60d4a71）**7/7 success**（三端 core+cli+ts、三端 tauri bundle、Android APK）；CI 产物未下载、未安装。
- Screenshots: **PASS**：编排侧于 2026-11-13 03:3x（UTC+8）在沙箱外用最终脚本重跑，36 张合成截图全部保存，page errors 0（`evidence/unit-0.11/*.png`、`screenshots-result.json`）。仅抽看部分画面，未做设计验收。

## PASS

### 本地自动验证

2026-11-13，Rust 1.90.0（`export PATH=$HOME/.cargo/bin:$PATH`）、Node v24.22.1，
Rust 同时设置 `CARGO_NET_OFFLINE=true`；仅用缓存，不取包。最新完整前端回归含最后一项错误/锁屏边界测试。

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `cargo test --locked --workspace` | **231 passed / 0 failed / 1 ignored** | `/tmp/unit011-b-cargo.log` |
| `cargo test --locked -p shiguang_core --features fault-injection` | **280 passed / 0 failed / 1 ignored** | `/tmp/unit011-b-fault-injection.log` |
| `npm test` | **23 个文件 passed / 0 failed** | `/tmp/unit011-b-npm.log` |
| `node --test --test-isolation=none tests/*.test.ts` | **204 项 passed / 0 failed / 0 skipped** | `/tmp/unit011-b-npm-cases.log` |
| `npm run typecheck` | **PASS** | `/tmp/unit011-b-typecheck.log` |
| `npm run build` | **PASS** | `/tmp/unit011-b-build.log` |
| `node --check scripts/screenshots-u11.mjs` | **PASS，仅语法** | `/tmp/unit011-b-syntax.log` |
| `git diff --check` | **PASS** | 本地检查 |

两套 Rust 计数包含重叠的正常核心测试，不能相加。唯一 ignored 为历史 v3 夹具生成器；冻结兼容性测试实际执行。
npm 的文件与逐项计数是同一套测试的两种运行模式，不能相加。完整日志留在 /tmp，机器摘要见
[task-b-verification.json](unit-0.11/task-b-verification.json)。

### 实现结论

| 范围 | 已实现与证据 |
| --- | --- |
| F01 / F11 四区与空态 | 手机博物馆 tab / 桌面回忆博物馆进入同一首页；四区真实数量、预览和入口；新用户、纯草稿、无珍藏、无照片、无同日命中均有温和文案与有效记录入口。无 F07 入口。 |
| F02 今日重逢 | 首页预览与查看全部；按「X 年前的今天」稳定分组，增量续页；继续消费 Task A 的往年精确月日 / 闰日规则，不读创建日。 |
| F03 珍藏展柜 | 复用单一 favorite 正式元数据；发生日期正/倒序与分页，文字故事平等展示。重新进入/阅读返回重新查询当前投影。 |
| F04 照片展墙 | 每个 PhotoUse 独立 tile；真实 `photoThumbUrl` 缩略路径、固定比例、lazy；保留 HEIC 明确占位与其它预览失败文案。查看器保留说明、正式记录上下文与进入完整故事。 |
| F05 年度展室 | 实际年份/记录/照片数量、12 个月文字数值与条形分布；年份列表增量加载；年室有精选及全部记录。未来时光准确标注。 |
| F06 / F09 阅读与返回 | recordId 打开既有只读正式阅读，不发布修改草稿；返回保留展区、排序、已加载页及主区域/window 滚动位置。实际 main.ts 启动事件集成测试覆盖展柜 → 阅读 → 同位置返回。 |
| F08 / F10 推荐偏好 | 再看一段优先未出现记录；隐藏推荐不删除源故事，并提供撤销；我的隐私页复用全部重置。写失败不报成功；不确定落盘如实提示。 |
| M06 主题 / 无障碍 | [设计说明](unit-0.11/DESIGN_SYSTEM.md)：衬纸、展框、铭牌、胡桃木与静态聚光；新 token 两主题独立；色彩扫描和 AA 对比度计算通过。原生 modal、按键、焦点返回、alt、层级、最小触控 CSS、减少动态效果均有结构/事件约束。 |
| ＋记录 | 可见 + 图标加「记录」，恰好一个 +；aria-label 保留「＋记录」。真实导航构建回归通过。 |
| F12 / G01–G06 | UI 不创建展览副本或媒体副本，只消费当前正式投影及偏好写接口；Task A 的持久化/迁移/备份契约完整回归通过，本次无数据层改动。 |

### 新增验证与原测试调整

`tests/unit011-museum-ui.test.ts` 13 项：四区、空态、分页唯一性、年份续页、照片键盘/边界续页、
HEIC/alt、正式版隔离、隐藏/撤销/重置、再看一段、嵌套返回/位置/焦点、查询失败保留原墙与手动重试、
锁屏 inert 时不打开照片查看器、5000 条渲染预算。`unit010-lock-ui` 增加真实 PersonalUi 重置成功/失败测试；
`unit010-accessibility` 增加新材质/聚光合成的 AA 对比度计算。

按本任务批准的行为变更更新既有断言：
`unit010-ui`、`unit010-accessibility` 的“建设中”断言改为正式博物馆 region/内容宿主且无假入口；
`unit010-boot` 的占位返回按钮改为真实展区路径，并加强单加号、正式阅读返回断言。
未删除安全、数据、故障断言，未降低既有阈值；无领域/adapter/Rust 测试改写。

### 5000 条首页预算

MemoryAdapter 真实重读 5000 条合成正式记录，每条 1 个共享合成照片引用，约三分之一珍藏。
最后完整逐项回归：**220.6ms**，预算 **<1000ms**；首屏 **7 次**缩略请求、最多 5 张故事卡。
测量调用实际 MuseumUi 构建事件 DOM，包含 adapter JSON 读取/查询；不含布局、图片解码、绘制或 IPC。
Node 没有图片解码器/缺失合成 asset 时走受测的占位路径，不能称为 5000 张相机原图性能或实际设备流畅度。
常规记录/照片首批 24 项、续批 24 项；年份首批/续批 24 间；IntersectionObserver 与手动按钮共用分页。

## NOT_RUN

- 本代理未启动 Chrome/浏览器；新截图脚本仅 `node --check`。`screenshots:u11` 已加入 package.json。
  脚本固定 **2026-11-12 / Asia/Shanghai**，通过真实预览 API 创建多年份、往年同日、珍藏、
  纯文、无标题、未来、带说明照片和未提交草稿，预期 **36 张**：390×844 / 1280×960 × light/dark × 9 场景。
  场景为首页、重逢、珍藏、照片墙、查看器、年份列表、年室、空馆、单加号导航。
  每张打印绝对路径；矩阵缺失、解码/页面/HTTP/外部请求或语义检查失败均非零退出。
- 工作期间工作区出现外部生成的 36 张 PNG 和 `screenshots-result.json`（清单记 PASS / errors=[]）。
  本代理只读取文件，抽看手机夜间首页/照片墙、桌面浅色首页/夜间年室四张；这不是本代理执行结果或完整视觉验收。
  发现长页中固定导航穿条及桌面 `.main` 截断后，已补采集专用展开样式，导航/查看器保持真实视口；
  编排侧已删除旧 PNG 并用最终脚本重跑：36 张，page errors 0（见顶部 Screenshots）。
- 原生 Tauri IPC、Android/macOS/Windows 安装升级、真实媒体/HEIC、跨时区设备、低空间/断电、
  实际屏幕阅读器、原生 modal Tab 行为、200% 系统字号/触控矩形、中文 IME、系统安全区：NOT_RUN。
- 真实照片墙内存/解码、实际设备响应时间和 5000 张大原图：NOT_RUN。Node 事件夹具不冒充浏览器或设备验收。

## BLOCKED

- 浏览器运行受本任务明确限制，本代理未尝试启动；截图采集和真实布局验证交编排侧。
- 必跑的 Rust/npm/typecheck/build 无环境阻塞；使用现有 Rust 1.90 与 node_modules 完成全部绿色套件。
  未运行额外 Tauri 壳编译，未把历史缺包/GTK 问题声称为本次复现。

## DEFERRED

- F07 手工主题展：按定稿为第二阶段，无入口或假按钮。
- M05 搜索、M08、云/AI/网络、公众分享、正式签名：本任务范围外，未实施。
- 既有 M01 blocks/双模式、存储清理、系统最近任务截图隐私等历史延期未在本单元扩展。
- 本次未完成像素定稿或三端设备验收；不能把结构/事件测试称为完整 WCAG 或 M04 产品验收通过。

## 需要 Cine 决定

- 无阻塞实现问题。请结合编排侧最终截图确认展框/铭牌密度、手机长页和灯下微光是否符合偏好。
- 安排三端设备与读屏/大字号验收；确定真实大媒体与旧设备性能矩阵。
- Task A 的“重置后导入含 true 的旧备份可能重新隐藏”规则仍有效，本次不改变其合并语义。

## 提交建议（仅编排侧执行）

Task B 检查点已由编排侧保存，以下为逻辑拆分，不要求重写既有历史：

1. `feat(u011): museum UI and accessible exhibition design` —
   `src/ui/museum.ts`、`src/ui/museum.css`、`src/ui/main.ts`、`src/ui/index.html`、`src/ui/tokens.css`、`scripts/copy-ui.mjs`。
2. `test(u011): museum navigation, media and performance regressions` —
   `tests/support/museum-dom.ts`、`tests/unit011-museum-ui.test.ts`、`tests/unit010-boot.test.ts`、
   `tests/unit010-lock-ui.test.ts`、`tests/unit010-accessibility.test.ts`、`tests/unit010-ui.test.ts`。
   提交说明记录上述两类批准的占位/导航断言更新；G01–G06 不变。
3. `test(u011): prepare fixed-clock museum screenshot matrix` — `scripts/screenshots-u11.mjs`、`package.json`。
4. `docs(u011): record Task B verification and design limits` — `evidence/UNIT0.11_REPORT.md`、
   `evidence/unit-0.11/DESIGN_SYSTEM.md`、`evidence/unit-0.11/task-b-verification.json`、`evidence/unit-0.11/SPEC.md`。
   最终 PNG 与 `screenshots-result.json` 由编排侧在实际重跑后独立收录，不纳入本代理 PASS 声明。
