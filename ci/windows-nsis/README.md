# Windows NSIS 工具（仅 CI 打包，离线预置）

避免 `tauri build --bundles nsis` 在 GitHub Releases 上对 `nsis_tauri_utils.dll` 或 `nsis-3.13.zip` 遇到 504。

| 文件 | 来源 | 校验 |
| --- | --- | --- |
| `nsis-3.13.zip` | https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip | SHA-1 `DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E`（与 tauri-bundler 固定值一致） |
| `nsis_tauri_utils.dll` | https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll | SHA-1 `75197FEE3C6A814FE035788D1C34EAD39349B860`（与 tauri-bundler 0.5.3 固定值一致） |

CI 在 Windows job 里把它们放到 `%LOCALAPPDATA%\tauri\NSIS\`（dll 放到 `Plugins\x86-unicode\additional\`），再跑 `tauri build --bundles msi,nsis`。

## 许可

- `nsis_tauri_utils`：Apache License 2.0，https://github.com/tauri-apps/nsis-tauri-utils
- `nsis-3.13.zip`：由 Tauri `binary-releases` 提供的 NSIS 3.13 工具包，仅用于在 CI 中按上游校验值复现官方打包环境。NSIS 本身遵循其 zlib/自定义许可。
