# Unit-0 验收报告

- 日期：2026-11-09（Asia/Shanghai）
- 平台：Linux x86_64（box），rustc 1.85.1，cargo 1.85.1，Node v24.22.1，npm 11.21.1
- 数据：全部合成；`SHIGUANG_SEED=20261109`；`SHIGUANG_CLOCK=2026-11-09T10:00:00Z`
- 重跑入口：`bash scripts/run_acceptance.sh`（最后执行 `npm run verify:evidence`，当前 **58 passed / 0 failed**）
- 测试：Rust 10 单元 + 13 验收；TypeScript 12 项；类型检查通过

## 结论

核心持久化纵切（AC-U0-02…11）在本机真实执行并通过，S0 五项均未触发。
**AC-U0-01 桌面窗口为 BLOCKED**：本机没有 `pkg-config`，也无 sudo/apt 权限，Tauri 依赖在
`gobject-sys v0.18.0` 构建脚本处失败（`The pkg-config command could not be found`）。
因此**不能宣称 Unit-0 全量完成**，只能声明“核心与逻辑层通过、桌面壳受阻”。
Android 与第二桌面 OS 为 NOT_RUN。

## 逐条判定

| ID | 结果 | 证据 | 说明 |
|---|---|---|---|
| AC-U0-01 | **BLOCKED** | `evidence/tauri-cargo-check.log`、`evidence/ENV_VERSIONS.md` | 依赖已按 rustc 1.85 回退解析到 tauri 2.11.6，但 `gobject-sys` 需要 pkg-config；系统无该命令且禁止 sudo/apt，窗口无法启动。未用截图冒充通过。 |
| AC-U0-02 | PASS | `acceptance/commit-title-rejected.json.err`；Rust `ac_u0_02*`；TS `AC-U0-02` | 仅标题提交返回 `EMPTY_CONTENT`，文案“缺少正文或照片”；缺日期返回 `MISSING_EVENT_DATE`。 |
| AC-U0-03 | PASS | `acceptance/draft-before-restart.json`、`draft-after-restart.json`、`draft-kill.log`、`draft-after-kill.json` | 跨进程读回 hash 一致；落盘后 `SIGKILL`，新进程读回内容与 hash 仍一致；状态非正式。 |
| AC-U0-04 | PASS | `acceptance/commit-first.json`、`formal-after-commit.json` | `contentRevision` 由 0 → 1，生成正式快照，草稿清空，`recordId` 稳定。 |
| AC-U0-05 | PASS | `acceptance/list-after-pure-draft.json`、`dump.json` | 正式列表仅 1 条；纯草稿、被拒草稿均不出现；`dump` 中草稿 `formal=null`。 |
| AC-U0-06 | PASS | `acceptance/photo-a.json`、`photo-b.json`、`assets-*.json`、`manifest.json` | 两个独立 `photoUseId` 与 caption；原图 SHA 与文件逐一核对；`assetId` 由 SHA 派生。 |
| AC-U0-07 | PASS | `acceptance/previews-before-clear.sha`、`previews-after-rebuild.sha`、`assets-after-preview-loss.json` | 删除整个 `previews/` 后原图清单与 SHA 不变，记录仍可读；重建预览逐字节一致；无删除 asset 接口。 |
| AC-U0-08 | PASS | `acceptance/list-with-pending-edit.json`、`edit-pending-get.json` | 修改草稿存在时，列表与阅读视图仍显示旧正式正文，标记 `hasPendingDraft`，revision 不变。 |
| AC-U0-09 | PASS | `acceptance/edit-second-commit.json`、`list-after-edit-commit.json` | 再次提交 revision 1 → 2，`recordId` 不变，时间轴单一条目。 |
| AC-U0-10 | PASS | `acceptance/future-get.json`、`dump.json` | `eventDate=2099-12-31` 原样保存；`eventTime=null`；无任何 `00:00` 伪填。 |
| AC-U0-11 | PASS | `evidence/manifest.json`、`acceptance/verify-evidence.log` | 4 条正式记录、revision、body/title SHA、2 个媒体 SHA、平台版本与 seed 齐全；58 项校验全绿。 |
| AC-U0-12 | NOT_RUN | — | 仅单桌面 OS，无第二环境。 |
| AC-U0-13 | NOT_RUN | — | 未尝试 Android；无独立包名与真机。 |

## S0 一票否决检查

1. 静默丢数据：未触发。每次变更同步落盘；重启与 SIGKILL 后读回一致（AC-U0-03）。
2. 草稿出现在正式时间轴：未触发。`list_formal()` 仅投影 formal，纯草稿计数为 0（AC-U0-05）。
3. 旧快照覆盖独立元数据：本单元未实现珍藏/合集元数据；编辑提交仅替换同一记录快照，photoUse 保留各自 caption（AC-U0-06/09）。
4. 清缓存删除原图：未触发。预览目录可删，原图清单与 SHA 不变（AC-U0-07）。
5. 内存态冒充持久化：未触发。无内存数据库、无 PWA 权威存储；UI 在无 Tauri 运行时明确提示“不会保存”。

## 环境与阻塞

- `pkg-config` 缺失，`webkit2gtk-4.1`、`gtk+-3.0` 无法探测。
- `rustc 1.85.1` 低于当前 tauri 2.12 的 MSRV 1.90；通过 `incompatible-rust-versions = fallback`
  回退到 tauri 2.11.6 后，仍在 `gobject-sys` 的 pkg-config 探测处失败（exit 101）。
- 未使用 sudo、未全局安装、未修改共享配置；Tauri 构建产物仅在 `src-tauri/target`（已忽略）。

## 已知限制（不冒充完成）

- GUI 窗口、打包、桌面交互未验证（随 AC-U0-01 BLOCKED）。
- 预览为确定性派生占位 PNG（由原图 SHA 生成），未实现真实图像解码与缩放。
- SIGKILL 发生在保存返回后，未覆盖写入中途断电；原子写（临时文件 + fsync + rename）已实现但未做断电注入。
- 单进程假设，未实现多实例写锁。
- 非目标项（备份加密、HEIC、1GB、100 张、商店包、云、AI、真机强杀等）未做，按要求记 NOT_RUN。

## 产物索引

- `evidence/ENV_VERSIONS.md`
- `evidence/manifest.json`
- `evidence/acceptance/`：初始化、各 AC 的 JSON、错误 JSON、预览 SHA 表、cargo/frontend 测试日志、`verify-evidence.log`
- `evidence/tauri-cargo-check.log`：Tauri 构建阻塞的真实日志
