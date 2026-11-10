# 0.1.3 热修复：Android 启动「数据暂时无法打开 (IO_ERROR) try_lock() not supported」

- 根因：Rust 1.90 std 的 `File::try_lock` 只在 linux/macOS/Windows/*BSD/fuchsia 实现，Android 恒返回 `ErrorKind::Unsupported`；0.1.2 的 open_exclusive/.write.lock 把它当 IO_ERROR 抛出 → 启动全屏拦截。
- 修复：`core/src/lock.rs`。系统锁可用时行为不变；仅在 Unsupported 时回落到可移植锁（进程内注册表 + `<name>.owner` create_new 旁路文件，pid+starttime 过期检测；无 /proc 时绝不抢锁）。
- 测试：cargo 93/93、fault-injection 106/106（含 6 单元 + 6 集成 Unsupported 模拟）、npm 79/79、typecheck、run_acceptance.sh、aarch64-linux-android cargo check。
- CI：https://github.com/chaccine/shiguang/actions/runs/42623338065 （7/7 绿，fbf8804）
- APK：拾光_0.1.3_arm64-debug.apk，versionCode 1003，sha256 cc1f5b94a59df45947dc0502c5bd705d393503df31a7d9fe10331049fdd4b484，证书 SHA-256 59dbe106…766f（与 0.1.1/0.1.2 相同）
- dmg sha256 56dca8b94773c1701244c1fdc1884f1606fb3abcb76c305c87d2d8a60b7ea23f；msi sha256 e95dd8573228358e7bb3fcd92387fe8a15f482fb1338196c879171f5189f0c29
- 真机：NOT_RUN
