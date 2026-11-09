# Unit-0.2 硬核部分交接记录

2026-11-09，仓库 `/workspace/shiguang-app`，分支 `feat/unit-0.2-desktop-ux`，基线 `main@451d9d3`。仅使用合成正文、合成字节和临时目录；全程未访问网络、未全局安装、未执行 git commit。Rust 使用 `~/.cargo/bin` 的 1.90.0，运行 Cargo 时设置 `CARGO_NET_OFFLINE=true`。core 仍为零第三方依赖，两个 Cargo.lock 和 Cargo.toml 均无改动，既有测试文件及其断言无改动。

## 文件与行为

| 文件 | 修改内容 |
| --- | --- |
| `core/src/store.rs` | 新增草稿列表、字节附图、草稿照片移除、草稿丢弃；路径/字节通道共用私有 `attach_photo_data`，沿用候选状态和原子持久化；原图目录同步不确定时也保留 uncertain |
| `core/src/base64.rs`、`core/src/lib.rs` | 标准 RFC 4648 Base64 编码及导出；覆盖空输入、各余数字节与二进制向量 |
| `core/tests/unit02_drafts.rs` | 10 项普通测试 + 2 项 feature 故障测试，覆盖重开、排序、共享原图、边界、损坏状态及替换前失败不污染状态 |
| `src-tauri/src/lib.rs` | 新命令、保存响应 durability、8MiB 原图 data URL 上限、全部命令显式 camelCase 参数适配与注册 |
| `src-tauri/tauri.conf.json` | 设置 `app.withGlobalTauri: true` |
| `src/platform/api.ts` | 从适配器迁出公共契约和输入/结果类型 |
| `src/platform/tauri-adapter.ts` | 实现新契约；Uint8Array 转 JSON 数组，eventTime null 映射 clearEventTime；保留路径版 attachPhoto |
| `src/platform/memory-adapter.ts` | 浏览器合成数据实现、注入 storage/clock、失败注入、durabilityMode、基线冲突保护、原图引用独立于草稿 |
| `src/platform/bytes.ts` | 无 DOM/Node 专属全局依赖的 SHA-256、Base64 和图片类型嗅探，供内存预览使用 |
| `src/domain/errors.ts` | 中文错误分类、保留错误码/阶段；冲突、落盘未确认、内容校验、磁盘和原图问题分别提示 |
| `src/domain/draft-session.ts` | 防抖、串行写入、失败保留输入、恢复、附图、提交及观察者快照 |
| `src/ui/main.ts` | 仅一行适配 createDraft 的 `created.row` 返回值；页面接入与美化由 UI 工作完成 |
| `tests/draft-session.test.ts`、`tests/memory-adapter.test.ts`、`tests/errors.test.ts` | 分别新增 23、14、6 项用例，全用假调度器或显式 Promise 控制，无真实计时 |
| `evidence/ENV_VERSIONS.md` | 验收脚本自动刷新采集时间 |

本轮过程中观察到 `.github/workflows/ci.yml` 另有外部改动，未修改或回滚该文件，不计入上述工作。未修改 `scripts/verify-evidence.mjs`，原有 58 项验收断言原样通过。

## 新增与调整的 API

Rust：

- `Store::list_drafts(&self) -> Vec<&RecordRow>`：只选 draft 非空，updated_at、record_id 均倒序。
- `Store::attach_photo_bytes(record_id, file_name, bytes, caption, media_type) -> Result<PhotoUse, CoreError>`：拒绝空文件、超过 25MiB、文件名中的 `/`、`\`、`:`、NUL、空名和点路径。文件名只参与类型/扩展名嗅探；磁盘路径始终由 SHA 派生。恰好 25MiB 接受。
- `Store::remove_draft_photo(record_id, photo_use_id) -> Result<RecordRow, CoreError>`：只移除草稿引用，缺引用返回 PHOTO_USE_NOT_FOUND。
- `Store::discard_draft(record_id) -> Result<Option<RecordRow>, CoreError>`：纯草稿移除整行，已有正式版仅清草稿槽，正式版/revision 不变；不删 media。
- `base64::encode(&[u8]) -> String`。

Tauri：

- 新增 `list_drafts`、`attach_photo_bytes`、`remove_draft_photo`、`discard_draft`、`photo_data_url`。
- `create_draft`、`save_draft`、`attach_photo_bytes`、`remove_draft_photo` 返回 `{ row, durability }`。
- `discard_draft` 返回 `{ row: RecordRow | null, durability }`；null 表示纯草稿行已移除。
- durability 字符串仍为 `durable | parentSyncUnsupported | uncertain`，直接读取 core 的 last_durability；commit 原有结果结构不变。
- `photo_data_url(assetId)` 经 `store.asset_path` 找原图，打开并限量读取，超过 8MiB 返回 PREVIEW_TOO_LARGE；返回持久化 mediaType 的 Base64 data URL。缺图返回 ASSET_MISSING，读取失败为 ASSET_READ_FAILED。孤立原图按受控扩展名回退类型。
- 原路径版 `attach_photo` 保留原先的裸 RecordRow 返回值。

TS 公共接口 `ShiguangApi`：`listDrafts / listFormalRecords / getRecord / createDraft / saveDraft / attachPhotoBytes / removeDraftPhoto / discardDraft / commitRecord / photoDataUrl / exportManifest`。`SaveResult = { row, durability }`；路径版额外保留在 `TauriApi` 中。

`MemoryAdapter({ storage?, storageKey?, now? })` 不读 DOM 全局。`failNext(code, op)` 的 op 使用公共接口的 camelCase 方法名，只消费下一次匹配调用。`durabilityMode` 可设 uncertain 或 parentSyncUnsupported。storage 写入失败不替换实例内存，坏 JSON/结构返回 STATE_CORRUPT，不自动清空。基于正式版新建修改草稿时复用正式内容，提交核对调用方 expectedBaseRevision 与本地草稿原始 baseRevision；不以时钟裁决。浏览器没有文件系统，exportManifest 明确拒绝并返回 IO_ERROR，避免声称文件已导出。

## 自动保存状态转移

| 当前状态 / 条件 | 事件 | 下一状态与行为 |
| --- | --- | --- |
| idle | edit 非空字段 | dirty，重置 800ms 防抖（可注入 debounceMs） |
| idle / dirty 且尚无 ID、所有输入为空白 | flush / 防抖触发 | idle，不调用 createDraft，不落空白行 |
| dirty，或 error 下显式重试保存 | flush / retry / 防抖触发 | saving；首次 createDraft，已有 ID 调 saveDraft |
| saving | edit | 保留最新完整本地字段；请求继续串行，在途响应不覆盖新输入；完成后再保存最新值 |
| saving | 成功 durable / parentSyncUnsupported | saved，更新 lastSavedAt；后者仍按已保存处理 |
| saving | 成功 uncertain | savedUncertain，lastError.kind 为 durability，明确落盘未确认 |
| savedUncertain | retry | 再次写入；成功后依据新的 durability 转移 |
| saving | IO / 校验等失败 | error，lastError 明确原因，recordId 与全部本地内容保留，停止计时器 |
| error | retry | 重发未保存的最新字段，成功才推进本地已保存版本 |
| 任意在途操作 | 前序写入失败 | 之前已经排队的 flush / commit / 附图等请求拒绝，不暗中自动重试；调用方可重新发起操作 |
| 可写状态 | attachPhoto / removePhoto | 同一串行队列中先 drain（flush 等价），再更新照片引用；期间编辑保留并继续排队保存 |
| 可写状态 | commit | 先 drain；validateForCommit 失败则 error / validation，不调用 commit API；否则传固定草稿基线 |
| commit 在途 | edit | 提交成功后 dirty，新输入保存到下一草稿，使用新正式版本作基线 |
| 保存或提交失败 REVISION_CONFLICT | 失败 | conflict，保留输入，停止计时器，禁止自动重试及 retry 写入，不按时间选赢家 |
| conflict | edit / flush / retry / commit | 编辑只改本地内容；写入请求继续拒绝，不覆盖另一正式版 |
| 已保存且无在途写入 | open(row/null) | saved / idle；有未保存输入或冲突时拒绝直接切换，避免丢输入 |

UI 使用 `new DraftSession({ api, schedule, cancel, debounceMs? })`，`onChange` 立即返回独立快照并提供取消订阅函数。快照包含 status、recordId、snapshot、lastError?、lastSavedAt?。切换前应 await flush() 再 open(row)。窗口关闭需要宿主阻止关闭、await flush() 后再关闭，不能依赖浏览器 unload 等待异步写入。发生冲突时先保留会话中的本地副本，另开会话核对正式版；本单元不增加冲突自动合并 UI。

恢复：`recoverLastDraft(api, preferredRecordId?)` 优先选择仍有草稿的指定 ID，否则按 updatedAt、recordId 倒序选择；没有草稿返回 null，读取错误原样拒绝，可直接交给 open。UI 负责注入 localStorage 中的最后打开 ID；状态机本身不访问 localStorage。

## 验证与输出摘要

下列命令均成功退出，输出保存在本目录同名用途的 `.log` 中（仓库现有 `.gitignore` 忽略日志；本 Markdown 保留可提交的摘要）。Rust 版本 `rustc 1.90.0 (1159e78c4 2025-09-14)`，Node `v24.22.1`。

| 命令 | 结果 / 原位输出摘要 |
| --- | --- |
| `cargo test --locked` | PASS 52：core 单元 15、原验收 13、原安全 14、新草稿测试 10；0 failed / 0 ignored |
| `cargo test --locked -p shiguang_core --features fault-injection` | PASS 61：上述 52 + 原故障 7 + 新故障 2；0 failed / 0 ignored |
| `cargo build --locked -p shiguang` | PASS，Finished dev profile |
| `npm test` | PASS，node --test tests/*.test.ts 在本环境汇总 7 个测试文件，7 pass / 0 fail |
| 逐文件 `node tests/*.test.ts`（shell 循环，每次一个文件） | PASS 59 个具体用例：既有 16 + 状态机 23 + 内存/命令契约 14 + 错误 6；各文件均 0 failed / 0 skipped |
| `npm run typecheck` | PASS，tsc -p tsconfig.json，所有相对 TS import 保留 .ts 后缀 |
| `npm run build` | PASS，tsc -p tsconfig.build.json，copied src/ui/index.html -> dist/index.html |
| `bash scripts/run_acceptance.sh` | PASS，6 个阶段全部完成，verify-evidence: 58 passed, 0 failed |
| 提取 photo_data_url 函数体的临时 Rust shim | PASS 1：链接实际 core、编译并运行原函数体中的读取/迭代逻辑，覆盖正常 URL、缺图、恰好 8MiB 与超限；不计入上述仓库测试总数 |
| `git diff --check` | PASS |

新故障测试使用既有 fault-injection 机制：TempCreate、TempWrite、TempSync、Replace 失败时，内存、state.json、last_durability 和已有原图不变，无临时文件残留；ParentSync 失败时替换已生效，返回成功并报告 uncertain。照片移除与草稿丢弃重开后仍成立。原 Unit-0.1 的冲突、坏状态、原图 SHA/大小验证及原子写测试均原样通过。

## Tauri 自查及未验证项

**src-tauri 未在本机完整编译**：遵照环境约束，不安装 webkit2gtk、不新增插件或 crate；完整桌面编译交给 CI。本机不把 rustfmt 或临时 shim 记作 Tauri 编译通过。

对 `src-tauri/src/lib.rs` 的自查：

- `AttachPhotoBytesInput` 派生 Deserialize，serde rename_all camelCase，对应 recordId/fileName/mediaType；bytes 为 Vec<u8>，caption 缺省空串，mediaType 为 Option<String>。已有 create/save 的 serde/default 结构保留。
- CommandError 保留 Serialize、code/message/可选 stage。结果通过既有 core Json -> serde_json::Value 转换，未要求 core 模型增加 serde 依赖。
- 全部 command 显式使用 `rename_all = "camelCase"`；直接参数 record_id/photo_use_id/asset_id/out_path/expected_base_revision 与 TS 参数一致；有结构体的命令仍传 `{ input }`。
- `tauri::State<'_, AppState>` 只在同步命令中获取 MutexGuard，没有借用跨 await；命令返回拥有所有权的 Value/String，remove/discard 使用 core 返回的拥有所有权行，引用不逃出 guard。
- preview 使用 File::take(LIMIT + 1) 限制实际读取，metadata 与读后再次核对大小；record draft/formal 的迭代引用在 guard 内使用。该函数体的借用、类型和边界已由独立 shim 实际编译验证。
- generate_handler 中保留旧命令并注册全部五个新命令，tauri.conf 的 withGlobalTauri 与 window.__TAURI__.core.invoke 契约一致。

尚未验证桌面窗口启动、真实文件选择/关闭窗口流程、CI 的完整 Tauri 编译、Windows/macOS/Android 真机。UI 当前只做返回类型适配，未在本轮接线自动保存与照片控件。

继续保留 Unit-0.1 的边界：没有多进程文件锁，事务重载与替换仍有竞态窗口；磁盘草稿槽已被占用时，第二份冲突草稿仍只存在相应实例内存。照片与状态是两个原子文件写入，若新原图已经写入而状态替换失败，可能留下孤立原图；不会冒险删除可能被另一记录/实例引用的 media，孤立原图清理仍是后续阶段。此次没有增加云同步、AI、M08、模块02、自动合并或原图删除功能。
