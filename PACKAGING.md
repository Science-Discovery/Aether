# 打包指南

本项目是一个 monorepo，包含两个可独立打包的产品：**CLI 命令行工具** 和 **Electron 桌面应用**，最终产品名称均为 **OpenResearch**。

---

## 前置准备

在根目录安装所有依赖：

```bash
bun install
```

---

## 一、CLI 工具打包

**位置：** `packages/opencode/`

CLI 工具使用 Bun 的 `compile` 功能构建，支持交叉编译到所有平台。构建产物为单个可执行二进制文件，命名为 `openresearch`。

### 仅构建当前平台

```bash
cd packages/opencode
bun run build -- --single
```

### 构建所有平台

```bash
cd packages/opencode
bun run build
```

### 输出目录

构建完成后，产物在 `packages/opencode/dist/` 下，按平台分目录。每个目录包含二进制文件和 web 资源：

```
openresearch-linux-x64/
  bin/
    openresearch        ← CLI 二进制
    web/                ← Web UI 静态资源（由 packages/app 构建）
      index.html
      assets/
      ...
```

| 目录 | 平台 |
|---|---|
| `openresearch-linux-x64/bin/` | Linux x64 (glibc) |
| `openresearch-linux-arm64/bin/` | Linux ARM64 |
| `openresearch-linux-x64-musl/bin/` | Linux x64 (musl) |
| `openresearch-darwin-x64/bin/` | macOS x64 |
| `openresearch-darwin-arm64/bin/` | macOS ARM64 (Apple Silicon) |
| `openresearch-windows-x64/bin/` | Windows x64 |

### 安装到系统

**必须将 `openresearch` 二进制和 `web/` 目录一起复制**，否则 `openresearch web` 会回退到显示远程版本：

```bash
# Linux 安装（复制二进制 + web 资源）
sudo cp dist/openresearch-linux-x64/bin/openresearch /usr/local/bin/
sudo cp -r dist/openresearch-linux-x64/bin/web /usr/local/bin/
```

卸载：
```bash
sudo rm /usr/local/bin/openresearch
sudo rm -rf /usr/local/bin/web
```

---

## 二、Electron 桌面应用打包

**位置：** `packages/desktop-electron/`

桌面应用使用 `electron-builder` 打包，生成各平台原生安装包，产品名为 **OpenResearch**。

### 步骤 1：构建应用

```bash
cd packages/desktop-electron
bun run build
```

### 步骤 2：打包安装包

根据目标平台选择命令：

```bash
# Linux（生成 AppImage、.deb、.rpm）
bun run package:linux

# macOS（生成 .dmg 和 .zip）
bun run package:mac

# Windows（生成 NSIS .exe 安装程序）
bun run package:win

# 当前平台（自动检测）
bun run package
```

### 输出目录

打包完成后，产物在 `packages/desktop-electron/dist/`：

| 文件 | 平台 |
|---|---|
| `openresearch-linux-x64.AppImage` | Linux AppImage |
| `openresearch-linux-x64.deb` | Debian/Ubuntu |
| `openresearch-linux-x64.rpm` | Fedora/RHEL |
| `openresearch-mac-x64.dmg` | macOS x64 |
| `openresearch-mac-arm64.dmg` | macOS Apple Silicon |
| `openresearch-win-x64.exe` | Windows 安装程序 |

### 渠道配置

通过环境变量 `OPENCODE_CHANNEL` 控制构建渠道（默认为 `dev`）：

| 渠道 | 产品名 | App ID |
|---|---|---|
| `dev`（默认） | OpenResearch Dev | `com.openresearch.desktop.dev` |
| `beta` | OpenResearch Beta | `com.openresearch.desktop.beta` |
| `prod` | OpenResearch | `com.openresearch.desktop` |

```bash
# 开发版（默认）
OPENCODE_CHANNEL=dev bun run package:linux

# Beta 版
OPENCODE_CHANNEL=beta bun run package:linux

# 正式版
OPENCODE_CHANNEL=prod bun run package:linux
```

---

## 注意事项

- **跨平台限制**：在 Linux/WSL 环境下，CLI 可以交叉编译到所有平台；但桌面应用（Electron）只能原生打包当前平台的安装包，macOS 安装包需要在 macOS 机器上构建，Windows 安装包需要在 Windows 上构建。
- **macOS 公证**：macOS 版本启用了 `notarize`，发布前需要配置 Apple 开发者证书。
- **CLI 依赖嵌入**：桌面应用打包时会自动将 CLI 二进制（`openresearch-cli*`）一并打入安装包（位于 `resources/` 目录）。
- **协议注册**：安装后桌面应用会注册 `openresearch://` 协议，支持从浏览器唤起应用。

---

## 三、Windows 便携版打包（Linux/WSL 环境）

在 Linux/WSL 下无法生成 NSIS `.exe` 安装程序（需要 Windows 原生环境），但可以打包成 **便携 zip**，用户解压后直接双击 `.exe` 运行，无需安装。

### 步骤 1：构建应用

确保先完整构建，包含最新的 web 修改：

```bash
cd packages/desktop-electron
bun run build
```

### 步骤 2：生成 win-unpacked 目录

使用 `--win dir` 跳过 NSIS 打包，只生成解压目录（忽略末尾的 wine 签名报错，不影响运行）：

```bash
cd packages/desktop-electron
npx electron-builder --win dir --config electron-builder.config.ts
```

产物在 `dist/win-unpacked/`，包含 `OpenResearch Dev.exe` 及所有依赖。

### 步骤 3：打包成 zip

```bash
cd packages/desktop-electron/dist
python3 -c "
import zipfile, os
with zipfile.ZipFile('openresearch-win-x64-portable.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('win-unpacked'):
        for file in files:
            fp = os.path.join(root, file)
            zf.write(fp)
print('Done!')
"
```

输出文件：`packages/desktop-electron/dist/openresearch-win-x64-portable.zip`

### 用户使用方式

解压 zip 后，进入 `win-unpacked/` 目录，双击 **`OpenResearch Dev.exe`** 即可运行。

### 注意事项

- 每次修改源码后，**必须重新执行步骤 1（`bun run build`）**，否则打包的是旧版本。
- `npx electron-builder --win dir` 末尾的 wine 报错（`could not load kernel32.dll`）是代码签名失败，不影响程序正常运行，可忽略。
