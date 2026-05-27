# Aether Desktop 目录结构备忘

本文记录用户安装并使用 Aether Desktop（Electron 版桌面端）后，系统和用户目录中会出现的主要 Aether 相关文件与目录。

Aether Desktop 的主数据目录与 Web/CLI 共用。默认情况下，三平台都会使用 XDG 风格目录：

```text
<data>   = ~/.local/share/aether
<config> = ~/.config/aether
<cache>  = ~/.cache/aether
<state>  = ~/.local/state/aether
```

如果用户设置了 `XDG_DATA_HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 或 `XDG_STATE_HOME`，对应根目录会改为环境变量指定的位置。下面的目录树均按默认值展示。

## 共享运行数据

Desktop 首次运行时会复用已有 Web/CLI 数据；没有旧数据时会创建同一套目录。常见结构如下：

```text
~/
├── .local/share/aether/
│   ├── desktop/
│   │   ├── logs/
│   │   │   └── main.log
│   │   ├── sidecar.pid
│   │   ├── .updaterId
│   │   └── <Electron/Chromium 内部数据>
│   │       ├── Cookies*
│   │       ├── Local Storage/
│   │       ├── Session Storage/
│   │       ├── IndexedDB/
│   │       ├── Cache/
│   │       ├── Code Cache/
│   │       ├── GPUCache/
│   │       ├── Preferences
│   │       └── Network Persistent State
│   ├── aether.db
│   ├── aether.db-wal
│   ├── aether.db-shm
│   ├── latest/
│   │   ├── aether-cron.db*
│   │   └── aether-<project-id>.db*
│   ├── auth.json
│   ├── mcp-auth.json
│   ├── storage/
│   ├── reading-mode/
│   ├── cron/
│   ├── worktree/
│   ├── plans/
│   ├── snapshot/
│   ├── memory/
│   ├── tool-output/
│   ├── backup/
│   ├── corrupt/
│   ├── log/
│   ├── .bin/
│   ├── aether.global.dat
│   ├── aether.settings
│   ├── default.dat
│   └── aether.workspace.<id>.dat
├── .config/aether/
│   ├── config.json
│   ├── aether.jsonc
│   ├── aether.json
│   ├── AGENTS.md
│   ├── skills/
│   ├── agent/
│   ├── command/
│   └── themes/
├── .cache/aether/
│   ├── version
│   ├── bin/
│   ├── models.json
│   ├── skills/
│   ├── node_modules/
│   └── package.json
└── .local/state/aether/
    ├── model.json
    ├── kv.json
    ├── prompt-history.jsonl
    ├── prompt-stash.jsonl
    ├── frecency.jsonl
    ├── migration-v1.json
    ├── legacy-db.json
    └── legacy-db-merge.json
```

说明：

- `~/.local/share/aether/desktop` 是 Electron 桌面壳专用目录，包含 Electron `userData`、日志、sidecar pid 和更新器 staging id。
- `aether.db` 是默认主数据库；SQLite 运行中可能同时出现 `aether.db-wal` 和 `aether.db-shm`。
- `latest/aether-cron.db*` 与 `latest/aether-<project-id>.db*` 是通道/项目级数据库，实际出现取决于使用过的功能。
- `backup/` 和 `corrupt/` 只会在迁移、拆分或数据库恢复流程中出现。
- `aether.global.dat`、`aether.settings`、`default.dat`、`aether.workspace.<id>.dat` 是 Desktop 使用的 Electron store 文件；其中共享 store 放在 `<data>` 根目录，避免和 Web/CLI 数据割裂。
- Electron/Chromium 内部数据的具体文件名会随 Electron 版本和用户操作变化，不作为 Aether 稳定接口；稳定入口是 `~/.local/share/aether/desktop`。

## macOS

用户从 DMG 安装后，通常会把应用拖入 `/Applications`：

```text
/Applications/Aether Desktop.app/
└── Contents/
    ├── MacOS/Aether Desktop
    └── Resources/
        ├── opencode-cli
        ├── app-update.yml
        ├── .aether/
        │   ├── skills/
        │   ├── agent/
        │   ├── command/
        │   └── themes/
        ├── native/
        └── Update/
```

运行后的用户数据使用前文的共享结构，展开到 macOS 即：

```text
/Users/<user>/
├── .local/share/aether/
├── .config/aether/
├── .cache/aether/
└── .local/state/aether/
```

自动更新下载缓存位于 macOS 系统缓存目录：

```text
/Users/<user>/Library/Caches/<updaterCacheDirName>/
└── pending/
    ├── <downloaded update artifact>
    ├── update-info.json
    └── current.blockmap
```

`<updaterCacheDirName>` 由 electron-builder 生成，当前规则来自包名，形如 `<sanitized package name>-updater`。

## Windows

Windows 使用 NSIS 安装器。默认是当前用户安装，且安装器允许用户更改安装目录。常见默认位置为：

```text
C:\Users\<user>\AppData\Local\Programs\Aether Desktop\
├── Aether Desktop.exe
└── resources\
    ├── opencode-cli.exe
    ├── app-update.yml
    ├── .aether\
    │   ├── skills\
    │   ├── agent\
    │   ├── command\
    │   └── themes\
    └── Update\
```

安装器还会创建快捷方式，典型路径如下：

```text
C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Aether Desktop.lnk
C:\Users\<user>\Desktop\Aether Desktop.lnk
```

Windows 原生模式运行后，默认用户数据结构为：

```text
C:\Users\<user>\
├── .local\share\aether\
│   └── desktop\
├── .config\aether\
├── .cache\aether\
└── .local\state\aether\
```

完整子目录与文件见“共享运行数据”一节。

自动更新下载缓存位于：

```text
C:\Users\<user>\AppData\Local\<updaterCacheDirName>\
└── pending\
    ├── <downloaded update artifact>
    ├── update-info.json
    └── current.blockmap
```

如果用户启用了 WSL 模式，需要分两侧看：

```text
# Windows 侧，Electron 壳仍会写入
C:\Users\<user>\.local\share\aether\desktop\

# WSL 侧，CLI/server 进程使用 WSL 用户目录
/home/<wsl-user>/
├── .opencode/bin/opencode
├── .local/share/aether/
├── .config/aether/
├── .cache/aether/
└── .local/state/aether/
```

WSL 模式缺少 CLI 时会在 WSL 内安装到 `~/.opencode/bin/opencode`。这是当前 WSL 脚本的兼容路径，不是 Windows 原生 sidecar 的位置。

## Linux

Linux 提供 AppImage、deb 和 rpm。

AppImage 不会固定安装到系统目录，文件由用户放置：

```text
/path/chosen/by/user/aether-linux-<arch>.AppImage
/tmp/.mount_*    # 运行时临时挂载，退出后消失
```

deb/rpm 由包管理器安装到系统目录。当前配置包名是 `aether-desktop`：

```text
/opt/Aether Desktop/
├── <linux executable>
└── resources/
    ├── opencode-cli
    ├── app-update.yml
    ├── apparmor-profile
    ├── .aether/
    │   ├── skills/
    │   ├── agent/
    │   ├── command/
    │   └── themes/
    └── Update/

/usr/bin/<linux executable>
/usr/share/applications/<linux executable>.desktop
/usr/share/icons/hicolor/<size>/apps/<linux executable>.png
/etc/apparmor.d/<linux executable>
```

`/usr/bin/<linux executable>` 通常由 `update-alternatives` 或符号链接指向 `/opt/Aether Desktop/<linux executable>`。`/etc/apparmor.d/<linux executable>` 只在相关发行版和安装流程支持时出现。

运行后的用户数据结构为：

```text
/home/<user>/
├── .local/share/aether/
│   └── desktop/
├── .config/aether/
├── .cache/aether/
└── .local/state/aether/
```

完整子目录与文件见“共享运行数据”一节。

自动更新下载缓存位于：

```text
${XDG_CACHE_HOME:-/home/<user>/.cache}/<updaterCacheDirName>/
└── pending/
    ├── <downloaded update artifact>
    ├── update-info.json
    └── current.blockmap
```

## 项目目录

用户在 Desktop 中打开或使用某个项目后，项目自身也可能出现 Aether 目录：

```text
<project>/
├── .aether/
│   ├── skills/
│   ├── agent/
│   ├── command/
│   └── <project config files>
└── .aether-kb/
```

旧版 `.opencode/` 和 `.opencode-kb/` 可能仍被读取或迁移，但新目录名优先使用 `.aether/` 与 `.aether-kb/`。

## 已有 Web/CLI 用户与新用户

已有 Web/CLI 用户通常已经存在：

```text
~/.local/share/aether
~/.config/aether
~/.cache/aether
~/.local/state/aether
```

Desktop 首次启动时会复用这些目录和其中的数据库、配置、登录态、模型偏好、缓存等内容。Desktop 主要额外创建：

```text
~/.local/share/aether/desktop/
~/.local/share/aether/desktop/logs/
~/.local/share/aether/desktop/sidecar.pid
~/.local/share/aether/desktop/.updaterId
```

全新用户则会由 Desktop 和 sidecar 在首次启动、登录、打开项目、发起会话、检查更新等操作中逐步创建上述目录。目录布局与已有 Web/CLI 用户一致，差异只是“复用已有内容”还是“首次创建内容”。

## 其他可能目录

部分功能会使用额外目录：

```text
~/.aether/
├── skills/
├── skill-sessions/
├── skill-snapshots/
└── skill-evolution-config.json
```

移动端接入或桥接类功能可能使用平台传统应用支持目录：

```text
# macOS
~/Library/Application Support/aether/<subsystem>/

# Windows
%APPDATA%\aether\<subsystem>\

# Linux
~/.local/share/aether/<subsystem>/
```

托管/系统级配置读取位置如下；普通 Desktop 使用不会主动创建这些目录：

```text
# macOS
/Library/Application Support/aether/

# Windows
C:\ProgramData\aether\

# Linux
/etc/aether/
```
