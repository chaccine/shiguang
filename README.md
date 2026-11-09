# 拾光 · Unit-0

Unit-0 纵切：草稿持久化、`存入时光` 正式提交、合成图 `assetId` / `photoUseId` / caption 分离、
正式列表排除草稿、重启可读、evidence 导出。

- 数据仅合成，固定 `SHIGUANG_SEED=20261109`、验收时钟 `SHIGUANG_CLOCK=2026-11-09T10:00:00Z`。
- 当前环境：Linux（box），rustc 1.85.1，Node 24.22.1，npm 11.21.1。
- **桌面壳状态：BLOCKED**。系统缺 `pkg-config`（且无 sudo/apt），Tauri 依赖在 `gobject-sys` 处构建失败；
  核心、CLI 与前端逻辑层可完整运行与验证。详见 `evidence/UNIT0_REPORT.md`。
- Android、第二桌面 OS：NOT_RUN。

## 目录

```
core/                 Rust 领域核心（零第三方依赖）
  src/store.rs        原子持久化、草稿/正式双态、asset/photoUse、manifest
  src/model.rs        提交底线与快照模型
  src/sha256.rs       自包含 SHA-256
  src/json.rs         极简 JSON 读写
  src/preview.rs      确定性派生预览 PNG
  tests/acceptance.rs AC-U0 验收测试
cli/                  CLI（shiguang），每次调用都是独立进程
src/                  前端 TS 领域层与 UI
  domain/             提交规则、正式列表投影、展示格式
  platform/           Tauri v2 invoke 契约
  ui/                 桌面 UI（原生 DOM）
src-tauri/            Tauri v2 壳（当前无法构建，见报告）
scripts/              run_acceptance.sh、verify-evidence.mjs
evidence/             ENV_VERSIONS / UNIT0_REPORT / manifest / acceptance 产物
```

## 安装

```bash
cd /workspace/shiguang-app
npm install          # 仅 typescript 与 @types/node，装在工程内
cargo build --offline -p shiguang
```

Rust 核心无第三方依赖，`--offline` 即可构建与测试。

## 运行

核心测试与前端测试：

```bash
cargo test --offline     # 10 单元 + 13 验收 = 23
npm run test             # 12 项 TS 领域层测试
npm run typecheck
npm run build            # 输出 dist/index.html + dist/ui/main.js
```

CLI 示例（自动使用工程内数据目录，演示用合成数据）：

```bash
BIN=target/debug/shiguang
export SHIGUANG_SEED=20261109
$BIN --data-dir .shiguang-data init
$BIN --data-dir .shiguang-data draft-new --body "今天的正文" --date 2026-11-09
$BIN --data-dir .shiguang-data commit rec-000001
$BIN --data-dir .shiguang-data list
```

桌面壳（在具备 `pkg-config`、webkit2gtk-4.1、gtk+-3.0 且 rustc ≥ 1.90 的机器上）：

```bash
cd src-tauri
cargo run
```

本机尝试构建的真实失败日志：`evidence/tauri-cargo-check.log`。

## 验收

一条命令重跑全部验收（自动清理并重建合成数据）：

```bash
bash scripts/run_acceptance.sh
```

脚本会：构建 CLI → 运行 Rust/前端测试与类型检查 → 按 AC-U0-02…11 逐项执行 CLI 场景 →
导出 `evidence/manifest.json` → 运行 `npm run verify:evidence` 做 58 项机器校验。

## 数据语义

- `state.json`：唯一权威状态，写入采用“同目录临时文件 → fsync → rename → fsync 目录”。
- `media/`：原图，文件名由内容 SHA-256 决定，**没有删除接口**，预览流程只读原图。
- `previews/`：派生缓存，可整目录删除并由原图重建。
- 草稿与正式快照分开存放：`list_formal()` 只投影 `formal`；存在修改草稿时仍显示旧正式内容。
- 提交底线：`eventDate` 必填且为真实 `YYYY-MM-DD`；正文非空 **或** ≥1 张已落盘照片；仅标题拒绝。
- `eventTime` 可空，空值持久化为 `null`，展示层只显示日期，不补 `00:00`。
- 提交后 `contentRevision` 递增，`recordId` 保持不变；草稿清空。

## 已知限制

- 桌面窗口未启动（AC-U0-01 BLOCKED），因此 GUI 交互与打包未验证。
- 预览是**确定性派生占位 PNG**（由原图 SHA 生成），不是对原图的真实解码/缩放；但“删除缓存不删原图、
  重建结果一致”的语义已完整验证。正式产品需接入真实缩略图管线。
- 强杀演练发生在保存返回后（`SIGKILL`），未做写入中途断电注入；原子写已实现但未做断电故障注入。
- 单进程假设；未实现多实例并发写锁。
- 不做云、AI、部署、真机故障注入、备份加密、HEIC/大图等非目标项。

## 证据

- `evidence/ENV_VERSIONS.md`
- `evidence/UNIT0_REPORT.md`（AC-U0-01…13 逐条）
- `evidence/manifest.json`
- `evidence/acceptance/`（每条验收的原始 JSON/日志/SHA 表）
