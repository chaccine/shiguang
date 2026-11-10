# Unit-0.5 最小完整备份与恢复（G03 最小版）｜验收报告

> 2026-11-10（Asia/Shanghai）· 分支 `feat/unit-0.5-backup`（基线 `main@51a956d`）· PR https://github.com/chaccine/shiguang/pull/5（**未合并，由 Cine 决定**）
> 只用合成数据。对齐 Drive：G01–G06 数据契约 v1.0（G03-R1/2/4/5/6、G02-R4）、任务书 v0.3 T03/T04、技术路线 v0.4（未改 Drive）。规格：`evidence/unit-0.5/SPEC.md`。
> 按 Cine 新要求（做完更大一部分再推安装包），本单元为阶段节点：APK 仅本地重签，未上传 Drive。

## 提交与执行者
| 提交 | 内容 | 执行者 |
|---|---|---|
| 7557fbf | 实现规格 SPEC.md | Grok Bot |
| 3d22803 | 版本统一 0.1.4（Cargo 工作区/桌面壳/package.json/tauri.conf；0.1.0 残留清除；versionCode 1004 由 tauri 推导） | Grok Bot |
| 44409f5 / 957dc61 | TS 契约；MemoryAdapter 同语义备份/恢复、Tauri 适配、BACKUP_*/RESTORE_* 中文文案、11 项 TS 测试 | Grok Bot |
| aa822d5 | 「数据」页 UI、手机 4 标签布局、u05 截图脚本 + 9 张截图 | Grok Bot（CodeBuddy 未使用：UI 量小，上单元其输出断裂，直接自写更稳） |
| c8456a1 | Tauri 备份命令 + dialog/fs 插件（仅 Rust 侧调用） | Grok Bot |
| 3b54609 | README 更新 | Grok Bot |
| ec29d5a | core/CLI 测试先行（52 项） | Codex `gpt-6.1-sol` high（Team，workspace-write） |
| 6fdb992 | core `backup.rs` + CLI 子命令；硬链接不可用时回退 rename | Codex 主体；回退由 Grok Bot 补 |
| e4a591b | run_acceptance.sh U05 段 + 故障注入测试 | Grok Bot |

## 本机验证（box，rustc 1.90.0）
| 项 | 结果 |
|---|---|
| `cargo test --locked` | **PASS 130**（Unit-0.4 87 → +43） |
| `cargo test --locked -p shiguang_core --features fault-injection` | **PASS 157**（+14 unit05_faults） |
| `cargo clippy --all-targets -D warnings` | PASS |
| `npm test` / typecheck / build | **PASS 90/90**（+11）/ PASS / PASS |
| `bash scripts/run_acceptance.sh`（含 U05：导出不改源、校验、无 --yes 拒绝、篡改/截断拒绝且现有库逐字节不变、覆盖恢复后状态与原图逐项一致、安全副本存在） | PASS |
| `src-tauri` `cargo check --target aarch64-linux-android` | PASS |
| 浏览器预览截图（MemoryAdapter） | PASS 9 张；**预览模拟，非真机** |

## CI
PR run https://github.com/chaccine/shiguang/actions/runs/42748048027（head `e4a591b`）—— **7/7 PASS**，首轮通过：core+cli+ts ×3（ubuntu/macos/windows）、tauri bundle ×3、android apk。

## 产物（/workspace/u05dl/，本地，未上传）
| 文件 | 大小 | sha256 |
|---|---|---|
| `拾光_0.1.4_arm64-debug.apk` | 21,791,285 | `44b08e0a149ca6c95b46da2eac0c79f66e9c12307eb6586b287bad87a3d4f7ef` |
| `拾光_0.1.4_aarch64.dmg` | 3,772,121 | `43f3bc8c3ead2c5adbec63b1a15cf06985c98559c6951e085a3b83a7a93fc354` |
| `拾光_0.1.4_x64_zh-CN.msi` | 3,784,704 | `c76623ee0d1869092b25e99b699001a51a317bdba10f17af044dfd0b95b4c0c9` |

APK：strip → 去旧签 → `zipalign -p 4`（-c 通过）→ `apksigner` 用 `~/.android/debug.keystore` 重签；v2+v3 Verifies；证书 SHA-256 `59dbe106e00efc187b10faf0c2839fd575de09a42f7a964dc94c00e309af766f`（与 0.1.3 相同）；versionCode 1004；权限仅 `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`，无 INTERNET。

## 语义要点
1. `.sgbak` format 1：magic + manifest（schemaVersion/appVersion/exportedAt/encryption=none/counts/missingMedia/每条目 size+sha256）+ 原始条目 + 48B 尾部（整包 SHA-256 + 长度）。无压缩、core 零依赖。
2. 导出：写锁内快照；partial → 完整校验 → no-clobber 发布；缺失原图不阻塞，计入 missingMedia 并提示；源数据逐字节不变。
3. 校验：先于任何写入；截断 `BACKUP_TRUNCATED`、篡改 `BACKUP_CORRUPT`、非备份/路径穿越/重复 `BACKUP_INVALID`、schema 过新 `BACKUP_SCHEMA_TOO_NEW`、加密 `BACKUP_ENCRYPTED_UNSUPPORTED`。
4. 覆盖恢复：仅独占实例；staging → 安全副本 `backups/pre-restore-*`（永不自动删）→ 日志 → 媒体换位 → state 原子替换（提交点）→ reconcile。失败整体回滚；崩溃后 open 时按日志完成或回滚，只可能是完整旧/完整新状态。
5. Tauri：桌面原生对话框；Android 系统文件选择器（ACTION_CREATE_DOCUMENT 保存 / ACTION_GET_CONTENT 选择），content:// 文件描述符流式读写，导出后读回比对整包 sha256；选择的包先复制进应用缓存再校验。

## PASS / NOT_RUN / BLOCKED
| 项 | 状态 |
|---|---|
| core/CLI/TS 单测、故障注入、验收脚本 | PASS |
| CI 三端构建与打包 | PASS |
| 浏览器预览 UI | PASS（模拟） |
| Android 真机导出/恢复、SAF 选择器真机 | **NOT_RUN** |
| 桌面（macOS/Windows）真机对话框与恢复 | **NOT_RUN** |
| 覆盖安装 0.1.3 → 0.1.4 真机 | NOT_RUN |
| 本机 Tauri 桌面构建 | BLOCKED（缺 webkit2gtk，无 sudo；由 CI 代替） |

## 未做（本单元范围外）
安全合并、口令加密、跨备份防复活（转 Unit-0.6）；100MB 大包/100 张照片压测；真实缩略图；G01 珍藏修订；G06 标签事务；正式签名；Windows NSIS。

## 截图（evidence/unit-0.5/，浏览器预览）
01 数据页与未实现提示 · 02 导出成功 · 03 选择后校验通过 · 04 覆盖恢复二次确认 · 05 恢复成功 · 06 损坏包被拒 · 07 截断包被拒 · 08 schema 过新被拒 · 09 手机导出。复现：`npm run screenshots:u05`。
