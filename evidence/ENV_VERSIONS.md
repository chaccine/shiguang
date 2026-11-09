# ENV_VERSIONS（Unit-0 / 桌面 Linux box）

- 采集时间（UTC）：2026-11-09T05:57:32Z
- OS：Linux 6.12.113+ x86_64
- rustc：rustc 1.90.0 (1159e78c4 2025-09-14)
- cargo：cargo 1.90.0 (840b83a10 2025-07-30)
- node：v24.22.1
- npm：11.21.1
- 验收固定时钟：SHIGUANG_CLOCK=2026-11-09T10:00:00Z
- SHIGUANG_SEED：20261109
- pkg-config：未安装（command -v pkg-config 无结果）
- webkit2gtk-4.1 / gtk+-3.0：无法通过 pkg-config 探测；环境无 sudo/apt/全局安装权限
- Tauri 构建：BLOCKED，详见 evidence/tauri-cargo-check.log 与 UNIT0_REPORT.md
- Android / 第二桌面 OS：NOT_RUN

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
