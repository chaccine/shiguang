# Unit-0.2 桌面版能跑起来 + 草稿体验｜验收报告

> 2026-11-09（Asia/Shanghai）· 分支 `feat/unit-0.2-desktop-ux`（基线 `main@451d9d3`）· PR https://github.com/chaccine/shiguang/pull/2（未合并，由 Cine 决定）
> 只用合成数据。正式基准 rustc 1.90.0（box 用户级 rustup + GitHub Actions）。

## 提交
| 提交 | 内容 | 执行者 |
|---|---|---|
| b7cea8e | core：list_drafts / attach_photo_bytes / remove_draft_photo / discard_draft / base64；Tauri 新命令与 `{row, durability}` 返回、`withGlobalTauri`；TS：ShiguangApi、MemoryAdapter、describeError、DraftSession 自动保存状态机、recoverLastDraft；新测试 | Codex `gpt-6.1-sol` high（Team，workspace-write 沙箱） |
| a25e33f | CI：Tauri 打包未签名安装包并上传 artifacts；`@tauri-apps/cli` devDependency | Grok Bot |
| 713bf5b | UI：草稿列表 → 编辑（自动保存状态、照片缩略图）→ 存入时光 → 时光列表；浏览器预览模式、`?demo=1` / `?fail=conflict` / `?fail=uncertain` | CodeBuddy `deepseek-v4.1-flash`（`-p`，`--permission-mode acceptEdits`，工具限 Read/Edit/Write/Glob/Grep，无 -y） |
| 23cac3f | 预览服务器 + playwright-core 截图脚本 + 截图；"添加照片"中文按钮 | Grok Bot |
| 7ab76a9 / ca31d64 / 0cff1b0 | CI 修复：MSI 用 zh-CN WiX 本地化（中文产品名代码页 1252 报 LGHT0311）；打包重试 + 工具缓存；Windows 暂只出 MSI | Grok Bot |

## 验证结果
| 项 | 结果 |
|---|---|
| `cargo test --locked`（box，1.90.0） | PASS 52（core 单元 15 / 验收 13 / 安全 14 / unit02 10） |
| `cargo test --locked -p shiguang_core --features fault-injection` | PASS 61（+ Unit-0.1 故障 7、Unit-0.2 故障 2） |
| `cargo build --locked -p shiguang` | PASS |
| `npm test` | PASS 59/59（新增 draft-session 23、memory-adapter 14、errors 6） |
| `npm run typecheck` / `npm run build` | PASS / PASS |
| `bash scripts/run_acceptance.sh` | PASS（evidence 校验 58 项，校验未放宽） |
| 浏览器预览截图（MemoryAdapter，headless Chrome） | PASS，6 张，页面报错 0 |
| Tauri 本机构建（box） | BLOCKED（缺 webkit2gtk/pkg-config，未用 sudo） |
| CI 三平台 | 见下表 |
| 桌面窗口在真机启动（REDMI G Pro / MacBook / Windows 电脑） | NOT_RUN |
| 真实文件选择对话框、关窗前 flush（桌面 webview 内） | NOT_RUN（只在浏览器预览中验证） |
| Android | NOT_RUN |

## CI
Run（PR，提交 0cff1b0）：https://github.com/chaccine/shiguang/actions/runs/42582040358 —— 6/6 job 成功。

| Job | 结果 | 说明 |
|---|---|---|
| core+cli+ts (ubuntu-latest) | PASS | cargo 52 + 故障模式 61；npm 59/59；typecheck |
| core+cli+ts (macos-latest) | PASS | cargo 51 + 60（Linux 专属 durable 单测不适用）；npm 59/59 |
| core+cli+ts (windows-latest) | PASS | cargo 51 + 60；npm 59/59 |
| tauri bundle (ubuntu-latest) | PASS | artifact `shiguang-Linux-unsigned`（.deb） |
| tauri bundle (macos-latest) | PASS | artifact `shiguang-macOS-unsigned`（`dmg/拾光_0.1.0_aarch64.dmg`，Apple Silicon） |
| tauri bundle (windows-latest) | PASS | artifact `shiguang-Windows-unsigned`（`msi/拾光_0.1.0_x64_zh-CN.msi`，约 2.9MB，已下载核对） |

日志 artifact：`tauri-log-Windows` / `tauri-log-macOS` / `tauri-log-Linux`。产物保留 14 天（至 2026-11-23）。
之前失败的 run：42576620609（MSI 代码页 LGHT0311）、42578259285 / 42578231975 / 42579327927 / 42579321075（NSIS 工具下载 504）。

下载 Windows 安装包：
```bash
gh run download 42582040358 -R chaccine/shiguang -n shiguang-Windows-unsigned
```
或打开上面的 run 页面，在 Artifacts 里点 `shiguang-Windows-unsigned`（需登录 GitHub，下载为 zip）。CI "编译 + 打包成功" 不等于应用已在该平台启动验收。

安装包均**未签名**：Windows 会出现 SmartScreen "未知发布者"，macOS 需右键"打开"或在"隐私与安全性"里放行。

## 截图（evidence/unit-0.2/）
- `01-drafts.png` 草稿列表（合成示例）
- `02-editor-autosaved.png` 编辑草稿 + 两张合成照片 + "已自动保存"
- `03-restart-recovered.png` 重新加载后"已为你恢复上次没写完的草稿"
- `04-timeline.png` 存入时光后的时光列表
- `05-conflict.png` 注入 REVISION_CONFLICT：中文提示、本地草稿保留、未覆盖
- `06-durability-uncertain.png` 注入 durability uncertain："已写入，但系统未确认落盘"

复现：`npm run screenshots`（工程内 playwright-core，使用本机 `/usr/bin/google-chrome`，可用 `CHROME_PATH` 覆盖）；手动看：`npm run preview` → http://127.0.0.1:1420/?demo=1

## 语义要点
- 自动保存：防抖 800ms；同时最多一个保存在途，在途期间的输入在完成后再存最新值；失败进入 error 并保留全部输入，可"重试"；全空白新草稿不落盘。
- 恢复：启动时优先打开上次打开的草稿（localStorage `shiguang.lastDraft`），否则最近更新的草稿。
- 存入：先 flush，再前端校验，再 `commitRecord(id, baseRevision)`；REVISION_CONFLICT → conflict 状态，不自动重试、不按时间裁决。
- Unit-0.1 的原子写、STATE_CORRUPT、ASSET 校验、REVISION_CONFLICT 语义未改；原有测试断言未改。

## 已知限制 / 后续
- NSIS .exe：BLOCKED（Tauri 打包器下载 `nsis_tauri_utils.dll` v0.5.3 时 GitHub Releases 持续返回 504，box 上 curl 复现），暂只出 MSI；恢复后把 `BUNDLES` 改回 `msi,nsis` 即可。
- 冲突副本的选择界面、多进程写锁、G02 墓碑、孤立原图清理、schemaVersion 迁移：未实现（沿用 Unit-0.1 清单）。
- 照片 caption 编辑界面未做（字段已存在，默认空）。
- 浏览器预览模式数据只在 localStorage，exportManifest 在预览模式明确拒绝。
