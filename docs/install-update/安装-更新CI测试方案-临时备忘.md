# 安装与更新 CI 测试方案临时备忘

> 临时备忘文档。基于当前讨论结果整理，供后续审阅、拆分和落地为手动触发 CI。

我重新按你的定义收窄了：自动更新测试不应该绕过程序 UI，也不应该直接用 API/脚本替代“程序内弹窗”。CI 只负责像用户一样安装旧版本、启动程序、等待程序自己检查更新、处理弹窗、按弹窗给出的路径继续操作，然后验证启动结果。

我复核到的关键点：

- Web 自动更新：前端启动后默认会立即检查更新，发现更新后下载，下载完成后弹出应用内 toast。用户点“更新并重启”后进入更新对话框，安装完成后 `window.location.reload()` 原地刷新。
- Electron 自动更新：启动 10 秒后检查更新。
  - Windows、Linux AppImage：先下载，弹出原生对话框 `Update Ready`，按钮是 `Restart` / `Later`。
  - macOS、Linux 非 AppImage：只弹出 `Update Available`，按钮是 `Open GitHub Releases` / `Later`，用户需要去 GitHub 手动下载安装。
- Electron prerelease 开关：只要 `~/.config/aether/update-config.jsonc` 存在即可。
- Web beta 更新源：`~/.config/aether/update-config.jsonc` 需要写 `updateBaseUrl: https://aether.aiphys.cn/downloadbeta`。
- PR #985 合并后，Web GitHub Release 产物内的用户入口是 `install.sh` / `install.command` / `install.bat`。
- 我现场复核了网站：公开首页有 Windows x64、macOS arm64、Linux x64、Linux arm64 网站安装入口；没有 macOS x64 网站入口。`/download/installer/aether_darwin_x64_installer.command` 和 `/download/latest/mac-x64.yml` 当前是 404；`/downloadbeta/latest/mac-x64.yml` 当前存在。

## 统一规则

所有 case 都是 `workflow_dispatch` 手动触发。每个矩阵格独立 job，缺产物永远 `skip`，不 fail。

版本解析只用于决定 skip 和下载哪一个用户可见产物，不代替 UI 测试：

- Web 网站安装源：`https://aether.aiphys.cn/download/installer/...`
- Web 自动更新源：起点必须是网站 stable/latest；目标通过 `downloadbeta`。
- Web GitHub 安装/手动更新目标：最新 GitHub prerelease 中对应 Web 产物。
- Electron 自动更新起点：GitHub Releases 的最后一个 `latest` stable release；若没有 stable 或没有该平台产物，则 fallback prerelease，但该自动更新 case 直接 skip。
- Electron 手动更新目标：最新 GitHub prerelease 中对应 Desktop 产物。
- 任何平台/架构当前没有对应产物：该格写入 summary，标明 `skip: missing asset`。

## 通用通过标准

每个非 skip case 必须验证：

- 用户入口可获得：网站链接、GitHub release asset、或 updater 弹窗链接。
- 按默认方式安装，不传 `--path`，不改默认安装目录。
- 程序能启动。
- 能读到安装后的目标版本。
- Web：自动更新 case 必须观察到浏览器原页面原地 reload 并显示新版本；手动更新 case 不强求原地刷新，按对应流程验证更新后页面可重新启动并显示新版本。
- Electron：主窗口出现，sidecar 启动成功，更新后启动的是目标版本。
- 失败时上传：安装器日志、update state/result、Electron log、截图/录屏、默认安装目录结构、GitHub/网站产物解析结果。

## Web 矩阵流程

### W1 Windows x64 / 网站全新安装

1. 打开网站或直接访问 `/download/installer/aether_windows_installer.bat`，下载 `aether_windows_installer.bat`。
2. 像用户一样运行 bat，不传参数。
3. 等待默认目录 `%LOCALAPPDATA%\Programs\aether` 和 work 目录 `%USERPROFILE%\.local\share\aether\update\aether` 出现版本目录。
4. 等待 installer 默认启动 Aether。
5. 用浏览器连接启动后的本地页面，调用页面实际使用的 `/global/health` 或 `/global/web-update/current` 判断版本。
6. 通过：页面可用，版本等于网站 latest manifest，快捷方式/启动入口存在。

### W2 macOS arm64 / 网站全新安装

1. 下载 `/download/installer/aether_darwin_installer.command`。
2. 按网站说明授予执行权限并运行，不传参数。
3. 默认安装到 `~/Applications/aether`，work 目录为 `~/.local/share/aether/update/aether`。
4. 等待安装器启动 Web 端。
5. 浏览器打开本地页面，验证健康检查和版本。
6. 通过：页面可用，版本为 `/download/latest/mac-arm64.yml`，`~/Applications/aether/aether_<version>` 存在。

### W3 macOS x64 / 网站全新安装

- 当前 skip。
- skip 条件：网站无 macOS x64 安装入口，`/download/installer/aether_darwin_x64_installer.command` 当前 404，`/download/latest/mac-x64.yml` 当前 404。
- 未来如果公开网站补齐 x64 installer 和 manifest，则按 `W2` 同流程执行，架构改为 x64。

### W4 Linux x64 / 网站全新安装

1. 下载 `/download/installer/aether_linux_installer.sh`。
2. `chmod +x` 后运行，不传参数。
3. 默认安装到 `~/.local/share/applications/aether`，work 目录为 `~/.local/share/aether/update/aether`。
4. 等待默认启动。
5. 浏览器验证页面、健康检查和版本。
6. 通过：`~/.local/share/applications/aether/aether_<version>`、desktop entry、协议 handler 存在。

### W5 Linux arm64 / 网站全新安装

1. 下载 `/download/installer/aether_linux_arm64_installer.sh`。
2. `chmod +x` 后运行，不传参数。
3. 默认路径同 Linux x64。
4. 验证启动页面和版本。
5. 如果网站链接或 arm64 manifest 缺失，则 skip，不 fail。

### W6 Windows arm64 / 网站全新安装

- 当前 skip。
- 原因：Web 发布矩阵没有 Windows arm64 Web 产物，网站也没有 Windows arm64 installer。

### W7 Web GitHub 全新安装 / Windows x64

1. 解析最新 GitHub prerelease，查找 `aether-windows-x64.zip`。
2. 缺 asset 则 skip。
3. 下载 ZIP，按用户方式解压。
4. 进入 `aether-windows-x64` 目录，运行 PR #985 产物内 `install.bat`，不传参数。
5. 等待默认启动。
6. 验证页面可用，版本等于 prerelease tag 版本，默认目录和快捷方式存在。

### W8 Web GitHub 全新安装 / macOS arm64、macOS x64

1. 解析最新 prerelease，分别查找 `aether-darwin-arm64.dmg`、`aether-darwin-x64.dmg`。
2. 缺对应 asset 则 skip。
3. 挂载 DMG，打开 `aether-darwin-<arch>`。
4. 运行产物内 `install.command`，不传参数。
5. 等待默认启动。
6. 验证页面可用，版本等于 prerelease，默认 mirror 为 `~/Applications/aether`。
7. macOS x64 只在 GitHub 流程测；网站流程仍 skip，除非公开网站补齐 x64。

### W9 Web GitHub 全新安装 / Linux x64、Linux arm64

1. 解析最新 prerelease，查找 `aether-linux-x64.zip` 或 `aether-linux-arm64.zip`。
2. 缺 asset 则 skip。
3. 解压，进入 `aether-linux-<arch>`。
4. `chmod +x install.sh`，运行 `./install.sh`，不传参数。
5. 等待默认启动。
6. 验证页面、版本、desktop entry、协议 handler。

### W10 Web 自动更新 / Windows x64、macOS arm64、Linux x64、Linux arm64

1. 先执行对应网站全新安装流程，安装公开 stable/latest。
2. 在默认配置目录创建 `update-config.jsonc`：

```jsonc
{
  "updateBaseUrl": "https://aether.aiphys.cn/downloadbeta"
}
```

3. 启动旧版本 Aether，打开浏览器页面，保持该页面不关闭。
4. 不直接调用 update API，不打开设置页手动检查；等待启动默认检查。
5. 预期行为：页面出现“有可用更新 / Update available” toast。
6. CI 像用户一样点击 toast 的“更新并重启 / Update & Restart”。
7. 预期进入更新对话框，状态经历 checking/downloading/downloaded/installing。
8. 等待程序关闭旧版本、安装 downloadbeta 版本、重新启动。
9. 通过：同一个浏览器页面最终原地 reload，健康检查版本变为 downloadbeta 版本，页面可继续操作。
10. 若对应网站 stable 不存在、downloadbeta manifest 不存在、或 downloadbeta 版本不高于 stable：该平台 skip。

### W11 Web 自动更新 / macOS x64、Windows arm64

- macOS x64 当前 skip：没有网站 stable 起点，即使 downloadbeta 有 `mac-x64.yml`，也不能构造“从网站最新版更新”的用户场景。
- Windows arm64 当前 skip：无 Web 产物。

### W12 Web 手动更新 / 有网站起点的平台

适用：Windows x64、macOS arm64、Linux x64、Linux arm64。

1. 先按网站全新安装流程安装公开 stable/latest。
2. 启动旧版本，打开浏览器页面确认旧版本可用。
3. 像用户手动更新前的常见行为一样，关闭旧应用的浏览器页面。
4. 下载最新 GitHub prerelease 对应 Web asset。
5. Windows：解压 `aether-windows-x64.zip`，运行 `install.bat`。
6. macOS arm64：挂载 `aether-darwin-arm64.dmg`，运行 `install.command`。
7. Linux：解压 `aether-linux-<arch>.zip`，运行 `install.sh`。
8. 全程不传 `--path` / `--no-restart`。
9. 通过：安装脚本默认重启 Aether，浏览器可以打开更新后的 Aether 页面，页面可用且版本为 prerelease；该 case 不要求旧浏览器页面原地刷新。
10. macOS x64 当前 skip，除非你决定新增“GitHub stable -> GitHub prerelease”的独立手动更新场景；按现在“Web 从网站最新版开始”的定义，它没有网站起点。

## Electron 矩阵流程

### E1 Electron GitHub 全新安装 / Windows x64、Windows arm64

1. 解析最新 GitHub prerelease 的 `.exe` NSIS asset。
2. 缺对应 arch asset 则 skip。
3. 运行 installer，使用默认安装向导选项，不指定安装目录。
4. 安装完成后从默认入口启动 Aether Desktop。
5. 通过：主窗口出现，sidecar 健康，版本等于 prerelease。

### E2 Electron GitHub 全新安装 / macOS arm64、macOS x64

1. 解析最新 prerelease 的对应 `.dmg`。
2. 缺 asset 则 skip。
3. 挂载 DMG，按用户默认方式把 Aether Desktop app 放到 `/Applications`。
4. 从 `/Applications` 启动。
5. 通过：主窗口出现，sidecar 健康，版本等于 prerelease。

### E3 Electron GitHub 全新安装 / Linux x64、Linux arm64 AppImage

1. 解析最新 prerelease 的 `.AppImage`。
2. 缺 asset 则 skip。
3. 下载，授予执行权限，直接运行 AppImage。
4. 通过：主窗口出现，sidecar 健康，版本等于 prerelease。

### E4 Electron GitHub 全新安装 / Linux x64、Linux arm64 deb/rpm

1. 解析最新 prerelease 的 `.deb` 或 `.rpm`。
2. 缺 asset 则 skip。
3. 用系统默认包管理方式安装：Ubuntu 用 `.deb`，RPM runner 用 `.rpm`。
4. 从系统应用入口或包安装后的命令启动。
5. 通过：主窗口出现，sidecar 健康，版本等于 prerelease。

### E5 Electron 自动更新 / Windows x64、Windows arm64

1. 解析 GitHub latest stable release 中对应 `.exe`，没有则 fallback prerelease 并 skip 自动更新。
2. 安装 stable，使用默认安装向导。
3. 创建 `~/.config/aether/update-config.jsonc`，内容为 `{}`。
4. 启动 Aether Desktop。
5. 不手动调用 updater，不点设置页；等待启动后 10 秒自动检查。
6. 预期行为：自动下载完成后出现原生 `Update Ready` 弹窗，内容为 `Update <version> downloaded. Restart now?`，按钮 `Restart` / `Later`。
7. CI 点击 `Restart`。
8. 通过：应用退出并重启到 prerelease 版本，主窗口可用，sidecar 健康。
9. 若 stable 缺失、目标 prerelease 缺失、或目标不高于 stable：skip。

### E6 Electron 自动更新 / Linux x64、Linux arm64 AppImage

1. 下载并运行 latest stable AppImage；没有 stable 则 fallback prerelease 并 skip。
2. 创建 `~/.config/aether/update-config.jsonc`，内容 `{}`。
3. 启动 AppImage。
4. 等待自动检查和下载。
5. 预期出现 `Update Ready` 原生弹窗。
6. 点击 `Restart`。
7. 通过：AppImage 更新后重启，主窗口和 sidecar 可用，版本为 prerelease。
8. 缺 AppImage 或 updater 没有可用 metadata：skip。

### E7 Electron 自动更新 / macOS arm64、macOS x64

1. 安装 latest stable DMG 到 `/Applications`；没有 stable 则 fallback prerelease 并 skip 自动更新。
2. 创建 `~/.config/aether/update-config.jsonc`，内容 `{}`。
3. 启动 Aether Desktop，等待自动检查。
4. 预期出现原生 `Update Available` 弹窗，内容说明 macOS 不支持自动下载安装，按钮为 `Open GitHub Releases` / `Later`。
5. 点击 `Open GitHub Releases`。
6. 验证系统浏览器打开 `https://github.com/Science-Discovery/Aether/releases/tag/v<version>`。
7. 像用户一样下载该 tag 的 macOS DMG，挂载并替换 `/Applications` 中的 app。
8. 启动新 app。
9. 通过：弹窗和链接正确，手动安装后主窗口可用，版本为 prerelease。

### E8 Electron 自动更新 / Linux deb/rpm

1. 用 latest stable `.deb` 或 `.rpm` 默认安装；没有 stable 则 fallback prerelease 并 skip 自动更新。
2. 创建 `~/.config/aether/update-config.jsonc`，内容 `{}`。
3. 启动 Aether Desktop，等待自动检查。
4. 预期出现 `Update Available` 原生弹窗，说明只有 AppImage 支持自动下载安装，deb/rpm 需要用包管理器升级。
5. 点击 `Open GitHub Releases`。
6. 验证浏览器打开目标 tag。
7. 下载该 tag 的 `.deb` 或 `.rpm`，用默认包管理方式升级。
8. 重新启动 Aether Desktop。
9. 通过：弹窗和链接正确，升级后主窗口可用，版本为 prerelease。

### E9 Electron 手动更新 / Windows

1. 安装 latest stable `.exe`；若没有 stable，可安装 fallback prerelease 但手动更新 skip。
2. 启动一次，确认旧版本可用。
3. 下载最新 prerelease `.exe`。
4. 运行 installer，使用默认安装向导。
5. 从默认入口启动。
6. 通过：版本变为 prerelease，主窗口和 sidecar 可用。

### E10 Electron 手动更新 / macOS

1. 安装 latest stable DMG 到 `/Applications`；没有 stable 则 skip。
2. 启动旧版本确认可用。
3. 下载最新 prerelease DMG。
4. 按默认用户方式挂载并替换 `/Applications` app。
5. 启动新版本。
6. 通过：版本变为 prerelease，主窗口和 sidecar 可用。

### E11 Electron 手动更新 / Linux AppImage

1. 下载 latest stable AppImage，授权并运行，确认旧版本可用。
2. 下载 latest prerelease AppImage。
3. 按用户方式替换/运行新 AppImage，不指定自定义路径。
4. 通过：新 AppImage 主窗口和 sidecar 可用，版本为 prerelease。

### E12 Electron 手动更新 / Linux deb/rpm

1. 用 latest stable `.deb` 或 `.rpm` 默认安装。
2. 启动旧版本确认可用。
3. 下载 latest prerelease `.deb` 或 `.rpm`。
4. 用默认包管理方式升级。
5. 启动新版本。
6. 通过：版本变为 prerelease，主窗口和 sidecar 可用。
