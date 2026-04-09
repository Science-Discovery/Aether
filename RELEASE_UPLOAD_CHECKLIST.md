# 上传 Release 资产清单

发布前快速核对各平台产物与元数据，避免漏传或通道混传。

## 目的

- 记录根目录 6 个发布脚本的产物路径和 `yml` 路径
- 确保 `desktop` 走 `latest`，`web` 走 `latest-web`

## 脚本与产物对照

| 脚本                          | 资产文件（Asset）                                                                      | 元数据文件（YML）                                 |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `release-mac-desktop.sh`      | `packages/desktop-electron/dist/*-mac-arm64.dmg`（或匹配 `*mac*arm64*.dmg`）           | `packages/desktop-electron/dist/latest-mac.yml`   |
| `release-linux-desktop.sh`    | `packages/desktop-electron/dist/*-linux-x64.AppImage`（或匹配 `*linux*x64*.AppImage`） | `packages/desktop-electron/dist/latest-linux.yml` |
| `release-windows-desktop.bat` | `packages/desktop-electron/dist/aether-win-x64.exe`（或匹配 `*win*x64*.exe`）          | `packages/desktop-electron/dist/latest.yml`       |
| `release-mac-web.sh`          | `packages/opencode/dist/aether-darwin-arm64-web.dmg`                                   | `packages/opencode/dist/latest-web-mac.yml`       |
| `release-linux-web.sh`        | `packages/opencode/dist/aether-linux-x64.zip`                                          | `packages/opencode/dist/latest-web-linux.yml`     |
| `release-windows-web.bat`     | `packages/opencode/dist/aether-windows-x64.zip`                                        | `packages/opencode/dist/latest-web-windows.yml`   |

## 上传策略

- `desktop` 渠道（`latest`）：上传 3 个桌面安装包 + 3 个桌面 `yml`
  - mac：`.dmg` + `latest-mac.yml`
  - linux：`.AppImage` + `latest-linux.yml`
  - windows：`.exe` + `latest.yml`
- `web` 渠道（`latest-web`）：上传 3 个 web 分发包 + 3 个 web `yml`
  - mac：`aether-darwin-arm64-web.dmg` + `latest-web-mac.yml`
  - linux：`aether-linux-x64.zip` + `latest-web-linux.yml`
  - windows：`aether-windows-x64.zip` + `latest-web-windows.yml`

## 发布前检查

- 6 个脚本都成功执行，终端输出 `Done`
- 每个 `yml` 的 `version` 与本次 Release 版本一致
- 每个 `yml` 的 `url` 与上传资产文件名完全一致
- 每个 `yml` 的 `sha512` 与 `size` 已生成且非空
- `desktop` 与 `web` 资产未混传到错误通道
