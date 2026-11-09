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
