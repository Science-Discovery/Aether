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

CLI 工具使用 Bun 的 `compile` 功能构建，支持交叉编译到所有平台。构建产物为单个可执行二进制文件，命名为 `aether`。

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
aether-linux-x64/
  bin/
    aether        ← CLI 二进制
    web/                ← Web UI 静态资源（由 packages/app 构建）
      index.html
      assets/
      ...
```

| 目录 | 平台 |
|---|---|
| `aether-linux-x64/bin/` | Linux x64 (glibc) |
| `aether-linux-arm64/bin/` | Linux ARM64 |
| `aether-linux-x64-musl/bin/` | Linux x64 (musl) |
| `aether-darwin-x64/bin/` | macOS x64 |
| `aether-darwin-arm64/bin/` | macOS ARM64 (Apple Silicon) |
| `aether-windows-x64/bin/` | Windows x64 |

### 安装到系统

**必须将 `aether` 二进制和 `web/` 目录一起复制**，否则 `aether web` 会回退到显示远程版本：

```bash
# Linux 安装（复制二进制 + web 资源）
sudo cp dist/aether-linux-x64/bin/aether /usr/local/bin/
sudo cp -r dist/aether-linux-x64/bin/web /usr/local/bin/
```

卸载：
```bash
sudo rm /usr/local/bin/aether
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

# Windows（生成 NSIS .exe 安装程序，见下方 Windows 注意事项）
bun run package:win

# 当前平台（自动检测）
bun run package

#生成dmg安装包
npx electron-builder --mac dmg --config electron-builder.config.ts
```

#### Windows 原生打包注意事项

在 Windows 上执行 `bun run package:win` 前，需满足以下条件之一，否则会因无法创建符号链接而报错（`Cannot create symbolic link`）：

- **方案 A（推荐）：开启开发者模式**
  `设置 → 隐私和安全性 → 开发者选项 → 开发者模式 → 开启`

- **方案 B：以管理员身份运行终端**
  右键开始菜单 → `终端(管理员)` 或 `命令提示符(管理员)`

Windows cmd 的环境变量语法与 Unix 不同，且跨盘符切换目录需加 `/d`：

```cmd
cd /d D:\Postdoc\code\aether_1\opencode\packages\desktop-electron
bun run build
set CSC_IDENTITY_AUTO_DISCOVERY=false && bun run package:win
```

PowerShell 写法：

```powershell
cd D:\Postdoc\code\aether_1\opencode\packages\desktop-electron
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; bun run package:win
```

### 输出目录

打包完成后，产物在 `packages/desktop-electron/dist/`：

| 文件 | 平台 |
|---|---|
| `aether-linux-x64.AppImage` | Linux AppImage |
| `aether-linux-x64.deb` | Debian/Ubuntu |
| `aether-linux-x64.rpm` | Fedora/RHEL |
| `aether-mac-x64.dmg` | macOS x64 |
| `aether-mac-arm64.dmg` | macOS Apple Silicon |
| `aether-win-x64.exe` | Windows 安装程序 |

### 渠道配置

通过环境变量 `OPENCODE_CHANNEL` 控制构建渠建（默认为 `dev`）：

| 渠道 | 产品名 | App ID |
|---|---|---|
| `dev`（默认） | OpenResearch Dev | `com.aether.desktop.dev` |
| `beta` | OpenResearch Beta | `com.aether.desktop.beta` |
| `prod` | OpenResearch | `com.aether.desktop` |

```bash
OPENCODE_CHANNEL=prod bun run package:linux
```

---

## 三、Windows 便携版打包（Linux/WSL 环境）

在 Linux/WSL 下无法生成 NSIS `.exe` 安装程序，但可以打包成**便携 zip**，用户解压后直接双击 `.exe` 运行，无需安装。

### 完整流程（三步）

```bash
# 步骤 1：构建（包含最新源码修改）
# 相对路径
cd packages/desktop-electron
# 绝对路径
cd /home/zheng/code/aether/opencode/packages/desktop-electron
bun run build

# 步骤 2：生成 win-unpacked（忽略末尾 wine 签名报错，不影响运行）
npx electron-builder --win dir --config electron-builder.config.ts

# 步骤 3：打包成 zip
# 相对路径
cd dist
# 绝对路径
cd /home/zheng/code/aether/opencode/packages/desktop-electron/dist
python3 -c "
import zipfile, os
with zipfile.ZipFile('aether-win-x64-portable.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('win-unpacked'):
        for file in files:
            zf.write(os.path.join(root, file))
print('Done!')
"
```

输出：`packages/desktop-electron/dist/aether-win-x64-portable.zip`

### 用户使用方式

解压 zip，进入 `win-unpacked/`，双击 **`OpenResearch Dev.exe`** 即可运行。

---

---

## 四、Web 浏览器版打包（跨平台推荐方案）

**位置：** `packages/opencode/`

相比 Electron 桌面应用，Web 版更稳定、无需代码签名、跨平台一致。CLI 内置 `web` 命令，启动本地 HTTP 服务后自动用系统默认浏览器打开界面。

### 构建

在 Windows 上仅构建 Windows 版本（`--single` 只编译当前平台）：

```cmd
cd /d D:\Postdoc\code\openresearch_1\opencode\packages\opencode
bun run build -- --single
```

构建当前平台（在 Linux/macOS 上运行）：

```bash
cd packages/opencode
bun run build -- --single
```

### 输出目录

```
packages/opencode/dist/
  aether-windows-x64/bin/
    aether.exe          ← CLI 二进制
    web/                      ← 前端静态资源
    Aether.vbs          ← Windows 启动器
  aether-darwin-arm64/bin/
    aether               ← CLI 二进制
    web/
    Aether.command       ← macOS 启动器
  aether-linux-x64/bin/
    aether
    web/
```

### 分发方式

将对应平台的整个 `bin/` 目录打包成 zip/tar.gz 发给用户。

#### Windows

解压后双击 `Aether.vbs`，无黑色命令窗口，浏览器自动打开界面。

#### macOS/Linux

在终端手动运行：

```bash
cd 解压目录
chmod +x aether   # 首次需要，赋予执行权限
./aether web
```

浏览器会自动打开（依赖 `xdg-open`，主流桌面环境均支持）。若不自动打开，手动访问终端中显示的 URL。

#### 停止服务

所有平台：在运行的终端窗口按 `Ctrl+C`。

### 与 Electron 版对比

| | Web 浏览器版 | Electron 桌面版 |
|---|---|---|
| 代码签名 | 不需要 | Windows 需要否则易被杀毒拦截 |
| 跨平台 | 同一套 CLI 全平台通用 | 每个平台需单独打包 |
| 稳定性 | 高（无 sidecar 进程管理问题）| 需处理 sidecar 进程生命周期 |
| 用户体验 | 浏览器窗口 | 原生桌面窗口 |
| 分发包大小 | 小 | 大（含完整 Electron 运行时）|
