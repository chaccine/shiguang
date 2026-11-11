# 拾光 SHIGUANG

本地离线的个人回忆记录应用（Tauri v2：Android / macOS / Windows）。只用合成数据开发与测试；无云同步、无 AI、无网络权限。

**当前版本：0.1.10**（Android versionCode 1010）· 分支开发、PR 合并由 Cine 决定。

## 进度（Unit-0.10 Task A + B / 0.1.10）

| 单元 | 内容 | 状态 |
|---|---|---|
| Unit-0.10 Task A + B | schema v4 迁移及备份兼容；M01 说明/封面/顺序/地点/心情的数据与命令；主题与应用锁 UI；规范五入口导航、正式阅读页、编辑器新字段及只读存储统计 | 本地实现；设备/视觉验证边界，验证见 [SPEC](evidence/unit-0.10/SPEC.md) 和 [记录](evidence/unit-0.10/REPORT.md) |
| Unit-0 ~ 0.2 | 草稿/正式双态、原子落盘、照片 asset/photoUse 分离、自动保存与草稿恢复、暖纸本桌面 UI | 已合并 |
| Unit-0.3 | Tauri Android APK（arm64 debug 侧载） | 已合并 |
| Unit-0.4 / 0.1.3 | 多实例写锁（Android 无 flock 时回落进程内注册表 + `.owner`）、schemaVersion 迁移、回收站与删除标记、照片一致性核查、冲突副本 | 已合并 |
| **Unit-0.5** | **G03 最小版：一致性快照导出 `.sgbak` → 完整校验 → 覆盖恢复（自动安全副本、原子切换、失败回滚、崩溃恢复日志）；桌面原生对话框、Android 系统文件选择器** | 已合并（PR #5） |
| **Unit-0.6 / 0.1.5** | **G03 安全合并 + G02 跨备份防复活 + 可选口令加密**：合并按 (recordId, createdAt) 认身份，已永久删除/在回收站的记录不会被旧包带回；同记录取较大 contentRevision，分歧一律留冲突副本；照片按 sha 去重；撞号改号且重复导入幂等；合并前安全副本 + 日志回滚。加密：Argon2id + XChaCha20-Poly1305 分块 STREAM，错口令/篡改一律拒绝且数据不变 | 已合并（PR #5） |
| **Unit-0.8 / 0.1.9** | 草稿标签、真实缩略图、HEIC 回退、锁等待与截图脚本修复。CI 使用 GitHub Secrets 固定 debug 证书重签 APK，并预置 NSIS 以产出 setup.exe。真机安装与原生 HEIC 仍为 NOT_RUN。详见 evidence/UNIT0.8_REPORT.md | 本轮基线 main `b882029`；报告保留当时状态 |
| **Unit-0.7 / 0.1.7** | **M02 时光轴 + M03 日历 + 收藏 + G06 标签**：时光轴按年/月/日分组、新→旧（可切换）、缩略图、跳到年月、游标分页（无重漏）；日历月视图带圆点/条数，点日看当天，附最小“那年今日”；收藏按 favoriteRevision CAS；标签增/改名/合并/删除均为单次原子事务、无孤儿标签，随 `.sgbak` 备份与合并往返（墓碑防复活、别名重映射、同名合并、撞号改号）；schema v2→v3 迁移（备份原文件、故障注入回滚）。**热修复**：Android 导出备份后“数据暂时无法打开 / state not managed”（见 `evidence/UNIT0.7_REPORT.md`）。**0.1.8**：默认打开时光轴；主导航永远可见（手机底部 tab bar：时光轴/日历/草稿/标签·收藏/设置） | 已合并（PR #6） |

备份 ≠ 同步：多设备自动同步不做。新设备若只有一份“删除之前”的旧备份，无法知道后来删除过什么（防复活依赖本机或备份里的删除标记）。

构建与验证：GitHub Actions 7 个 job（三平台 core+cli+ts、三平台 Tauri 打包、Android APK）。box 本机缺 webkit2gtk，不构建桌面壳；Android 目标可在 box 上 `cargo check --target aarch64-linux-android`。
CI 通过 ≠ 真机通过：真机行为以各单元 `evidence/UNIT*_REPORT.md` 中的 PASS / NOT_RUN 为准。

## 备份格式 `.sgbak`（format 1）

明文包单文件、无压缩：
`magic "SGBAK\0\0\x01"` + `u64 LE manifest 长度` + manifest JSON + 原始条目（`state.json` 与被引用的 `media/*` 原图）+ 48 字节尾部（`SGBAKEND` + 之前全部字节的 SHA-256 + 长度）。
新包 schemaVersion=4，旧 v1–v3 包读取时迁移；manifest 含 formatVersion、schemaVersion、appVersion、exportedAt、encryption（目前只有 `none`）、各类计数、缺失原图列表、每个条目的大小与 SHA-256。
`previews/`（可重建缓存）、`backups/`、隔离区、锁文件不进包。详见 `evidence/unit-0.5/SPEC.md`。

**加密包（SGBAKENC v1，Unit-0.6，可选）**：magic `SGBAKENC\0\x01` + 头部（KDF 参数、盐、nonce 前缀；头部整体作为 AAD）+ 1 MiB 分块的 XChaCha20-Poly1305 STREAM（nonce = 19 字节前缀 ‖ u32 计数 ‖ 末块标志），内层就是上面的明文包。口令经 Argon2id（默认 m=64 MiB、t=3、p=1，解密时参数有上限）派生密钥；口令不保存、不进日志，丢失无法找回。
依赖（Cargo.lock 固定，纯 Rust、无 C/NDK 依赖）：`argon2 0.5.3`、`chacha20poly1305 0.10.1`、`getrandom 0.2.17`、`zeroize 1.9.1`（RustCrypto；其余为它们的传递依赖）。选型理由见 `evidence/unit-0.6/SPEC.md`。

## 目录

```
core/                 Rust 领域核心（仅 RustCrypto 加密依赖）
  src/store.rs        原子持久化、草稿/正式双态、asset/photoUse、manifest
  src/model.rs        提交底线与快照模型
  src/sha256.rs       自包含 SHA-256
  src/json.rs         极简 JSON 读写
  src/preview.rs      确定性派生预览 PNG
  src/backup.rs       Unit-0.5 备份导出/校验/覆盖恢复（.sgbak）+ Unit-0.6 合并导入
  src/backup/crypto.rs Unit-0.6 口令加密容器
  src/merge.rs        Unit-0.6 纯函数合并（防复活、冲突副本、撞号改号）
  tests/acceptance.rs AC-U0 验收测试
cli/                  CLI（shiguang），每次调用都是独立进程
src/                  前端 TS 领域层与 UI
  domain/             提交规则、正式列表投影、展示格式
  platform/           Tauri v2 invoke 契约 + 浏览器预览 MemoryAdapter
  ui/                 桌面 UI（原生 DOM）
src-tauri/            Tauri v2 壳（命令层；CI 三端构建）
scripts/              run_acceptance.sh、verify-evidence.mjs
evidence/             ENV_VERSIONS / UNIT0_REPORT / manifest / acceptance 产物
```

## 安装

```bash
cd /workspace/shiguang-app
npm install          # 仅 typescript 与 @types/node，装在工程内
cargo build --offline -p shiguang
```

Rust 核心的 RustCrypto 依赖由 Cargo.lock 固定；依赖已缓存时可 `--offline` 构建与测试。

## 运行

核心测试与前端测试：

```bash
cargo test --offline --locked --workspace                     # 全部 Rust 测试
cargo test --offline --locked --workspace --features fault-injection   # 含故障注入
npm test                 # TS 领域层与 MemoryAdapter 测试
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

备份 CLI（合成数据）：

```bash
$BIN --data-dir .shiguang-data export-backup /tmp/demo.sgbak
$BIN verify-backup /tmp/demo.sgbak
$BIN --data-dir .shiguang-data2 restore-backup /tmp/demo.sgbak --yes   # 无 --yes 拒绝
```

桌面壳（在具备 `pkg-config`、webkit2gtk-4.1、gtk+-3.0 且 rustc ≥ 1.90 的机器上）：

```bash
cd src-tauri
cargo run
```

浏览器预览（MemoryAdapter，合成数据）与截图：`npm run preview`、`npm run screenshots:u05`。

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
- v4：每处照片说明、照片数组顺序、`coverPhotoUseId`、纯文本 `location`（200 字符）与可选 `mood` 都属于快照，草稿修改须显式提交。详见 [Unit-0.10 SPEC](evidence/unit-0.10/SPEC.md)。
- 主题偏好默认 `system`，随便携备份保存。应用锁默认关闭，真实应用命令使用 Rust Argon2id，失败限速随本机状态持久化；便携备份不含锁凭据，恢复保留目标锁，合并不导入锁。
- 应用锁有启动解锁屏幕；窗口失焦/后台时遮挡，离开满 60 秒后要求重解锁；**不加密本机文件，也未实现系统最近任务截图保护**。忘记码没有应用内恢复接口；文件可读写者可在退出应用后手动重置该偏好，详见 SPEC。备份加密口令仍独立且丢失无法找回。

## 已知限制

- 备份支持覆盖恢复、安全合并、可选口令加密；不做多设备同步。浏览器预览里的“加密”只是交互演示（真实加密在 Rust core）。
- 缩略图 JPEG/PNG/GIF/WebP 的实际解码在独立 thumbnails crate；HEIC 原生三端解码及 100 张大原图/100MB 备份跨端测试仍以报告的 NOT_RUN 为准。既有 5000 条合成压力测试只共享 32 张小图。
- Task B 已接入 M01 新字段编辑、正式阅读、主题及应用锁 UI。M01 图文块/双模式故事编辑延期（需模型与迁移，非简单控件改动），照片替换/撤销等完整 M01 仍未完成。存储统计不跟随符号链接，剩余空间显示未知；暂不提供清理动作。M04 博物馆、M05 检索、M08、网络/云/AI 不在本轮范围；既有时光轴/日历/标签/收藏功能继续保留。
- 浏览器预览的应用锁用 WebCrypto PBKDF2-SHA256 模拟契约，存储与备份封装不兼容原生格式；真实应用路径始终调用 Rust Argon2id。
- 安装包均未正式签名（Cine 已取消正式签名）。Android 为固定 debug 证书侧载包（GitHub Secrets 中的同一把调试密钥，CI 重签，证书与 0.1.8/0.1.9 盒上重签包相同，可覆盖安装）。Windows 出 MSI 与 NSIS（工具包预置在 `ci/windows-nsis/`，避免 GitHub Releases 504）。
- 真机上的写锁、回收站、备份导出/恢复、Android 系统文件选择器：除报告中标 PASS 的条目外均为 NOT_RUN。

## 证据

- `evidence/ENV_VERSIONS.md`
- `evidence/UNIT0_REPORT.md`（AC-U0-01…13 逐条）… `evidence/UNIT0.5_REPORT.md`（各单元报告）
- `evidence/manifest.json`
- `evidence/acceptance/`（每条验收的原始 JSON/日志/SHA 表）
