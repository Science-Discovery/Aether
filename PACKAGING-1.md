# Web 浏览器版打包指南

## 背景与目的

Electron 桌面版在 Windows 上存在以下问题：
- 未签名的 exe 被杀毒软件拦截（`opencode-cli.exe` sidecar 被 Windows Defender 隔离）
- 安装时 SmartScreen 弹出警告
- sidecar 进程生命周期管理复杂，强制关闭 app 后残留进程占用 sqlite 文件锁，导致下次启动卡住

**Web 版方案**：CLI 内置 `web` 命令，直接启动本地 HTTP 服务，用系统默认浏览器访问界面。没有 Electron，没有 sidecar，没有代码签名要求。

---

## 构建

**位置：** `packages/opencode/`

### 仅构建当前平台（快速测试）

```cmd
cd packages/opencode
bun run build -- --single
```

### 构建所有平台（用于分发）

```cmd
cd packages/opencode
bun run build
```

构建过程会：
1. 编译前端（`packages/app`）生成静态资源
2. 用 Bun 交叉编译各平台 CLI 二进制
3. 将前端静态资源复制到各平台 `bin/web/` 目录下
4. 为 Windows 复制 `.vbs` 启动器，为 macOS 复制 `.command` 启动器

---

## bin/ 目录结构

构建完成后，`packages/opencode/dist/` 下每个平台有独立目录：

```
dist/
  openresearch-windows-x64/bin/
    openresearch.exe          ← CLI 二进制（含内置服务器）
    web/                      ← 前端静态资源（HTML/JS/CSS）
    OpenResearch.vbs          ← Windows 双击启动器（无黑窗口）

  openresearch-darwin-arm64/bin/
    openresearch               ← CLI 二进制
    web/
    OpenResearch.command       ← macOS 双击启动器

  openresearch-linux-x64/bin/
    openresearch
    web/
                               ← Linux 无启动器，终端运行
```

`bin/web/` 是前端打包产物，CLI 启动时作为静态文件服务提供给浏览器访问。**`openresearch.exe` 和 `web/` 必须放在同一目录**，否则 CLI 找不到前端资源。

---

## 分发方式

将对应平台的整个 `bin/` 目录打包成 zip 发给用户：

```
openresearch-windows-x64.zip
  openresearch.exe
  web/
  OpenResearch.vbs
```

---

## 用户使用方式

### Windows

解压后双击 `OpenResearch.vbs`，浏览器自动打开界面，无黑色命令窗口。

### macOS

解压后双击 `OpenResearch.command`，或在终端运行：

```bash
chmod +x openresearch   # 首次需要
./openresearch web
```

### Linux

终端运行：

```bash
chmod +x openresearch   # 首次需要
./openresearch web
```

浏览器会自动打开（依赖 `xdg-open`）。若不自动打开，访问终端中显示的 URL。

### 停止服务

所有平台：在运行的终端窗口按 `Ctrl+C`。

---

## 与 Electron 版对比

| | Web 浏览器版 | Electron 桌面版 |
|---|---|---|
| 代码签名 | 不需要 | Windows 需要，否则易被杀毒拦截 |
| 跨平台 | 同一套构建脚本，Bun 交叉编译 | 每个平台需在对应系统上单独打包 |
| 稳定性 | 高（无 sidecar 进程管理问题） | 需处理 sidecar 进程生命周期 |
| 用户体验 | 浏览器窗口 | 原生桌面窗口 |
| 分发包大小 | 小 | 大（含完整 Electron 运行时）|