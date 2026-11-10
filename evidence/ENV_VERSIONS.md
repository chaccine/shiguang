# ENV_VERSIONS（Unit-0 / 桌面 Linux box）

- 采集时间（UTC）：2026-11-10T03:13:00Z
- OS：Linux 6.12.113+ x86_64
- rustc：rustc 1.90.0 (1159e78c4 2025-09-14)
- cargo：cargo 1.90.0 (840b83a10 2025-07-30)
- node：v24.22.1
- npm：11.21.1
- 验收固定时钟：SHIGUANG_CLOCK=2026-11-09T10:00:00Z
- SHIGUANG_SEED：20261109
- box 缺 webkit2gtk（无 sudo），本机不构建桌面壳；Tauri 三端打包与 Android APK 由 GitHub Actions 构建
- 真机（Android / macOS / Windows）行为：见各单元报告，未实测项为 NOT_RUN

## 工具链原位输出

    $ rustc --version
    rustc 1.90.0 (1159e78c4 2025-09-14)
    $ cargo --version
    cargo 1.90.0 (840b83a10 2025-07-30)
    $ node --version
    v24.22.1
    $ npm --version
    11.21.1
    $ uname -srm
    Linux 6.12.113+ x86_64
