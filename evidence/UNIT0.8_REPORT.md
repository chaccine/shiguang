# Unit-0.8 报告：草稿编辑器标签 + 真缩略图/HEIC + 压力测试 + 锁等待与截图修复 · 0.1.9（versionCode 1009）

- 分支：`feat/unit-0.8-polish`（由 main `3eace87` 拉出；**不合并**，由 Cine 决定）
- 规格：`evidence/unit-0.8/SPEC.md`
- 模型：Codex gpt-6.1-sol medium（`codex exec`，workspace-write）完成实现；编排侧补了锁文件、缩略图测试断言、截图脚本与证据（沙箱不能听 localhost、不能写 `.git`）
- 正式/发布签名：**未做**（Cine 已取消；未创建 release keystore，未向 CI/Secrets 添加正式签名）

## 测试

| 项 | 结果 |
| --- | --- |
| `cargo test --locked`（workspace：core + cli） | **184 通过 / 0 失败** |
| `cargo test --locked -p shiguang_core --features fault-injection` | **226 通过 / 0 失败** |
| `cargo test --locked --manifest-path thumbnails/Cargo.toml` | **1 通过 / 0 失败**（JPEG/PNG/GIF/WebP 真解码、缓存稳定、不改原图；有损 WebP 合成花纹可小于 320px PNG，尺寸上限才是硬约束） |
| `npm test` | **127 通过 / 0 失败**（14 个测试模块，含 `tests/unit08.test.ts`） |
| `npm run typecheck` / `npm run build` | PASS |
| 截图 u04 / u05 / u06 | **PASS**，page errors 0；已按 0.1.8 导航重跑（设置 → 打开回收站；默认时光轴） |
| 截图 unit-0.9（`screenshots-u09.mjs`） | **PASS**，page errors 0；8 张：编辑器加/建标签（桌面+手机）、时光轴缩略图、HEIC 占位 |

## 功能结论

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 版本 0.1.9 / versionCode 1009 | PASS（推导） | package、workspace、Tauri、两份既有 lockfile、README；APK 包内 versionCode 待 CI 产物检查 |
| 草稿编辑器加/改/建标签 | PASS（core + TS + 预览截图） | `set_record_tags` 允许未提交的 active 草稿行（CAS 仍在）；`set_favorite` 仍要求正式记录；丢弃从未提交的草稿会删行；commit 只发布内容、保留标签。真机/桌面壳 NOT_RUN |
| 列表真缩略图（JPEG/PNG/GIF/WebP） | PASS（crate 单测 + 浏览器预览） | 解码在独立 `thumbnails/` crate（`image` 0.25），不进 core。缓存 `previews/{assetId}.thumb-v2.png`，最大边 320px。时光轴/日历封面走 `photoThumbUrl`，不再拉原图。Tauri 壳在 CI 构建，本机无 webkit，桌面壳 check NOT_RUN/BLOCKED |
| HEIC/HEIF 嗅探 + 占位 | PASS（core 嗅探 + MemoryAdapter 预览截图） | 无法解码时显示「无法预览 HEIC 图片」，不崩溃 |
| Android ImageDecoder HEIC | NOT_RUN | `android-overrides/MainActivity.kt` + `src-tauri/src/android_thumb.rs` 已写，需 CI APK / 真机 |
| macOS ImageIO / sips HEIC | NOT_RUN | 代码已写，未在 macOS 上跑 |
| Windows WIC/WPF HEIC | NOT_RUN | 代码已写；系统可能没有 HEIF 扩展，失败应走占位 |
| Linux 原生 HEIC 解码 | NOT_RUN | 未引入 libheif（无 sudo）；走占位 |
| 写锁等待 15s + 多进程测试 | PASS（Linux） | 偏离 Unit-0.4 SPEC 的约 3s；正确性断言保留（80 条、seq 唯一、可解析、无丢失更新）。Windows CI 复跑待本 PR |
| 5000 条合成压力测试 | PASS | 见下表；默认 CI 规模 200 |
| 旧截图脚本 0.4–0.6 | PASS | 见上 |

## 压力测试（合成数据）

Rust 1.90 debug，5000 条正式记录、5000 个照片引用，共享 **32** 张本地生成的小 PNG（不是 5000 张高分辨率相机原图）。`state.json` 6,209,093 字节；备份 8,573,843 字节。语料在临时目录，不入库。

复现：

```sh
SHIGUANG_STRESS_SIZE=5000 SHIGUANG_STRESS_OUT="$PWD/evidence/unit-0.8/stress.json" cargo test --locked -p shiguang_core --test unit08_stress -- --nocapture
```

| 测量 | 毫秒 |
| --- | ---: |
| Store::open | 511.529 |
| 时光轴首页 50 条 | 11.480 |
| 时光轴后续页（约第 10 页） | 7.409 |
| 备份导出 | 2406.035 |
| 覆盖恢复 | 6856.987 |

恢复后核对 5000 条正式记录与照片引用。发现的热点：JSON 解析对每个字符重复校验剩余文档（接近平方）；已改为一次只校验一个 UTF-8 标量，并保留严格 JSON 拒绝与多语言往返回归。`Store::open` 不会重建全部预览。不宣称未经完整前后对照的加速比。

## 截图

`evidence/unit-0.9/`（本单元，浏览器 MemoryAdapter，合成数据，不是真机）：

- desktop-create-tag.png / mobile-create-tag.png
- desktop-editor-tags.png / mobile-editor-tags.png
- desktop-timeline-thumbnails.png / mobile-timeline-thumbnails.png
- desktop-heic-placeholder.png / mobile-heic-placeholder.png

`evidence/unit-0.4`、`unit-0.5`、`unit-0.6` 的 PNG 已按当前导航重跑。`evidence/unit-0.8/` 里 0.1.8 导航截图未改。

## 未跑 / 未做 / 需 Cine 决定

- 真机与桌面安装包实际运行：NOT_RUN（等本 PR 的 APK / dmg / msi）
- 三端原生 HEIC 解码：NOT_RUN
- 本机 Tauri 桌面编译：预计仍 BLOCKED（box 无 webkit2gtk，与既往相同）
- Windows 多进程锁测试：需看本 PR 的 CI
- **未做（Cine 已取消）**：正式/发布签名、release keystore、正式签名 CI/Secrets
- 仍待 Cine 决定（本单元未做）：
  1. 把盒上同一把 debug keystore 放到 GitHub Secrets：CI 打出的 APK 就能直接覆盖安装，不必再在盒上重签。仍是调试证书，不是商店证书。
  2. 是否同时分发 Windows NSIS `.exe`（`tauri.conf` 已配置简体中文；现在主要交 MSI）
  3. 是否更新 Drive 里已过时的项目文档（例如仍写 SQLite 或旧导航）

## 日志

`evidence/unit-0.8/`：cargo-test.log、fault-injection.log、thumbnail-test.log、npm-test.log、typecheck.log、build.log、stress.log / stress.json、screenshots-u04/u05/u06/u09.log、dependency-fetch.log、tauri-lockfile.log。
