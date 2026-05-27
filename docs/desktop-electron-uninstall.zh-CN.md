# Aether Desktop 卸载备忘

本文记录用户在各个平台卸载 Aether Desktop（Electron 版桌面端）的操作方式，以及卸载后哪些数据会保留、哪些数据可按需手动清理。

当前配置下，卸载 Aether Desktop 只会移除桌面应用本体和安装器管理的系统集成；默认不会删除 Aether 的共享数据目录。原因是这些目录也被 Aether Web/CLI 使用，自动删除会影响已有用户。

## 卸载前

卸载前先退出 Aether Desktop。若应用仍在运行，安装器或包管理器可能无法完整移除应用文件。

如果用户只想卸载桌面端，通常只需要移除应用本体，并保留共享数据。这样之后继续使用 Aether Web/CLI，或重新安装 Aether Desktop，都可以复用原来的配置、登录态、数据库和缓存。

## macOS

### 卸载应用

1. 退出 Aether Desktop。
2. 打开 Finder 的“应用程序”。
3. 将 `Aether Desktop.app` 移到废纸篓。

典型应用路径：

```text
/Applications/Aether Desktop.app
```

如果用户没有拖入“应用程序”，而是从其他目录或 DMG 中运行，则删除实际保存的 `Aether Desktop.app` 即可。

### 只清理桌面端状态

如只想清理 Electron 桌面壳产生的状态，而保留 Web/CLI 数据，可以删除：

```text
/Users/<user>/.local/share/aether/desktop/
```

这个目录包含 Desktop 的 Electron `userData`、日志、sidecar pid、更新器 staging id，以及 Chromium 内部缓存。

### 清理自动更新缓存

如要清理自动更新下载缓存，可删除：

```text
/Users/<user>/Library/Caches/<updaterCacheDirName>/
```

`<updaterCacheDirName>` 由 electron-builder 生成，当前规则来自包名，形如 `<sanitized package name>-updater`。

### 彻底清理 Aether 数据

只有在确认不再使用 Aether Web/CLI 时，才删除共享数据：

```text
/Users/<user>/.local/share/aether/
/Users/<user>/.config/aether/
/Users/<user>/.cache/aether/
/Users/<user>/.local/state/aether/
/Users/<user>/.aether/
```

如果曾通过 Desktop 安装过 CLI，也可按需删除：

```text
/Users/<user>/.opencode/bin/opencode
```

## Windows

### 卸载应用

1. 退出 Aether Desktop。
2. 打开“设置” -> “应用” -> “已安装的应用”。
3. 找到 `Aether Desktop`，点击卸载。

也可以通过“控制面板” -> “程序和功能”卸载；如果安装在自定义目录，也可以运行安装目录中的卸载程序。

典型安装目录：

```text
C:\Users\<user>\AppData\Local\Programs\Aether Desktop\
```

卸载会移除应用安装目录和安装器创建的快捷方式，例如：

```text
C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Aether Desktop.lnk
C:\Users\<user>\Desktop\Aether Desktop.lnk
```

### 只清理桌面端状态

如只想清理 Electron 桌面壳状态，而保留 Web/CLI 数据，可以删除：

```text
C:\Users\<user>\.local\share\aether\desktop\
```

### 清理自动更新缓存

如要清理自动更新下载缓存，可删除：

```text
C:\Users\<user>\AppData\Local\<updaterCacheDirName>\
```

### 彻底清理 Aether 数据

只有在确认不再使用 Aether Web/CLI 时，才删除：

```text
C:\Users\<user>\.local\share\aether\
C:\Users\<user>\.config\aether\
C:\Users\<user>\.cache\aether\
C:\Users\<user>\.local\state\aether\
C:\Users\<user>\.aether\
```

### WSL 模式

如果用户启用了 WSL 模式，需要分 Windows 侧和 WSL 侧处理。

Windows 侧的 Electron 桌面壳状态仍在：

```text
C:\Users\<user>\.local\share\aether\desktop\
```

WSL 侧的 CLI/server 数据在 WSL 用户目录中：

```text
/home/<wsl-user>/.local/share/aether/
/home/<wsl-user>/.config/aether/
/home/<wsl-user>/.cache/aether/
/home/<wsl-user>/.local/state/aether/
```

WSL 模式缺少 CLI 时会在 WSL 内安装到：

```text
/home/<wsl-user>/.opencode/bin/opencode
```

如只卸载 Windows 桌面应用，不需要删除 WSL 侧数据；只有确认不再在 WSL 中使用 Aether 时，才清理这些目录。

## Linux

Linux 有 AppImage、deb 和 rpm 三种安装方式。

### AppImage

AppImage 不会固定安装到系统目录。卸载方式是：

1. 退出 Aether Desktop。
2. 删除用户保存的 AppImage 文件。

例如：

```text
/path/to/aether-linux-<arch>.AppImage
```

如果使用 AppImageLauncher 或手动创建过桌面集成，再按需删除对应的 `.desktop` 文件和图标：

```text
~/.local/share/applications/*aether*.desktop
~/.local/share/icons/hicolor/*/apps/*aether*.png
```

### deb

使用系统包管理器卸载：

```bash
sudo apt remove aether-desktop
```

也可以使用：

```bash
sudo dpkg -r aether-desktop
```

### rpm

使用系统包管理器卸载：

```bash
sudo dnf remove aether-desktop
```

也可以使用：

```bash
sudo rpm -e aether-desktop
```

### deb/rpm 会移除的系统文件

deb/rpm 卸载会移除包管理器安装的系统文件，典型包括：

```text
/opt/Aether Desktop/
/usr/bin/<linux executable>
/usr/share/applications/<linux executable>.desktop
/usr/share/icons/hicolor/<size>/apps/<linux executable>.png
/etc/apparmor.d/<linux executable>
```

其中 `/usr/bin/<linux executable>` 通常由 `update-alternatives` 或符号链接指向 `/opt/Aether Desktop/<linux executable>`。

### 只清理桌面端状态

如只想清理 Electron 桌面壳状态，而保留 Web/CLI 数据，可以删除：

```text
/home/<user>/.local/share/aether/desktop/
```

### 清理自动更新缓存

如要清理自动更新下载缓存，可删除：

```text
${XDG_CACHE_HOME:-/home/<user>/.cache}/<updaterCacheDirName>/
```

### 彻底清理 Aether 数据

只有在确认不再使用 Aether Web/CLI 时，才删除共享数据：

```text
/home/<user>/.local/share/aether/
/home/<user>/.config/aether/
/home/<user>/.cache/aether/
/home/<user>/.local/state/aether/
/home/<user>/.aether/
```

## Beta 和 Dev 构建

如果安装的是 beta 或 dev 构建，应用名和包名会不同：

```text
Aether Desktop Beta
Aether Desktop Dev
```

Linux 包名对应为：

```text
aether-desktop-beta
aether-desktop-dev
```

卸载命令需要替换包名，例如：

```bash
sudo apt remove aether-desktop-beta
sudo dnf remove aether-desktop-dev
```

## 保留与删除建议

推荐默认卸载方式是只移除应用本体，保留共享数据。这样不会影响 Aether Web/CLI，也便于重新安装 Desktop 后继续使用原有环境。

只有在用户明确要彻底移除 Aether，并确认不再使用 Web/CLI、WSL 侧 CLI、项目配置、技能或历史数据时，才删除共享目录。
