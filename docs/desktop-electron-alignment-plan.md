# Aether Desktop Electron：对齐上游 opencode 方案

## 背景

Aether 是 [opencode](https://github.com/anomalyco/opencode) 的 fork。Electron 桌面端包位于 `packages/desktop-electron/`（上游为 `packages/desktop/`）。本文档记录当前差距及三平台最小可用发布所需的全部变更。

前置文档：
- `docs/desktop-electron-naming-notes.md` — 命名残留审计
- `docs/desktop-electron-persist-plan.md` — 三平台持久化路径对齐方案（Windows / macOS / Linux）
- `docs/desktop-electron-icons-plan.md` — 三平台图标统一与自动生成方案

---

## 与上游的架构差异

| 维度 | 上游 opencode | Aether |
|------|-------------|--------|
| 包路径 | `packages/desktop/` | `packages/desktop-electron/` |
| 服务端嵌入方式 | 通过 `virtual:opencode-server` Vite 插件将 Node.js 服务器编译进 Electron Utility Process（`utilityProcess.fork()`） | CLI 二进制作为外部子进程 spawn（`child_process.spawn()`） |
| Vite 入口 | `{ index, sidecar }` | `{ index }`（无 sidecar.ts） |
| Electron 版本 | 41.2.1 | 40.4.1 |
| node-pty | 完整集成，6 个平台二进制 | 无 |
| @parcel/watcher | 完整集成，8 个平台二进制 | 无 |
| Sentry | 完整集成 | 无 |
| 自动更新 | `electron-updater` + Tauri 风格 `latest.json`（双轨） | 仅 `electron-updater` |

架构差异导致：Aether 的安装包更大（含 ~30-50 MB 独立二进制）、差分更新不覆盖 sidecar、进程管理依赖 `tree-kill` 而非内置 utility process 生命周期管理。

---

## 跨平台必改项

### 1. App ID 不一致

**问题：** `electron-builder.config.ts` 的 appId 为 `com.aether.desktop.*`，而 `paths.ts` 的 APP_IDS 为 `ai.aether.desktop.*`。上游 opencode 在两处统一使用 `ai.opencode.desktop.*`。

**影响：** macOS 上 `appId` 成为 `CFBundleIdentifier`；`paths.ts` APP_IDS 决定 `app.getPath("userData")`。两者不一致导致 OS 层应用身份与数据目录身份脱钩，可能引发协议注册失败、自动更新找不到旧版本、数据目录混乱。

**修改：** 将 `electron-builder.config.ts` 中三个 channel 的 appId 从 `com.aether.desktop[.dev/.beta]` 改为 `ai.aether.desktop[.dev/.beta]`，与 `paths.ts` 保持一致。

| 通道 | 当前（builder） | 当前（paths.ts） | 修改后 |
|------|----------------|-----------------|--------|
| dev | `com.aether.desktop.dev` | `ai.aether.desktop.dev` | `ai.aether.desktop.dev` |
| beta | `com.aether.desktop.beta` | `ai.aether.desktop.beta` | `ai.aether.desktop.beta` |
| prod | `com.aether.desktop` | `ai.aether.desktop` | `ai.aether.desktop` |

### 2. `native/` 目录缺失（构建失败）

**问题：** `electron-builder.config.ts` extraResources 引用 `from: "native/"`，过滤条件为 `["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"]`，但该目录不存在。electron-builder 将构建失败。

**背景：** `native/` 目录包含 macOS 专用原生插件（`mac_window.node`），用于 dock/窗口行为，对 Windows 和 Linux 无意义。

**修改：** 将该条目改为仅 macOS 包含：

```ts
...(process.platform === "darwin" ? [{
  from: "native/",
  to: "native/",
  filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
}] : []),
```

同时需在 macOS 构建前创建占位文件：

```
packages/desktop-electron/native/index.js
packages/desktop-electron/native/index.d.ts
```

实际的 `mac_window.node` 和 `swift-build/` 需单独编译（通过 `bun install --cwd native`，对应 package.json 中的 `native:build` 脚本）。

### 3. `Aether-wechat-bridge/` 目录缺失（构建失败）

**问题：** `electron-builder.config.ts` extraResources 引用 `from: "../../Aether-wechat-bridge"`，该目录不存在。electron-builder 将构建失败。

**修改：** 移除整条 extraResources 条目。待微信桥接功能就绪后重新添加。

### 4. `installCli()` 引用不存在的脚本（运行时崩溃）

**问题：** `cli.ts:101-102` 读取 `join(app.getAppPath(), "install")`，该文件不存在。点击"Install CLI"将导致崩溃。

**修改：** 将 `readFileSync` 包裹在 try-catch 中，抛出用户友好的错误：

```ts
const scriptPath = join(app.getAppPath(), "install")
let script: string
try {
  script = readFileSync(scriptPath, "utf8")
} catch {
  throw new Error("CLI installation script not found. Please install the CLI manually.")
}
```

### 5. `predev.ts` 多余参数（无害 Bug）

**问题：** `predev.ts:17` 调用 `copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)`，但函数签名只接受一个参数。`RUST_TARGET` 被静默忽略。

**修改：** 移除第二个参数：

```ts
await copyBinaryToSidecarFolder(binaryPath)
```

---

## 跨平台持久化对齐（取代旧 Windows 限定方案）

### 6. 三平台持久化路径统一

详见 `docs/desktop-electron-persist-plan.md`。相比之前仅 Windows 的方案，本次升级为**三平台统一**：

| # | 文件 | 修改内容（三平台同步生效） |
|---|------|---------|
| P1 | `paths.ts` | 重写 `aetherDataDir()`：去掉 `process.platform` 分支，统一返回 `XDG_DATA_HOME ?? <home>/.local/share` + `/aether` |
| P2 | `paths.ts` | 重写 `userDataDir()`：三平台都返回 `aetherDataDir()/desktop`，不再使用 Electron 默认 appData |
| P3 | `store.ts` | 三平台统一 cwd 路由：`aether.global.dat`/`aether.settings`/`default.dat`/`aether.workspace.*.dat` → `aetherDataDir()`；其它 → `userDataDir()` |
| P4 | `cli.ts` | `spawnCommand` 中向 sidecar 注入 `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` 默认值（仅当用户未设置时；WSL 分支跳过） |
| P5 | `persist.ts` | `ensureDesktopPersist()` / `storeSources()` / `pidFiles()` 三平台都不再读 `legacyUserDataDir()`；`ensureDefault()` 整体删除 |
| P6 | `paths.ts` | 删除 `LEGACY_APP_IDS` 与 `legacyUserDataDir()`（P5 之后无调用方） |
| P7 | `index.ts` + `migrate.ts` | 删除 `migrate.ts` 文件（或保留为 dead code 加 README）；`index.ts:106` 移除 `// migrate()` 行 |

**核心变化点**：

- macOS / Linux 不再让 Electron 把数据写到 `~/Library/Application Support/ai.aether.desktop` 或 `~/.config/Aether Desktop`，而是与 Windows 同样并入共享数据根 `<home>/.local/share/aether/desktop/`。
- `cli.ts` 在三平台都注入 XDG 默认值 —— 解决从 Dock / Finder（macOS）和 `.desktop`（Linux）启动时 process.env 不继承 shell 环境的问题，保证 sidecar 与用户在终端跑 `aether` CLI 看到完全一致的 XDG。

### 7. Windows `verifyUpdateCodeSignature` 未设置（自动更新失败）

**问题：** `win` 段没有 `verifyUpdateCodeSignature` 属性，默认值为 `true`。由于未对 Windows 二进制签名，`electron-updater` 下载更新后将因签名验证失败而报错。

**上游：** 设为 `verifyUpdateCodeSignature: false`。

**修改：** 在 `electron-builder.config.ts` 的 `win` 段添加 `verifyUpdateCodeSignature: false`。

---

## macOS 必改项

### 8. Entitlements 未接入

**问题：** `resources/entitlements.plist` 已存在，包含正确的 Electron 权限声明（JIT、unsigned-executable-memory、dyld-environment-variables、disable-library-validation、audio-input），但 `electron-builder.config.ts` 未引用。

**上游：** 同时设置了 `mac.entitlements` 和 `mac.entitlementsInherit`，均指向 `"resources/entitlements.plist"`。

**影响：** 当前因 `hardenedRuntime: false` 而无害，但后续启用签名时，缺少 entitlements 将导致应用启动即崩溃。

**修改：** 在 `mac` 段添加：

```ts
entitlements: "resources/entitlements.plist",
entitlementsInherit: "resources/entitlements.plist",
```

### 9. 中文硬编码错误对话框

**问题：** `index.ts:197-206` 的 sidecar 启动失败对话框全部为中文，且引用 `opencode-cli.exe`（Windows 专属文件名）。

**修改：** 翻译为英文，并对文件名做平台判断：

```ts
message: "Backend service failed to start.",
detail: `Possible cause: antivirus software blocked ${process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"}.\nPlease add it to your antivirus whitelist and restart.`,
buttons: ["Restart", "Quit"],
```

---

## Linux 必改项

### 10. Sidecar 二进制缺少执行权限

**问题：** `scripts/utils.ts` 中的 `copyBinaryToSidecarFolder()` 在 macOS 上执行 `codesign`（隐含保留执行权限），在 Linux 上什么都不做。当前 `cp` 默认保留 mode，所以执行位实际不丢；但若未来切换到 `Bun.write()`（默认 0644）或 `fs.copyFile(..., COPYFILE_FICLONE)` 在某些文件系统上会被悄悄剥执行位。

**修改：** 在 macOS codesign 行之后添加（防御性）：

```ts
if (process.platform === "linux") await $`chmod +x ${dest}`
```

---

## 跨平台图标统一

### 11. 桌面端图标全面替换为 Aether Web 品牌

详见 `docs/desktop-electron-icons-plan.md`。要点：

- 现状：仅 `icons/prod/icon.png`（512×512）是 Aether 品牌；其它尺寸 PNG、`icon.icns`、`icon.ico`、`dock.png` 缺失或仍为旧的非 Aether 图标。
- 目标资产：每个 channel 下生成 `16/24/32/48/64/128/256/512.png`、`icon.png`、`dock.png`、`icon.ico`、`icon.icns`。
- 实现方式：新增 `packages/desktop-electron/scripts/build-icons.ts`，源资产用 `packages/ui/src/assets/favicon/favicon-v3.svg`，依赖 `sharp` + `png-to-ico` + `@fiahfy/icns-convert`，本地运行生成、check-in 产物，CI 不强依赖。
- 联动改造：
  - `src/main/windows.ts::setDockIcon` 改读 `dock.png`（替换现 `128x128@2x.png`，与 upstream 收敛）。
  - `src/renderer/index.tsx` 通知图标改为本地资源，去除外网 `https://opencode.ai/favicon-96x96-v3.png` 依赖。
- 删除遗留：每次脚本运行时自动清理 `icons/<channel>/{android,ios,Square*.png,StoreLogo.png}` 等与 Electron 桌面无关的 Tauri / 移动端资源。
- dev / beta channel 角标设计延后，首发三个 channel 共用同一份生成结果。

---

## Windows ARM64 完整落地

### 12. Windows ARM64 矩阵 + sidecar 构建

**问题：** 上游 opencode 已支持 `aarch64-pc-windows-msvc`，Aether 的 sidecar 配置表 `scripts/utils.ts::SIDECAR_BINARIES` 已含该 target，但 `.github/workflows/publish.yml::build-electron` 矩阵未包含 Windows ARM64 项，导致 Windows-on-ARM 用户必须依赖 x64 + Prism 模拟。

**Spike 前置**（执行前必须先在本地或临时 CI 验证一次）：

```bash
OPENCODE_VERSION=0.0.1-spike \
RUST_TARGET=aarch64-pc-windows-msvc \
  bun ./packages/opencode/script/build.ts --single --skip-install --skip-smoke
```

若 `packages/opencode/script/build.ts` 不能产出 `aether-windows-arm64` 二进制，需先在 build script 内补 Bun cross-compile 支持（`bun build --target=bun-windows-arm64`）。

**落地步骤：**

1. 验证 sidecar 在 ARM64 Windows 上可构建。
2. 在 `.github/workflows/publish.yml::build-electron` 矩阵中新增条目：

   ```yaml
   - id: windows-arm64
     host: windows-11-arm        # GitHub-hosted ARM64 runner（2025 GA 后默认可用）
     rust_target: aarch64-pc-windows-msvc
     flag: --win --arm64
     files: |
       packages/desktop-electron/dist/*.exe
       packages/desktop-electron/dist/*.blockmap
   ```

   若 `windows-11-arm` 不可用，退化为 `windows-2025`（x64 host）+ electron-builder 交叉打包；sidecar 二进制走步骤 1 产物注入。

3. 仿照 Linux ARM64 处理 `latest.yml` 命名冲突：

   ```yaml
   - name: Rename Windows arm64 update metadata
     if: matrix.id == 'windows-arm64'
     run: mv dist/latest.yml dist/latest-arm64.yml
     working-directory: packages/desktop-electron
   ```

4. 校验 NSIS 产物命名：`aether-windows-arm64.exe`（artifact 模板已自动适配）。
5. `scripts/finalize-latest-yml.ts` 若需感知 Windows ARM64，按 Linux ARM64 同样模式扩展。
6. `scripts/prepare.ts` / `scripts/utils.ts` 不需修改，但需在 CI 中确认 `RUST_TARGET=aarch64-pc-windows-msvc` 正确透传。

---

## 第一版 in-app 更新策略

### 13. 关闭首版 in-app updater（保留构建产物以便将来切换）

**背景：** 当前 prod build 仍在 `electron-builder.config.ts` 中配置 `publish: { provider: "github" }`、`UPDATER_ENABLED` 默认开、菜单注册 `Check for Updates`。但：

- Windows `verifyUpdateCodeSignature` 默认 `true` + 未签名 → 自动更新一定失败。
- macOS `mac.target` 未含 `zip` → electron-updater 找不到 mac 包。
- 首版策略明确为"仅通过 GitHub Release 发版"，且"自动更新延后到自有域名子 URL 发布"。

**修改：**

- `src/main/constants.ts`：将 `UPDATER_ENABLED` 设为 `false`（或基于 `OPENCODE_CHANNEL` 强制 `prod` 也关闭）。
- `src/main/menu.ts`：隐藏 / 移除 `Check for Updates` 菜单项。
- `src/main/index.ts::setupAutoUpdater()`：入口直接 return。
- `electron-builder.config.ts` 的 `publish:` **保留**（让 electron-builder 仍产出 `latest*.yml`，便于将来一接自有域名即可启用）。

后续启用 in-app updater 的预期路径：

1. 在自有域名下开 `update.<aether-domain>/<channel>/latest-*.yml` 子 URL，把 GitHub Release 上的 yml 同步过来。
2. `setupAutoUpdater()` 改用 `setFeedURL({ provider: "generic", url: "..." })`。
3. 视签名进度决定是否再开 `verifyUpdateCodeSignature`。

---

## 命名残留收尾

### 14. 用户可见命名残留清理

详见 `docs/desktop-electron-naming-notes.md`。`#9`（中文错误对话框 + `opencode-cli.exe` 字面值）与 `#11e`（通知图标外网依赖）已分别覆盖；下列两项是用户**首次启动后立即可见**的命名残留，列入首发必做。

#### 14a. `src/main/menu.ts`

- macOS Help 菜单项 `OpenCode Documentation` 改为 `Aether Documentation`。
- support / issue / documentation 链接全部替换为 Aether 官方对应 URL（与 `electron-builder.config.ts::publish.repo` 一致）。

#### 14b. `src/renderer/i18n/*.ts` CLI install 字串

约束：sidecar 二进制实际仍叫 `opencode-cli`，安装路径仍是 `$HOME/.opencode/bin/opencode`（命名笔记 L42 明示，产品级决策延后）。直接把 i18n 里的命令名替换为 `aether` 会误导用户去运行不存在的可执行文件。

**修改**：把 i18n 里所有 CLI install 文案改为**产品级描述**，不提具体可执行文件名 / 安装路径：

- `Use the opencode command in your terminal` → `Use the Aether CLI in your terminal`
- `Install opencode to ~/.opencode/bin/opencode` → `Install the Aether CLI`
- 涉及具体路径展示的位置统一改为 "the Aether CLI install directory" 之类的描述化措辞。

**延后**：i18n 中 updater 相关字串仍提 `OpenCode`，因 §13 决定首版关闭 in-app updater，用户看不到，与 sidecar 重命名一并延后处理。

---

## 可延后但推荐尽早做的项

### macOS

| 项目 | 说明 | 前置条件 |
|------|------|---------|
| 代码签名 + 公证 | 设置 `hardenedRuntime: true`、`notarize: true`，添加 `dmg: { sign: true }` | Apple Developer ID 证书 |
| CI 证书导入 | 添加 `apple-actions/import-codesign-certs`，配置 `CSC_LINK`/`CSC_KEY_PASSWORD`/Apple API 密钥 | Apple Developer 账号 |
| 添加 `zip` 构建目标 | `mac.target: ["dmg", "zip"]` — 自动更新需要 zip 包 | 无，但仅在启用签名后有用 |
| 沙箱 | webPreferences 中设置 `sandbox: true` | 生产安全加固 |

### Windows

| 项目 | 说明 | 前置条件 |
|------|------|---------|
| 代码签名 | 通过 `sign-windows.ps1` 和 `win.signtoolOptions` 添加 Azure Trusted Signing | Azure Trusted Signing 账号 |
| `installCli()` 防护 | 在 `syncCli()` 中为 Windows 添加早期返回 + IPC handler 拒绝 Windows | 无 |

### Linux

| 项目 | 说明 | 前置条件 |
|------|------|---------|
| AppStream metainfo | 创建 `scripts/copy-metainfo.ts`，生成 `ai.aether.desktop.metainfo.xml` | 无 |
| deb/rpm 依赖声明 | 添加 `deb.depends` 和 `rpm.depends`：`libgtk-3-0`、`libnss3`、`libxss1`、`libasound2t64 \| libasound2`、`libgbm1`、`xdg-utils` 等 | 无 |
| `.desktop` MimeType | `linux.desktop.entry.MimeType = "x-scheme-handler/aether;"`，让首启动前 `aether://` 即可用 | 无 |
| Wayland 支持 | 实现 `--ozone-platform-hint` 显示后端切换器 | 无 |

### 跨平台

| 项目 | 说明 | 前置条件 |
|------|------|---------|
| Electron 版本升级 40 → 41 | 将 `electron` 依赖从 40.4.1 升级到 41.2.1 | 测试通过 |
| Sidecar 重命名 `opencode-cli` → `aether-cli` | 涉及 4 个文件的协调修改（utils.ts、cli.ts、electron-builder.config.ts、.gitignore） | 构建稳定后再做 |
| 源码目录重命名 `.opencode/` → `.aether/` | 仓库范围变更，影响大量包 | 需谨慎协调 |
| Windows `args.split(" ")` 脆弱性 | 使用参数数组替代字符串分割 | 无 |

---

## 上游 vs Aether：全平台差异对照

### macOS

| 特性 | 上游 opencode | Aether（当前） |
|------|-------------|---------------|
| `hardenedRuntime` | `true` | `false` |
| `notarize` | `true` | `false` |
| `entitlements` / `entitlementsInherit` | 均指向 `resources/entitlements.plist` | 未配置 |
| `dmg.sign` | `true` | 未设置 |
| `mac.target` | `["dmg", "zip"]` | `["dmg"]` |
| `CSC_IDENTITY_AUTO_DISCOVERY` | 未设置（允许自动发现） | `false`（显式禁用） |
| CI Apple 证书导入 | `apple-actions/import-codesign-certs` | 无 |
| Sidecar 代码签名 | 完整证书签名 | 仅 ad-hoc（`codesign --force --sign -`） |
| Runner | `macos-26` / `macos-26-intel` | `macos-14` / `macos-15-intel` |

### Windows

| 特性 | 上游 opencode | Aether（当前） |
|------|-------------|---------------|
| 代码签名 | Azure Trusted Signing（`sign-windows.ps1`） | 无 |
| `signtoolOptions.sign` | 自定义签名函数 | 未配置 |
| `verifyUpdateCodeSignature` | `false` | 未设置（默认 `true`） |
| `nsis.oneClick` | `true` | `false` |
| `nsis.allowToChangeInstallationDirectory` | 未设置 | `true` |
| `nsis.perMachine` | `false` | 未设置（默认 `false`） |
| ARM64 CI 构建 | 有 | **本计划新增（见 #12）** |
| Sidecar 签名 | 通过 Azure Trusted Signing 签名 | 未签名 |
| 构建后签名验证 | 有 | 无 |

### Linux

| 特性 | 上游 opencode | Aether（当前） |
|------|-------------|---------------|
| `deb.packageName` | 未设置（使用 productName） | `aether-desktop[-dev/-beta]` |
| `rpm.packageName` | `opencode[-dev/-beta]` | `aether-desktop[-dev/-beta]` |
| AppStream metainfo | 有 `copy-metainfo.ts` | 无 |
| AUR 发布 | CI 自动推送 PKGBUILD | 无 |
| `depends` / `recommends` | 未设置 | 未设置（相同） |

### 跨平台

| 特性 | 上游 opencode | Aether（当前） |
|------|-------------|---------------|
| App ID（builder） | `ai.opencode.desktop.*` | `com.aether.desktop.*` |
| App ID（运行时） | `ai.opencode.desktop.*` | `ai.aether.desktop.*` |
| 协议 scheme | `opencode://` | `aether://` |
| 产物命名 | `opencode-desktop-${os}-${arch}.${ext}` | `aether-${os}-${arch}.${ext}` |
| Sidecar 二进制名 | `opencode-*` | `aether-*`（下载时），`opencode-cli`（应用内） |
| x64 baseline 后缀 | darwin/win/linux x64 使用 `-baseline` | 无后缀 |
| `OPENCODE_UPDATER_CHANNEL` | 未使用 | 用于动态更新通道 |
| CI 构建触发 | 始终构建 Electron | 需 opt-in（`release_electron: true`） |
| CI 发布模式 | `--publish always` | `--publish never`（手动上传） |
| CI Runner | Blacksmith（付费加速） | 标准 GitHub-hosted |
| Sentry | 完整集成 | 无 |

---

## 变更执行清单

### 首次发布前必做

#### 基础修复（构建可行性）

- [ ] **#1** `electron-builder.config.ts`：appId 从 `com.aether.desktop.*` 改为 `ai.aether.desktop.*`
- [ ] **#2** `electron-builder.config.ts`：`native/` extraResource 改为仅 `process.platform === "darwin"` 时包含
- [ ] **#2b** 创建 `packages/desktop-electron/native/index.js` 和 `native/index.d.ts` 占位文件
- [ ] **#3** `electron-builder.config.ts`：移除 `Aether-wechat-bridge` extraResources 条目
- [ ] **#4** `src/main/cli.ts`：`installCli()` 中 readFileSync 包裹 try-catch；IPC handler 在 Windows 上直接返回错误，菜单项相应禁用
- [ ] **#5** `scripts/predev.ts`：移除 `copyBinaryToSidecarFolder` 调用的多余 `RUST_TARGET` 参数

#### 三平台持久化（详见 `desktop-electron-persist-plan.md`）

- [ ] **#6 (P1)** `src/main/paths.ts`：`aetherDataDir()` 去掉平台分支，统一返回 `XDG_DATA_HOME ?? <home>/.local/share` + `/aether`
- [ ] **#6 (P2)** `src/main/paths.ts`：`userDataDir()` 三平台统一返回 `aetherDataDir()/desktop`
- [ ] **#6 (P3)** `src/main/store.ts`：三平台统一 cwd 路由（global-like → `aetherDataDir()`，其它 → `userDataDir()`）
- [ ] **#6 (P4)** `src/main/cli.ts`：`spawnCommand` 内向 sidecar 注入 XDG 默认值（三平台，仅未设置时；WSL 分支跳过）
- [ ] **#6 (P5)** `src/main/persist.ts`：三平台都不再读 `legacyUserDataDir()`；删除 `ensureDefault()`
- [ ] **#6 (P6)** `src/main/paths.ts`：删除 `LEGACY_APP_IDS` 与 `legacyUserDataDir()`
- [ ] **#6 (P7)** `src/main/index.ts` 删除 `// migrate()` 行；`src/main/migrate.ts` 整文件移除或标 dead

#### 各平台规范

- [ ] **#7** `electron-builder.config.ts`：`win` 段添加 `verifyUpdateCodeSignature: false`
- [ ] **#8** `electron-builder.config.ts`：`mac` 段添加 `entitlements` 和 `entitlementsInherit`
- [ ] **#9** `src/main/index.ts`：中文错误对话框翻译为英文，文件名做平台判断
- [ ] **#10** `scripts/utils.ts`：Linux 上 sidecar 二进制添加 `chmod +x`（防御性）

#### 图标统一（详见 `desktop-electron-icons-plan.md`）

- [ ] **#11a** `packages/desktop-electron/package.json` `devDependencies` 加入 `sharp`、`png-to-ico`、`@fiahfy/icns-convert`
- [ ] **#11b** 新增 `packages/desktop-electron/scripts/build-icons.ts` 与对应 `build-icons.test.ts`
- [ ] **#11c** 本地运行 `bun run icons:prod && bun run icons:beta && bun run icons:dev`，commit 生成的 PNG/ICO/ICNS 产物
- [ ] **#11d** `src/main/windows.ts::setDockIcon` 改读 `dock.png`
- [ ] **#11e** `src/renderer/index.tsx` 通知图标改用本地资源（消除 `https://opencode.ai/favicon-96x96-v3.png` 外网依赖）

#### Windows ARM64（详见 #12）

- [ ] **#12a** 本地或临时 CI 验证 `RUST_TARGET=aarch64-pc-windows-msvc bun ./packages/opencode/script/build.ts --single` 能产出 sidecar；不能则先补 build script
- [ ] **#12b** `.github/workflows/publish.yml::build-electron` 矩阵新增 `windows-arm64` 项
- [ ] **#12c** 新增 Windows arm64 `latest.yml` 重命名步骤
- [ ] **#12d** 若 `finalize-latest-yml.ts` 需感知，同步扩展

#### 第一版更新策略

- [ ] **#13a** `src/main/constants.ts`：`UPDATER_ENABLED = false`（首版强制关闭 in-app updater）
- [ ] **#13b** `src/main/menu.ts`：隐藏 / 移除 `Check for Updates` 菜单项
- [ ] **#13c** `src/main/index.ts::setupAutoUpdater()`：入口直接 return
- [ ] **#13d** `electron-builder.config.ts` 的 `publish:` **保留不动**，便于将来切自有域名

#### 命名残留收尾

- [ ] **#14a** `src/main/menu.ts`：Help 菜单 `OpenCode Documentation` 改为 `Aether Documentation`；support / issue / documentation 链接替换为 Aether 官方 URL
- [ ] **#14b** `src/renderer/i18n/*.ts`：CLI install 字串改为产品级描述（不提 `opencode` 命令名或具体路径）；updater 字串延后

### 首次发布后应尽快做

- [ ] macOS：代码签名 + 公证；`mac.target` 添加 `"zip"`；写 Gatekeeper 绕过指南
- [ ] Windows：代码签名（Azure Trusted Signing 或同等方案）；sign-windows.ps1 + signtoolOptions 接入
- [ ] Linux：AppStream metainfo 生成；deb/rpm 依赖声明；`.desktop` MimeType 配置
- [ ] 在自有域名开 `update.<aether-domain>/<channel>/latest-*.yml`，启用 in-app updater
- [ ] 跨平台：Electron 版本升级 40 → 41
- [ ] 跨平台：sidecar 二进制改名 `opencode-cli` → `aether-cli`；连带 i18n updater 字串与 WSL 安装路径一并替换
- [ ] `nix/desktop.nix`：当前引用已不存在的 `packages/desktop/src-tauri/`，整 nix build 已坏；重写为指向 `packages/desktop-electron/` 或临时打 `meta.broken = true` 标记
