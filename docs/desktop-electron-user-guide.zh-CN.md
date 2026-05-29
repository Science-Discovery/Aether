# Aether Desktop 下载、安装与更新

本文档说明 Aether Desktop（Electron 桌面版）的下载、安装和更新方式。

桌面版与 Aether Web/CLI 共用同一套本地数据目录。已经使用过 Web/CLI 的用户，安装桌面版后通常可以继续使用已有登录状态、会话和配置；新用户则会从空数据目录开始。

---

## 下载

从 [GitHub Releases](https://github.com/Science-Discovery/Aether/releases) 下载对应平台的 **Aether Desktop** 安装包。

普通用户建议下载最新的正式 Release。GitHub 页面上如果同时出现预发布版本，请只在明确需要试用新版本时下载；预发布版本使用同一套 Aether Desktop 应用和数据目录，后续正式版本发布后可以继续升级。

| 平台 | 推荐文件 |
|---|---|
| Windows x64 | Desktop 的 Windows x64 `.exe` 安装包 |
| Windows ARM64 | Desktop 的 Windows ARM64 `.exe` 安装包 |
| macOS Apple Silicon | Desktop 的 macOS arm64 `.dmg` |
| macOS Intel | Desktop 的 macOS x64 `.dmg` |
| Linux x64 | Desktop 的 Linux x64 `.AppImage` / `.deb` / `.rpm` |
| Linux ARM64 | Desktop 的 Linux ARM64 `.AppImage` / `.deb` / `.rpm` |

Release 中也会包含 Web 浏览器版压缩包。桌面版用户请下载 `.exe`、`.dmg`、`.AppImage`、`.deb` 或 `.rpm`，不要下载 Web 版 `.zip`。

---

## 安装与启动

### Windows

双击下载的 `.exe` 安装包，按安装向导完成安装。安装后从开始菜单或桌面快捷方式启动 `Aether Desktop`。

如果系统或杀毒软件提示风险，请确认文件来自官方 GitHub Release 后再继续。

### macOS

打开下载的 `.dmg`，将 `Aether Desktop.app` 拖入 `Applications`。

首次启动时，如果 macOS 提示应用无法打开，可在系统设置中允许打开，或右键点击应用后选择打开。

### Linux

AppImage：

```bash
chmod +x ./aether-*.AppImage
./aether-*.AppImage
```

deb：

```bash
sudo apt install ./aether-desktop*.deb
```

rpm：

```bash
sudo dnf install ./aether-desktop*.rpm
```

安装完成后，从系统应用菜单启动 `Aether Desktop`。

---

## 已有 Web/CLI 用户

Aether Desktop 默认使用：

```text
~/.local/share/aether
```

Windows 上对应：

```text
%USERPROFILE%\.local\share\aether
```

如果你已经使用过 Aether Web/CLI，桌面版会直接复用这个目录中的数据，包括登录状态、会话、MCP 授权和本地数据库。

桌面版会额外创建：

```text
~/.local/share/aether/desktop
```

该目录只保存桌面窗口状态、日志和后台进程信息，不会影响 Web/CLI。

注意：Windows 的 WSL 模式使用 WSL 内部的 Linux 用户目录，与 Windows 侧 Web/CLI 数据不共享。

---

## 更新

Aether Desktop 默认只检查 GitHub 上的正式 Release。需要试用预发布版本的用户，可以在 Aether 配置目录中放置 `update-config.jsonc`；文件存在后，桌面端检查更新时会同时考虑 GitHub pre-release。该文件可以是一个空的合法 JSONC 文件：

```jsonc
{}
```

默认配置目录为：

```text
~/.config/aether/update-config.jsonc
```

如果设置了 `XDG_CONFIG_HOME`，则使用：

```text
$XDG_CONFIG_HOME/aether/update-config.jsonc
```

不再需要接收预发布版本时，删除这个文件即可。

### Windows

桌面版支持应用内更新。打开 `Aether Desktop` 后，使用菜单中的 `Check for Updates...` 检查更新；如果有新版本，应用会下载对应安装包并提示重启安装。启用预发布更新后，流程相同。

### macOS

macOS 当前采用手动更新。使用菜单中的 `Check for Updates...` 检查更新；如果有新版本，应用会打开对应的 GitHub Release 页面。

下载对应 `.dmg` 后，重新将 `Aether Desktop.app` 拖入 `Applications` 并覆盖旧版本即可。

### Linux

AppImage 支持应用内更新。使用菜单中的 `Check for Updates...` 检查更新，并按提示完成重启。

`.deb` 和 `.rpm` 当前采用手动更新。检查到新版本后，应用会打开对应的 GitHub Release 页面；下载新的安装包后，用包管理器升级：

```bash
sudo apt install ./aether-desktop*.deb
```

或：

```bash
sudo dnf install ./aether-desktop*.rpm
```

---

## 常见问题

**安装桌面版会覆盖 Web 版吗？**

不会。桌面版是独立应用，只复用同一个 Aether 数据目录。

**安装桌面版后为什么能看到以前的会话？**

这是预期行为。桌面版与 Web/CLI 共用 `~/.local/share/aether`。

**安装桌面版后 Web 版还能继续用吗？**

可以。Web/CLI 数据目录保持不变。

**我没有看到旧数据怎么办？**

请确认 Web/CLI 是否使用了自定义 `XDG_DATA_HOME`。桌面版默认读取 `~/.local/share/aether`；如果 Web/CLI 使用了自定义目录，需要用同一环境启动桌面版。
