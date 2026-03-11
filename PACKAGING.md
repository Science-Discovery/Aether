# OpenResearch 打包与使用教程

---

## 目录

- [方案对比](#方案对比)
- [通用准备](#通用准备)
- [方案一：CLI 命令行工具](#方案一cli-命令行工具)
- [方案二：桌面应用（Tauri）](#方案二桌面应用tauri)
- [方案三：桌面应用（Electron）](#方案三桌面应用electron)
- [使用指南](#使用指南)

---

## 方案对比

| | CLI | 桌面（Tauri） | 桌面（Electron） |
|--|-----|-------------|----------------|
| 包大小 | ~10MB | ~15MB | ~150MB |
| 界面 | 终端 TUI | 原生 GUI | 原生 GUI |
| 构建额外依赖 | 无 | Rust | Node.js v24 |
| 系统 WebView 依赖 | 无 | 是（系统自带） | 否（自带 Chromium） |
| 适合场景 | SSH 远程、服务器 | 日常桌面开发 | 兼容性要求高的环境 |

---

## 通用准备

所有方案都需要先完成以下步骤：

```bash
# 安装 Bun（需要 1.3+）
curl -fsSL https://bun.sh/install | bash

# 克隆仓库
git clone https://github.com/your-username/opencode.git
cd opencode

# 安装依赖
bun install
```

---

## 方案一：CLI 命令行工具

产物是单个可执行文件，终端运行，支持 TUI 界面。

### 构建

```bash
# 构建当前平台的单个二进制（推荐本地使用）
./packages/opencode/script/build.ts --single

# 构建全平台二进制（用于分发）
cd packages/opencode && bun run build
```

### 产物位置

```
packages/opencode/dist/
├── opencode-darwin-arm64/bin/opencode      # macOS Apple Silicon
├── opencode-darwin-x64/bin/opencode        # macOS Intel
├── opencode-linux-arm64/bin/opencode       # Linux ARM64
├── opencode-linux-x64/bin/opencode         # Linux x86_64
├── opencode-windows-x64/bin/opencode.exe   # Windows
└── ...（baseline 变体用于旧 CPU）
```

> 实际目录名取决于 CPU 是否支持 AVX2，构建后用 `ls packages/opencode/dist/` 确认。

### 分发给他人

将对应平台的可执行文件发给对方：

```bash
# macOS / Linux
chmod +x opencode
./opencode

# 放入 PATH（可选）
sudo mv opencode /usr/local/bin/openresearch
```

---

## 方案二：桌面应用（Tauri）

基于 Rust + 系统 WebView，包体积小。

> **关键说明：** Tauri 桌面版将 CLI 二进制作为内嵌子进程（sidecar）打包。
> 必须先构建 CLI，再手动放入指定目录，才能构建桌面应用。

### 额外依赖

**安装 Rust：**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

**Linux 还需要系统库：**

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf
```

**macOS 需要 Xcode Command Line Tools：**

```bash
xcode-select --install
```

### 构建步骤

**第一步：构建 CLI 二进制**

```bash
./packages/opencode/script/build.ts --single
```

**第二步：将 CLI 复制到 sidecar 目录**

```bash
mkdir -p packages/desktop/src-tauri/sidecars

# 先查看实际产物目录名
ls packages/opencode/dist/

# Linux x86_64
cp packages/opencode/dist/opencode-linux-x64/bin/opencode \
   packages/desktop/src-tauri/sidecars/opencode-cli-x86_64-unknown-linux-gnu

# Linux ARM64
cp packages/opencode/dist/opencode-linux-arm64/bin/opencode \
   packages/desktop/src-tauri/sidecars/opencode-cli-aarch64-unknown-linux-gnu

# macOS Apple Silicon
cp packages/opencode/dist/opencode-darwin-arm64/bin/opencode \
   packages/desktop/src-tauri/sidecars/opencode-cli-aarch64-apple-darwin

# macOS Intel
cp packages/opencode/dist/opencode-darwin-x64-baseline/bin/opencode \
   packages/desktop/src-tauri/sidecars/opencode-cli-x86_64-apple-darwin

# Windows（PowerShell）
cp packages/opencode/dist/opencode-windows-x64-baseline/bin/opencode.exe `
   packages/desktop/src-tauri/sidecars/opencode-cli-x86_64-pc-windows-msvc.exe
```

**第三步：构建桌面应用**

```bash
cd packages/desktop

# 生产构建（生成安装包）
bun run tauri build
```

### 产物位置

```
packages/desktop/src-tauri/target/release/bundle/
├── deb/        → Linux .deb 安装包
├── rpm/        → Linux .rpm 安装包
├── appimage/   → Linux .AppImage 便携版
├── dmg/        → macOS .dmg 安装包
├── macos/      → macOS .app 应用包
└── nsis/       → Windows .exe 安装程序
```

### 安装方式

| 平台 | 文件 | 安装命令 |
|------|------|---------|
| macOS | `OpenResearch.dmg` | 双击，拖入 Applications |
| Windows | `OpenResearch_x64-setup.exe` | 双击运行安装向导 |
| Linux (Debian/Ubuntu) | `*.deb` | `sudo dpkg -i *.deb` |
| Linux (RedHat/Fedora) | `*.rpm` | `sudo rpm -i *.rpm` |
| Linux (通用) | `*.AppImage` | `chmod +x *.AppImage && ./openresearch_*.AppImage` |

---

## 方案三：桌面应用（Electron）

基于 Chromium，跨平台行为最一致，系统兼容性最好。

> **关键说明：** 与 Tauri 相同，Electron 版也需要先构建 CLI 并放入指定目录。

### 额外依赖

**安装 Node.js v24：**

```bash
# 使用 nvm（推荐）
nvm install 24 && nvm use 24
```

**Linux 打包 rpm 格式还需要：**

```bash
sudo apt-get install -y rpm
```

**从 Linux/WSL 构建 Windows 包理论上需要 Wine，但 WSL 中 Wine 32 位支持不稳定，不推荐。Windows 包建议用 GitHub Actions 构建。**

### 构建步骤

**第一步：构建 CLI 二进制**

```bash
./packages/opencode/script/build.ts --single
```

**第二步：将 CLI 复制到 resources 目录**

```bash
mkdir -p packages/desktop-electron/resources

# Linux x86_64（先用 ls packages/opencode/dist/ 确认目录名）
cp packages/opencode/dist/opencode-linux-x64/bin/opencode \
   packages/desktop-electron/resources/opencode-cli

# macOS Apple Silicon
cp packages/opencode/dist/opencode-darwin-arm64/bin/opencode \
   packages/desktop-electron/resources/opencode-cli

# Windows（PowerShell）
cp packages/opencode/dist/opencode-windows-x64-baseline/bin/opencode.exe `
   packages/desktop-electron/resources/opencode-cli.exe
```

**第三步：构建并打包**

```bash
cd packages/desktop-electron

# 编译前端
bun run build

# 打包（选择目标平台）
bun run package:linux   # Linux（WSL/Linux 可构建）
bun run package:win     # Windows（WSL 不可靠，用 GitHub Actions）
bun run package:mac     # macOS（只能在 macOS 上构建）
```

### 产物位置

```
packages/desktop-electron/dist/
├── opencode-electron-linux-x64.AppImage
├── opencode-electron-linux-x64.deb
├── opencode-electron-linux-x64.rpm
├── opencode-electron-darwin-x64.dmg
├── opencode-electron-darwin-arm64.dmg
└── opencode-electron-win32-x64.exe
```

### 安装方式

| 平台 | 文件 | 安装方式 |
|------|------|---------|
| Windows | `*-win32-x64.exe` | 双击运行安装向导 |
| macOS | `*-darwin-*.dmg` | 双击，拖入 Applications |
| Linux (Debian/Ubuntu) | `*-linux-x64.deb` | `sudo dpkg -i *.deb` |
| Linux (RedHat/Fedora) | `*-linux-x64.rpm` | `sudo rpm -i *.rpm` |
| Linux (通用) | `*-linux-x64.AppImage` | `chmod +x *.AppImage && ./opencode-electron-linux-x64.AppImage` |

安装后启动应用，首次使用需配置 AI 提供商 API Key。

---

## 使用指南

### CLI 常用命令

```bash
openresearch                    # 在当前目录启动 TUI
openresearch /path/to/project   # 在指定目录启动
openresearch serve              # 启动无界面 API 服务器
openresearch web                # 启动服务器并打开浏览器界面
openresearch --help             # 查看所有命令
```

### 本地开发调试

改代码时不需要重新打包，直接用：

```bash
# 在项目根目录
bun dev web       # 启动本地服务器 + 打开浏览器（使用你修改的代码）
bun dev           # 启动 TUI 模式
```

### 配置 AI 提供商

首次启动会引导配置，也可以通过环境变量设置：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
openresearch
```

支持的提供商：Anthropic Claude、OpenAI、Google Gemini、AWS Bedrock、Azure OpenAI，以及所有兼容 OpenAI 格式的接口。

### 连接远程服务器

桌面版和网页版都可以连接到远程部署的 OpenResearch 服务：

```bash
# 在远程服务器上启动
openresearch serve --port 4096
```

然后在桌面应用设置中将服务器地址改为 `http://<服务器IP>:4096`。