# Android阶段0 / 阶段1交付记录

更新：2026-11-25T21:05:48.165406+08:00（Asia/Shanghai）。PR11： https://github.com/chaccine/shiguang/pull/11 。**Stacked base为未合并PR10/unit-0.12的77a0637；不是直接基于main。PR10保持未合并且未改状态。** 本轮仍为0.1.12开发代码，没有交付新安装包。

## PASS

- 阶段0复现基线cargo241/fault291/npm254，typecheck/build通过。启动锁修复0fa4e6a独立回归241/291/268通过，CI45614570495为7/7。
- 阶段1代码8f86b47：浅色纸纹哑金、深色灯下织物展馆；时光轴内容前置，现有年月/排序/珍藏/标签收进筛选面板，独立可撤销条件片。统一五导航标签和轮廓图标、阅读/编辑/搜索返回上下文。照片保留原始色彩，无深色全图滤镜；空库不注入合成内容。此项为实现与自动测试，不冒称人工视觉验收。
- 启动状态分离：初始中性不透明封面；确认关闭锁后直入，启用后才显示口令表单，错误/取消/慢响应/过期结果不越过锁。保留既有4–8位数字规则及前导零，不改成固定6位；原Argon2id、60秒重锁、备份锁规则/schema v5/G01–G06不变。
- 最终独立全回归：Rust1.90.0 cargo241/fault291（各1个既有历史fixture生成器ignored）、npm285，typecheck/build/diff-check全部exit0。原始日志`/workspace/sg-visual-01/visual/`；[机器记录](mobile-stage01/VISUAL_VERIFICATION.json)。
- 自动覆盖面板/单项条件移除/分页/阅读编辑返回/空库/安全启动，材质色阶对比度与原图字节一致性。Android系统栏主题事件与现有原生insets对接已实现，未声明硬件效果通过。
- 实际loopback服务8条场景URL与关键构建资产HTTP200且字节一致，仅静态服务证据，不是浏览器布局PASS。预览`http://127.0.0.1:1420/?stage01=timeline&theme=light`；[验收清单](mobile-stage01/BROWSER_CHECKLIST.md)。

## NOT_RUN

- 实际360×800/390×844手机viewport、200%真实重排、触控/焦点/读屏、Android IME/原生Back/系统栏/首帧，以及本轮真实UI截图：待parent computerUse或真机验收，不把宽屏截图、Node DOM或CI当手机通过。
- 原生升级历史数据与照片保留：现有0.1.12反馈仅能证明浅深启动；没有读取用户私图、库或日志，未为等待此反馈中断可逆开发。
- 最终代码CI：run 45619961661 当前in_progress / conclusion=；将记录真实完成状态，不沿用启动块绿灯冒充最终head。

## BLOCKED

- 代码实现及本地回归无已知阻塞。真实浏览器操作必须由parent派computerUse；没有自行使用Shell驱动浏览器/CDP/Playwright或生成伪运行截图。

## DEFERRED / 风险

- macOS/Windows专项适配、桌面截图及专项验收暂缓，已有支持未删除。编辑器/照片结构、清理、主题展、最近任务遮挡（阶段4）未扩项。
- 原生系统栏初始随Android配置，随后按应用解析主题更新；首次原生帧、旧系统导航模式与IME必须真机确认，不能由源代码或CI推断。
- 合成预览仅显式stage01查询启用，RAM独立设备，绝不读取生产存储或用样稿咖啡/海景伪造记录。无新收费、公开部署、AI/云同步；固定debug签名配置及schema未改。现有CI自动构建与产物不等于手机验收，本轮未手动生成或分发安装包。

详细：[启动](mobile-stage01/STARTUP.md) · [视觉实现](mobile-stage01/VISUAL.md) · [真实浏览器证据目录](mobile-stage01/manual/README.md)
