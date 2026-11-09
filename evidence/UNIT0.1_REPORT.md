# Unit-0.1 数据安全整改｜验收报告

> 2026-11-09（Asia/Shanghai）· 分支 `feat/unit-0.1-data-safety`（基线 `main@425e57c`）· 只用合成数据（`SHIGUANG_SEED=20261109`）
> 正式基准：rustc 1.90.0（box 用户级 rustup + GitHub Actions，均由 `rust-toolchain.toml` 固定）。box 上 `/usr/bin/rustc 1.85.1` 的结果只作参考（`evidence/unit-0.1/*.ref-1.85.log`）。

## 提交与修复项
| 提交 | 内容 | 判定 |
|---|---|---|
| 8145ec3 | 01 失败测试 + 工具链固定 1.90.0 + fault-injection feature | 7 项新测试先 FAIL（`01-after.log` `--ignored`） |
| ba67b2b | 02 a：候选状态事务，校验失败不污染内存 | PASS（t_a1–a3） |
| 5ac6365 | 03 b+f：分阶段原子写入、提交回滚、durability、故障钩子 | PASS（t_b1、t_f1–f5，`--features fault-injection`） |
| d28b285 | 04 c：严格反序列化、拒绝重复键 | PASS（t_c1–c4、rejects_duplicate_keys） |
| 3c2a6bc | 05 d：提交时校验原图 SHA-256 与字节数 | PASS（t_d1–d2） |
| d67dc67 | 06 e：baseRevision 冲突保护 REVISION_CONFLICT | PASS（t_e1–e3 等） |
| 7576b41 / 后续 | CI 三平台 + Tauri 图标与 Windows 路径修复 | 见下 |

## 测试结果（rustc 1.90.0）
| 环境 | cargo test --locked | + fault-injection | CLI build | npm test | typecheck | acceptance | Tauri 桌面编译 |
|---|---|---|---|---|---|---|---|
| box Linux（rustup 1.90.0） | PASS 41（core 单元 14 / 验收 13 / 安全 14） | PASS 48（+故障 7） | PASS | PASS 16/16 | PASS | PASS | BLOCKED（box 缺 pkg-config/webkit2gtk，未用 sudo） |
| CI ubuntu-latest | PASS 41 | PASS 48 | PASS | PASS 16/16 | PASS | NOT_RUN（CI 未跑脚本） | PASS（编译 release 二进制，产物 tauri-Linux） |
| CI macos-latest | PASS 40（Linux 专属 durable 单测不适用） | PASS 47 | PASS | PASS 16/16 | PASS | NOT_RUN | PASS（产物 tauri-macOS） |
| CI windows-latest | PASS 40 | PASS 47 | PASS | PASS 16/16 | PASS | NOT_RUN | PASS（产物 tauri-Windows） |

CI run：https://github.com/chaccine/shiguang/actions/runs/42571563105 。
CI 中 Tauri 只是**编译通过**，不代表应用已在该平台启动或验收：窗口启动、真机（REDMI G Pro / MacBook）验证 = NOT_RUN；Android = NOT_RUN。

## 关键语义
- 替换前任一阶段失败：返回 `PERSIST_TEMP_CREATE/WRITE/SYNC/REPLACE_FAILED`（带 stage），删除临时文件，旧状态与内存不变。
- 替换成功即生效；父目录同步失败 → `Ok` + `durability:"uncertain"`；Windows → `parentSyncUnsupported`（如实报告）。
- 损坏/截断/字段缺失/超界/重复键 → `STATE_CORRUPT`，原文件不写不删。
- 原图 SHA/字节不符 → `ASSET_HASH_MISMATCH` / `ASSET_SIZE_MISMATCH`，正式版不变、草稿保留。
- `commit(id, expectedBaseRevision)` 冲突 → `REVISION_CONFLICT`，不覆盖正式版；磁盘草稿槽为空时保存本地草稿（保留原 base，不会被自动提交）；不按时间裁决。

## 已知限制 / 后续阶段（未实现，不得记为通过）
- g 多进程单写者锁：未实现；事务写前重载磁盘只缩小、不消除竞态窗口。
- 冲突副本存储与 UI：未实现；磁盘草稿槽已被另一份草稿占用时，本地草稿只在当前实例内存中。
- G02 最小墓碑、schemaVersion 显式迁移、照片与库一致性（导入中间态/孤立原图/恢复测试）、完整故障注入矩阵（替换后崩溃、照片复制中断、并发子进程）：均为后续阶段。
- 提交 03/06 的新测试与修复在同一提交中编写，修复前 FAIL 日志只有 01 中的 a/c/d 组。

## 证据
`evidence/unit-0.1/00-baseline-425e57c.log`、`01-after.log` … `06-after.log`、`*.ref-1.85.log`、`final.log`；CI 构建产物与日志（保留 7 天）。

---
附：提交 06 由 Codex 生成的阶段记录（原文）
# Unit-0.1 提交 06 验收记录

2026-11-09，分支 `feat/unit-0.1-data-safety`，rustc/cargo 1.90.0；仅使用本地合成数据，未执行 git commit，未访问网络。

事务写前严格重载 `state.json`；解析失败保留内存和原文件。提交同时校验调用方的 expected base、本地草稿原始 base 与磁盘 content revision，冲突返回 `REVISION_CONFLICT` / `commit`，消息包含期望、实际与草稿基线版本。原图缺失、大小、SHA 校验仍在任何写入前执行。

冲突时磁盘草稿槽为空则保存本地草稿及其原始 base，正式快照保持磁盘版本；已有草稿则不写磁盘，本地草稿保留在当前实例内存。旧 base 在再次提交及重新打开后仍会冲突。时间戳不参与冲突裁决。CLI、Tauri 参数与 TS/UI 已贯通 expected base 和冲突提示，成功输出保留 durability。持久化格式和 core 零第三方依赖不变。

| 验证 | 结果 |
| --- | --- |
| `cargo test --locked` | PASS：41 项（core 单元 14、验收 13、安全 14），0 ignored |
| `cargo test --locked -p shiguang_core --features fault-injection` | PASS：48 项（另含 7 项故障注入），0 ignored |
| `cargo build --locked -p shiguang` | PASS |
| `npm test` | PASS：4 个测试文件；另逐文件直接运行确认 16 个用例均通过 |
| `npm run typecheck` | PASS |
| `bash scripts/run_acceptance.sh` | PASS：六阶段完成，包括前端 build 与 evidence 校验 |
| CLI 显式 `--expect-base` | PASS：正确版本、版本冲突、非法/缺失参数；默认使用草稿基线 |
| Tauri 构建 | BLOCKED：按任务要求未构建，环境缺少 pkg-config |
| Windows / macOS / 真机 | NOT_RUN |

新增安全测试覆盖 T-e1 陈旧基线、T-e2 双向时钟偏差、T-e3 expected 不匹配，以及磁盘草稿槽已占用和事务重载遇到严格解析失败。时钟变更由测试文件共享 Mutex 保护，退出时恢复环境变量；既有测试仅更新 commit 调用参数，断言保持原样。

已知限制：尚无多进程单写者文件锁，重载、比较与替换之间仍有竞争窗口；磁盘草稿槽已占用时，另一份本地草稿仅在当前实例内存中，实例退出会失去该内存副本。文件锁（g）、冲突副本存储/UI、schema 变更均为后续阶段。
