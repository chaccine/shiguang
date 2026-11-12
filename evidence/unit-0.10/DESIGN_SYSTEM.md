# Task C · 暖纸本 / 灯下展馆

输入：M06 V02/V03/V12/V14、B02/B04/B06 与 AC04；M01 v1.3 的正式/草稿、
说明及原图规则；M07 的本机设置和锁屏边界；G01–G06。当前任务授权优先于规格的
历史“尚未授权编码”段落。读取的 outline.md 实际为 v2.6（包含 v2.5 历史及新执行制度）。

## 设计意图

主视觉仍是 A 暖纸本私人展馆。浅色延续纸白、陶木色、柔和边界和适度留白。
夜间是它在灯下的另一种布置：暖墨底、胡桃木层次、琥珀操作色、展框内线及微光。
没有将历史 B 夜色画廊改为主风格，也没有对整页做反色。

- 纸纹用两层极低透明度 repeating-linear-gradient，灯光用局部 radial-gradient。
  无图片/字体下载、SVG 噪声滤镜、混合模式或大型位图，纹理不会动画。
- 夜间卡片使用内高光、内边线和低强度暖光；日间保留轻阴影。输入底与展框区分。
  夜间标题字重 600，正文 450，字距稍放宽，阅读行高 2；日间为 650/400/1.9。
  正文使用系统无衬线；阅读及占位标题可用设备已有宋体族，无外部字体。
- 时光轴增加线与节点；夜间节点带微光。日历有独立的今天边框及“今”、选中下划线、
  真实计数与珍藏图标；不单靠颜色识别状态。
- 手机导航为五入口；日间纸色，夜间木质灯沿。对话框、提示条、错误框、输入、按钮、
  焦点和应用锁均消费同一组语义 token。照片始终原色，不添加滤镜、透明度或遮罩。
- 博物馆仅有“建设中”占位：日间拱形空框，夜间改为直边展墙、偏移展框与小台灯。
  装饰全部 aria-hidden，不代表已有记录、展览或推荐功能。

## 候选色值表（M06 §不作为精确定值）

以下十六进制值为本次实现和自动测试使用的**候选**，不是冻结品牌标准；视觉/设备校准
可继续修订，并须同步重跑对比度。唯一代码来源为 src/ui/tokens.css；组件禁止直接写色值。

| Token | 暖纸本候选 | 灯下展馆候选 | 用途 |
| --- | --- | --- | --- |
| surface-canvas | #F7F0E7 | #211C18 | 页面底 |
| surface-raised | #FFFAF4 | #2D251F | 展框/卡片/弹窗 |
| surface-inset | #EEE2D3 | #251F1A | 次层、照片边衬 |
| surface-input | #FFFCF8 | #352B23 | 输入区域 |
| surface-hover | #F0E3D3 | #403327 | 悬停 |
| surface-nav | #EEE0CF | #282019 | 导航基础色 |
| surface-accent | #F1E2CC | #433321 | 选择、标签、封面状态 |
| text-primary | #3C332D | #F2E5D2 | 正文/标题 |
| text-secondary | #5F4E41 | #D1BFA5 | 说明 |
| text-muted | #685544 | #CBB99F | 日期、次级信息（仍须 AA） |
| text-placeholder | #76614F | #C5AE90 | 输入占位 |
| primary / primary-hover | #805132 / #694027 | #E5B87D / #F1CB98 | 操作/链接 |
| on-primary | #FFFAF4 | #2B1E10 | 主按钮文字 |
| accent | #A47548 | #D4A66D | 灯沿、装饰、今天边框 |
| border-subtle | #D9C8B3 | #554436 | 装饰分隔（不承担唯一状态） |
| border-control | #91755A | #9D8164 | 控件边界 |
| border-frame | #BFA68A | #A47D50 | 展框 |
| success / surface-success | #45623D / #EDF3E7 | #BED2AD / #293225 | 成功文字/底 |
| warning / surface-warning | #79501D / #FFF0D5 | #EDCB91 / #3C2D1C | 注意文字/底 |
| error / surface-error | #963D2D / #FBEAE3 | #F2B4A1 / #422923 | 错误文字/底 |
| danger-fill / danger-hover | #A5432E / #873321 | #E7A28A / #F0B9A6 | 破坏性按钮 |
| on-danger | #FFFAF4 | #321C14 | 破坏性按钮文字 |
| focus / focus-inner | #745027 / #FFFAF4 | #F1C68C / #211C18 | 焦点外线及隔离环 |
| media-control / hover | #47382E / #2E241D | #38271B / #4C3522 | 图片移除按钮的不透明底 |
| on-media | #FFFAF4 | #FFF0DB | 图片上按钮文字 |
| timeline-line / dot | #C4AC8E / #896341 | #796044 / #DEB67F | 时间线及节点 |
| selection | #E3C9A3 | #705233 | 文本选区 |
| backdrop | #34291F80 | #130E0BD9 | 弹窗背景遮挡 |

| 材质 token | 日间 | 夜间 |
| --- | --- | --- |
| texture | #89634103 横/纵细纹 | #EBBD8204 / #EBBD8203 横/纵细纹 |
| canvas-wash | #FFFAF4 → #F7F0E7 → #EFE3D4 | #382A1B → #211C18 |
| nav-wash | #F0E4D5 → #E9DAC6 | #30251B → #251E19 |
| warm-wash | #FFF6E6 → #F4E6CD | #3A2C1C → #2D251F |
| lamp-wash | #E7C99B18 → 透明 | #E8B36D14 → 透明 |
| exhibit-wash | #F3E7D6 → #FFFAF4 | #3B2E21 → #251F1A |
| elevation-card / small / hover | 低透明暖木阴影 | 内高光、内框、轻暖光 |
| elevation-action / dialog / nav | 操作、弹窗与导航的暖影 | 内高光及低强度暖光 |
| focus-halo / exhibit-glow | 陶木晕边/纸白内框 | 琥珀晕边/深木内框 |

| 几何/排版 token | 当前候选 |
| --- | --- |
| space-1/2/3/4/5/6/8/10 | .25/.5/.75/1/1.25/1.5/2/2.5 rem |
| radius-sm/md/lg/xl/pill | .5/.75/1/1.25 rem / 999px |
| touch-min / touch-comfort | 44px / 48px；日历至少 44px，其它常规控件至少 48px 高 |
| focus-width / focus-offset | 3px / 3px |
| duration | 160ms；减少动态效果时禁用动画、过渡及平滑滚动 |
| 字号 | 全部 rem；根节点为用户默认字体的 100% / 115% / 130% |
| weight-heading / body | 日间 650/400，夜间 600/450 |
| tracking-heading / body | 日间 .065em/0，夜间 .09em/.018em |
| reading-leading | 日间 1.9，夜间 2 |

## 主题与字号生命周期

light/dark/system 继续使用 Task A 的 TS / MemoryAdapter / Tauri / Rust Settings 契约，
本次不改 schema v4、备份格式或任何核心数据语义。覆盖恢复成功后立即刷新权威设置；
合并仍保留目标偏好。字号沿 Task B 的本机 shiguang.fontScale，不进入便携备份。

head 中同步脚本在样式表和模块前读取经过白名单校验的 shiguang.theme 与字号缓存，
设置实际主题和百分比字号，避免通常重启时先画浅色。这里只缓存主题/字号，不缓存内容、
锁状态或口令；真正设置读取失败不会因此解锁。缓存不可读/损坏时先按系统绘制，后台
权威设置返回后纠正；缓存被清除时无法同步预知原生偏好，不宣称这一异常路径零变化。

系统配色 change 仅改变实际主题，不把 system 写成 light/dark。显式偏好忽略系统变化。
选择成功后更新缓存、预览“已选择 ✓”及可访问状态；写入失败保持原主题和选择，显示错误。
主题预览为命名按钮 + aria-pressed 分组，同时保留原生模式选择框。

## 可访问性与测试边界

- 自动读取实际 CSS token，用 sRGB 相对亮度计算 AA：正文/次级/状态/按钮文字至少 4.5:1，
  控件边界和焦点至少 3:1；同时计算渐变端点、纸纹叠加及最强灯光叠加。装饰边框、画中
  笔划不冒充交互边界。图片按钮用不透明底，不依赖任意照片本身的对比度。
- 所有控件有 :focus-visible；不去掉原生焦点。跳到内容、命名输入、原生模态 dialog 的
  标题/说明、主导航 aria-current、日历完整年月日/计数/今天/珍藏及 aria-pressed 均有检查。
  主导航含页面与新建动作，使用 nav + 原生按钮，移除原来无 tablist 的孤立 role=tab。
- 图片导入由命名按钮触发隐藏 file input，键盘可达；照片封面/心情/未来时光/错误都有
  文本或符号。应用锁遮挡时主界面 inert，Tab/Shift+Tab 在锁表单循环，解锁恢复先前焦点。
- 可变布局、换行、内部滚动及 rem 留白为 200% 字体准备；窄屏月历允许单独横向滚动，
  不压缩日期触控目标。触控单测验证 CSS 几何约束，**不是浏览器测得的矩形尺寸**。
- tests/unit010-appearance.test.ts 执行首屏脚本、实际外观 controller 与两个 adapter 契约；
  tests/unit010-accessibility.test.ts 计算对比度、检查 token/结构/触控约束。
  已有真实 bootstrap / lock UI 事件测试增加当前页、日期和焦点循环断言。
- npm run test:a11y:u010 提供浏览器后续矩阵：320px/1280px、两主题、100%/200%、
  页面/弹窗/锁屏、实际控件矩形、键盘、减少动态效果及合成截图。只从本地 dist 拦截资源，
  不需监听端口。**本沙箱 Chrome 启动受系统调用权限阻断；完整脚本 NOT_RUN，截图 BLOCKED。**
- 原生 Android/macOS/Windows、系统实际字号/软键盘、安全区、读屏软件、弱光视觉评审及
  人工 200% 检查均 NOT_RUN。自动计算达标不等于整个应用已取得 WCAG 认证或设备验收。

M04 只有建设中；M05/M08、网络/云/AI 均无新增实现。Task B 已记录的完整故事块编辑、
照片替换/撤销、R03 三分支及系统最近任务截图保护仍未实现。
