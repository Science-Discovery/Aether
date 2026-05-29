# Aether Desktop Electron：从上游 opencode 完整迁移 in-app 自动更新机制

> 备忘临时文档。锁定方案后用于驱动实施；实施完成并合 PR 后可归档或删除。
> 适用分支：`electron-desktop` worktree / `electron-desktop` 分支。
> 上游参考仓库：`anomalyco/opencode`（本地路径 `/home/dsjian/researches/opencode`）。

---

## 0. 范围与底线

**任务**：把上游 `anomalyco/opencode` 对 Electron 桌面端的 in-app auto-update 机制完整、精确移植到 Aether `electron-desktop` 分支。

**底线**：改动只触及

- `packages/desktop-electron/**`
- `.github/workflows/publish.yml` 中 Electron 矩阵相关的 step

**绝对不动**：

- `packages/opencode/`（CLI）
- `packages/app/`（Web/Electron 共用 UI 框架）
- `packages/web/`
- Web 发版 yml（`latest-web-*.yml`）
- 任何 CLI/Web 发布脚本

---

## 1. 当前 Aether 实现 vs 上游 opencode：逐项对照

### 1.1 主进程：`src/main/constants.ts`

| 项 | 上游 opencode | Aether 当前 | 差距 |
|---|---|---|---|
| `UPDATER_ENABLED` | `app.isPackaged && CHANNEL !== "dev"` | `false`（硬编码） | Aether 首发应恢复为 `app.isPackaged && CHANNEL === "prod"`，显式禁用 beta/dev |
| 顶部 `import { app } from "electron"` | 存在 | 已删除 | 需要补回 |

### 1.2 主进程：`src/main/index.ts`

| 函数 | 上游 | Aether 当前 | 差距 |
|---|---|---|---|
| `setupAutoUpdater()` | 设置 `logger` / `channel` / `allowPrerelease` / `allowDowngrade` / `autoDownload` / `autoInstallOnAppQuit` | `return`（空函数） | **需要恢复完整体** |
| `checkUpdate()` | 完整实现 | 完整实现，入口 `UPDATER_ENABLED` short-circuit | flag 翻转后自动恢复 |
| `installUpdate()` | 完整实现 | 完整实现 | flag 翻转后自动恢复 |
| `checkForUpdates(alertOnFail)` | 完整实现 | 完整实现，入口 `UPDATER_ENABLED` short-circuit | flag 翻转后自动恢复 |
| `void app.whenReady().then(... setupAutoUpdater() ...)` | 调用 | 已调用（不变） | 不需改 |

注：Aether 已经**完整保留**了上游的 `checkUpdate / installUpdate / checkForUpdates` 三个函数实现，仅由 `UPDATER_ENABLED` 守卫成 no-op。一旦 flag 恢复，它们自动激活。

### 1.3 主进程：`src/main/menu.ts`

| 项 | 上游 | Aether 当前 | 差距 |
|---|---|---|---|
| App 菜单 `Check for Updates...` 项 | 存在，`enabled: UPDATER_ENABLED` | **菜单项已彻底删除** | **需要恢复** |
| `Deps.checkForUpdates` 字段 | 存在 | 仍存在 | 不需改 |
| `wireMenu()` 注入 checkForUpdates 回调 | 存在 | 仍存在 | 不需改 |

### 1.4 渲染进程

| 文件 | 上游 | Aether 当前 | 差距 |
|---|---|---|---|
| `src/renderer/updater.ts` | 完整实现 | 完整实现（一字不差） | 不需改 |
| `src/renderer/index.tsx` Platform.checkUpdate / update | 有 short-circuit | 有 short-circuit（同样模式） | 不需改 |
| `src/preload/index.ts` | `runUpdater` / `checkUpdate` / `installUpdate` IPC bridge | 同上 | 不需改 |
| `src/main/ipc.ts` | 注册三个 handler | 已注册 | 不需改 |

### 1.5 i18n（updater 字符串）

| 项 | 上游 | Aether 当前 | 差距 |
|---|---|---|---|
| `desktop.menu.checkForUpdates` | `Check for Updates...` | 各 locale 已翻译 | 不需改 |
| `desktop.updater.none.message` | `You are already using the latest version of OpenCode` | **仍说 OpenCode** | **本次替换为 Aether** |
| `desktop.updater.downloaded.prompt` | `Version X of OpenCode has been downloaded...` | **仍说 OpenCode** | **本次替换为 Aether** |
| `desktop.updater.checkFailed.message` 等 | 同 | 同 | 同 |

涉及 16 个 locale 文件中各 2-4 个 key。

### 1.6 `electron-builder.config.ts`

| 字段 | 上游（prod） | Aether 当前（prod） | 差距 |
|---|---|---|---|
| `publish` | `{ provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" }` | `{ provider: "github", owner: "Science-Discovery", repo: "Aether", channel: updater }` | OK（指向自己的 Release） |
| `win.verifyUpdateCodeSignature` | 隐含 `true`（已签名） | `false`（已显式） | OK |
| `mac.target` | `["dmg", "zip"]` | `["dmg"]` | **需要加 `"zip"`**（用于生成 `latest-mac.yml` metadata；首发 macOS 不做 in-app 下载/安装） |
| `mac.hardenedRuntime` / `notarize` | `true` / `true` | `false` / `false` | 首发不动：macOS 仅检查更新并跳转 GitHub Releases，签名/公证留待后续 |
| `dmg.sign` | `true` | 未设 | 首发不动 |
| `linux.target` | `["AppImage", "deb", "rpm"]` | 同上 | OK |

### 1.7 CI / `publish.yml`

| 步骤 | 上游 | Aether 当前 | 差距 |
|---|---|---|---|
| 构建后 upload `latest-yml-${rust_target}` artifact | 有 | 有（line 166-170） | OK |
| `finalize-latest-yml.ts` 合并并 `gh release upload` | 有 | 有（line 312-319） | OK |
| Win ARM64 重命名 `latest.yml` → `latest-arm64.yml` | 上游不需要（用 win.target 区分） | 已加（line 155-158） | OK |
| Mac 产物列表 | 含 `.dmg` + `.zip` | **只含 `.dmg`** | **需要加 `.zip` 收集**（与 1.6 联动） |
| Mac runner 上传 `.zip` 到 GitHub Release | 是 | **缺**（mac/mac-x64 矩阵的 `files:` 字段无 `*.zip`） | 需要在 mac/mac-x64 矩阵的 `files:` 中添加 |
| beta channel publish 目标 | `anomalyco/opencode-beta` | `anomalyco/aether-beta`（指向上游空间！） | **必须移除**（beta 首发不支持 updater，避免任何上游耦合） |

---

## 2. 精确改动清单（按文件）

下面给出"完整移植"所需的 7 项原子改动。每项可以独立验证。

### M1 ｜ `packages/desktop-electron/src/main/constants.ts`

```diff
+import { app } from "electron"
 import { SETTINGS_STORE } from "./persist-names"

 type Channel = "dev" | "beta" | "prod"
 const raw = import.meta.env.OPENCODE_CHANNEL
 export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
 ...
-export const UPDATER_ENABLED = false
+export const UPDATER_ENABLED = app.isPackaged && CHANNEL === "prod"
 export { SETTINGS_STORE }
```

**效果**：未 packaged（即 `bun dev`）、dev 通道、beta 通道全关；只有 prod packaged build 启用。beta 首发不支持 updater，避免错误关联到 `anomalyco/aether-beta` 或任何未确认的 beta Release 仓库。

### M2 ｜ `packages/desktop-electron/src/main/index.ts`

```diff
 import type { Event } from "electron"
-import { app, BrowserWindow, dialog } from "electron"
+import { app, BrowserWindow, dialog, shell } from "electron"
 ...
+const RELEASES_URL = "https://github.com/Science-Discovery/Aether/releases/latest"
+
 function setupAutoUpdater() {
-  return
+  if (!UPDATER_ENABLED) return
+  autoUpdater.logger = logger
+  autoUpdater.channel = import.meta.env.OPENCODE_UPDATER_CHANNEL || "latest"
+  autoUpdater.allowPrerelease = false
+  autoUpdater.allowDowngrade = true
+  autoUpdater.autoDownload = false
+  autoUpdater.autoInstallOnAppQuit = true
+  logger.log("auto updater configured", {
+    channel: autoUpdater.channel,
+    allowPrerelease: autoUpdater.allowPrerelease,
+    allowDowngrade: autoUpdater.allowDowngrade,
+    currentVersion: app.getVersion(),
+  })
 }
```

**已决方案**：使用 `OPENCODE_UPDATER_CHANNEL` 环境变量驱动，默认 `"latest"`。上游 `autoUpdater.channel = "latest"` 是硬编码；Aether 在 `electron-builder.config.ts:9` 已经引入了 `OPENCODE_UPDATER_CHANNEL` 环境变量、`electron.vite.config.ts:10` 也将其注入 `import.meta.env`、`env.d.ts:3` 已经声明类型。本方案保留 Aether 现有机制，同时默认行为与上游一致。

同时对 macOS 与 Linux 非 AppImage 做首发专用分支：**只检查 Release metadata，绝不下载更新包，绝不调用 `quitAndInstall()`**。

```diff
+const MANUAL_INSTALL_UPDATE = process.platform === "darwin" || (process.platform === "linux" && !process.env.APPIMAGE)
+const RELEASES_URL = "https://github.com/Science-Discovery/Aether/releases/latest"
+
 async function checkUpdate() {
   if (!UPDATER_ENABLED) return { updateAvailable: false }
   updateReady = false
   logger.log("checking for updates", {
@@
     }
     logger.log("update available", { version })
+    if (MANUAL_INSTALL_UPDATE) {
+      logger.log("update available; manual install required", { version, platform: process.platform })
+      return { updateAvailable: true, version }
+    }
     await autoUpdater.downloadUpdate()
     logger.log("update download completed", { version })
     updateReady = true
     return { updateAvailable: true, version }
@@
 async function installUpdate() {
+  if (MANUAL_INSTALL_UPDATE) {
+    await shell.openExternal(RELEASES_URL)
+    return
+  }
   if (!updateReady) return
   killSidecar()
   autoUpdater.quitAndInstall()
 }
```

`checkForUpdates(alertOnFail)` 的成功分支也要在 macOS 和 Linux 非 AppImage 上显示手动安装弹窗并直接返回：

```diff
+  if (MANUAL_INSTALL_UPDATE) {
+    const response = await dialog.showMessageBox({
+      type: "info",
+      title: "Update Available",
+      message: `Aether Desktop ${result.version ?? ""} is available.`,
+      detail:
+        process.platform === "darwin"
+          ? "Automatic download and installation are not enabled for macOS yet. Please download the latest macOS release from GitHub Releases and replace your existing app."
+          : "Automatic download and installation are only enabled for Linux AppImage builds. Please download the latest .deb or .rpm package from GitHub Releases and upgrade with your package manager.",
+      buttons: ["Open GitHub Releases", "Later"],
+      defaultId: 0,
+      cancelId: 1,
+    })
+    if (response.response === 0) await shell.openExternal(RELEASES_URL)
+    return
+  }
+
  const response = await dialog.showMessageBox({
     type: "info",
     message: `Update ${result.version ?? ""} downloaded. Restart now?`,
     title: "Update Ready",
```

为避免共享 App UI 在 macOS 与 Linux 非 AppImage 上显示通用的“下载/安装更新”流程，传给 renderer 的 `updaterEnabled` 对手动安装形态保持 `false`；这些用户通过桌面端显式的 `Check for Updates...` 入口触发上述手动安装弹窗。

```diff
+const RENDERER_UPDATER_ENABLED = UPDATER_ENABLED && !MANUAL_INSTALL_UPDATE
+
 ...
   const globals = {
-    updaterEnabled: UPDATER_ENABLED,
+    updaterEnabled: RENDERER_UPDATER_ENABLED,
     deepLinks: pendingDeepLinks,
   }
```

### M3 ｜ `packages/desktop-electron/src/main/menu.ts`

```diff
       label: app.getName(),
       submenu: [
         { role: "about" },
+        {
+          label: "Check for Updates...",
+          enabled: UPDATER_ENABLED,
+          click: () => deps.checkForUpdates(),
+        },
         {
           label: "Reload Webview",
           click: () => deps.reload(),
         },
```

注：上游另在该位置上方放了一个 `"Install CLI..."` 菜单项；Aether 此前已经把 "Install CLI" 从菜单移除（与 `docs/desktop-electron-naming-notes.md` 的 "延后产品决策" 一致），本次**不**恢复 Install CLI 菜单项。

同文件中 `New Window` 也要避免把共享 App UI 的通用更新入口暴露给 macOS 新窗口：

```diff
         {
           label: "New Window",
           accelerator: "Cmd+Shift+N",
-          click: () => createMainWindow({ updaterEnabled: UPDATER_ENABLED }),
+          click: () => createMainWindow({ updaterEnabled: false }),
         },
```

这里显式传 `false` 是因为当前 `createMenu()` 只在 macOS 上创建；macOS 首发不向共享 App UI 暴露通用自动更新流程，只保留原生菜单手动检查路径。

### M4 ｜ `packages/desktop-electron/electron-builder.config.ts`

```diff
   mac: {
     category: "public.app-category.developer-tools",
     icon: `resources/icons/icon.icns`,
     entitlements: "resources/entitlements.plist",
     entitlementsInherit: "resources/entitlements.plist",
     hardenedRuntime: false,
     gatekeeperAssess: false,
     notarize: false,
-    target: ["dmg"],
+    target: ["dmg", "zip"],
   },
```

**效果**：每次 Mac build 同时生成 `.dmg`（给用户首次装机/手动覆盖安装）与 `.zip`（给 electron-builder 生成 `latest-mac.yml` metadata）。首发阶段 macOS 不使用 `.zip` 做 in-app 下载/安装。

### M5 ｜ `.github/workflows/publish.yml`（mac / mac-x64 矩阵的 `files:` 列表）

```diff
           - id: mac
             host: macos-14
             rust_target: aarch64-apple-darwin
             flag: --mac --arm64
             files: |
               packages/desktop-electron/dist/*.dmg
+              packages/desktop-electron/dist/*.zip
               packages/desktop-electron/dist/*.blockmap
           - id: mac-x64
             host: macos-15-intel
             rust_target: x86_64-apple-darwin
             flag: --mac --x64
             files: |
               packages/desktop-electron/dist/*.dmg
+              packages/desktop-electron/dist/*.zip
               packages/desktop-electron/dist/*.blockmap
```

`latest-mac.yml` 在 `finalize-latest-yml.ts` 里**已经**合并 arm64 + x64 entries（line 101-111），无需改动该脚本。

### M6 ｜ i18n updater 字符串

**已决方案**：本次一并改，避免 updater 启用后用户看到 "OpenCode"。

16 个 locale 文件中以下 key 把 "OpenCode" 替换为 "Aether"：

- `desktop.updater.none.message`
- `desktop.updater.downloaded.prompt`
- 任何还包含 OpenCode 字面值的 updater 相关 key（grep 出来一次性替换）

预计涉及每个 locale 约 2-4 行；总改动 ≈ 60-80 行字符串。

改动**仅在** `packages/desktop-electron/src/renderer/i18n/*.ts`，对 Web/CLI 零影响（Web 的 i18n 在 `packages/app/src/i18n/`）。

### M7 ｜ `packages/desktop-electron/electron-builder.config.ts`：删除 beta publish

```diff
     case "beta": {
       return {
         ...base,
         appId: "ai.aether.desktop.beta",
         productName: "Aether Desktop Beta",
         protocols: { name: "Aether Desktop Beta", schemes: ["aether"] },
-        publish: { provider: "github", owner: "anomalyco", repo: "aether-beta", channel: "latest" },
```

**已决方案**：beta 首发不支持 updater。必须删除 beta `publish` 字段，并通过 M1 的 `CHANNEL === "prod"` 运行时守卫保证 beta packaged build 也不会查更新。后续如果需要 beta updater，再单独决定 beta Release 仓库并恢复配置。

### M8 ｜ `packages/desktop-electron/src/main/index.ts`：Linux 非 AppImage 手动安装分支

**已决方案**：Linux 只有 AppImage 做 in-app 下载/替换；`.deb` / `.rpm` 用户类比 macOS，只检查更新并提示去 GitHub Releases 下载对应包手动升级。

实现已并入 M2 的 `MANUAL_INSTALL_UPDATE` 分支：`process.platform === "linux" && !process.env.APPIMAGE` 时，`checkUpdate()` 只返回可用版本，`checkForUpdates()` 只弹出手动安装提示并打开 GitHub Releases，`installUpdate()` 不调用 `quitAndInstall()`。

**仅在** Electron 包内、对 Web/CLI 零影响。属增强项，详见 §3.3。

---

## 3. 各平台行为矩阵（启用后的真实表现）

### 3.1 Windows（x64 / ARM64）

| 阶段 | 行为 | 是否就绪 |
|---|---|---|
| Check | `autoUpdater.checkForUpdates()` 拉 `Science-Discovery/Aether` 最新 Release 的 `latest.yml`（由 finalize 合并 x64 + arm64 的 entries） | ✅ |
| Download | 下载对应 arch 的 NSIS `.exe` | ✅ |
| 签名校验 | `verifyUpdateCodeSignature: false` 已设 → 跳过 | ✅ |
| Install | 启动 NSIS 安装器原地升级 | ✅ |
| 重启 | `autoUpdater.quitAndInstall` → 干净重启 | ✅ |

**Windows 完全可用**。

### 3.2 macOS（arm64 / x64）

| 阶段 | 行为 | 是否就绪 |
|---|---|---|
| Check | 原生菜单 `Check for Updates...` 拉 `latest-mac.yml`（已 finalize 合并 arm64 + x64） | ✅（M4+M5 完成后） |
| Download | **不下载**。`autoDownload = false`，且 `checkUpdate()` 在 `darwin` 分支直接返回 | ✅ |
| Install | **不安装**。`installUpdate()` 在 `darwin` 分支只打开 GitHub Releases | ✅ |
| 用户提示 | 弹窗说明 macOS 暂未启用自动下载安装，要求去 GitHub Releases 下载最新版 `.dmg` 并覆盖安装 | ✅ |
| 后续升级到完整自动更新 | 接入 Developer ID 签名/公证后，再把 `darwin` 分支改回下载 + `quitAndInstall()` | 后续独立任务 |

**已决方案**：macOS 首发采用"只检查更新 + 跳转 GitHub Releases 手动安装"，不做 in-app 下载/安装。这样不会触发未签名/未公证 app 的自动替换与 Gatekeeper 拦截问题，也不会让用户误以为 macOS 自动更新已经完整可用。

macOS 用户更新路径：

1. 在菜单中点击 `Check for Updates...`
2. 如果有新版本，点击 `Open GitHub Releases`
3. 下载对应架构的 macOS `.dmg`
4. 打开 `.dmg`，把 `Aether Desktop.app` 拖到 `/Applications` 覆盖旧版本

### 3.3 Linux

| 安装方式 | 行为 |
|---|---|
| AppImage | ✅ 完整 in-app updater：检查、下载、原地替换 |
| `.deb` | ✅ 通过桌面端显式入口只检查更新；提示去 GitHub Releases 下载新版 `.deb` 后用包管理器升级 |
| `.rpm` | ✅ 通过桌面端显式入口只检查更新；提示去 GitHub Releases 下载新版 `.rpm` 后用包管理器升级 |

**已决方案**：不让 `.deb` / `.rpm` 进入自动下载/安装路径，避免“有更新按钮但不能自动升级”的错觉；但仍保留检查更新与跳转 GitHub Releases 的便利性。

Linux `.deb` 用户手动升级：

```bash
sudo apt install ./aether-desktop_<version>_amd64.deb
```

Linux `.rpm` 用户手动升级：

```bash
sudo dnf install ./aether-desktop-<version>.x86_64.rpm
```

### 3.4 dev 通道

`UPDATER_ENABLED = app.isPackaged && CHANNEL === "prod"` → dev 永远关。menu 中 `Check for Updates` 项 `enabled: false`。✅

### 3.5 beta 通道

**已决方案**：beta 首发不支持 updater。

- `UPDATER_ENABLED = app.isPackaged && CHANNEL === "prod"`，beta packaged build 不会查更新。
- `electron-builder.config.ts` 删除 beta `publish` 字段，消除 `anomalyco/aether-beta` 上游耦合。
- 后续如需 beta updater，必须先确定 Aether 自己的 beta Release 仓库，再恢复 beta publish 配置。

---

## 4. Web/CLI 影响审计（证明底线）

| 关注点 | 评估 |
|---|---|
| `packages/opencode/` (CLI) | **零改动**。CLI 不引用 `electron-updater`，本次零接触。 |
| `packages/web/` | **零改动**。Web 不打 Electron 包。 |
| `packages/app/`（跨 Web/Electron 的 SolidJS UI） | **零改动**。Web 与 Electron 的 `Platform.checkUpdate` 是**两套不同实现**：Web 用自己的 `/latest-web-*.yml` 体系（见 `packing_scripts/release-*-web.sh`），Electron 走 `window.api.checkUpdate`。两条路径互不相关。 |
| Web 用户的更新流 | **完全不受影响**。Web 依然从 `release-web-mac/linux/windows` artifact 中读取 `latest-web-*.yml`，由 Aether 自己的 web installer 处理。 |
| `latest*.yml` 文件冲突 | electron 的 `latest.yml`（无前缀）、`latest-mac.yml`、`latest-linux.yml`、`latest-linux-arm64.yml`、`latest-arm64.yml`；Web 的 `latest-web-mac.yml`、`latest-web-linux.yml`、`latest-web-windows.yml`。**命名空间不冲突**，同一个 Release 可以并存。 |
| `bun.lock` 变化 | M1-M7 不增加任何 dependency（`electron-updater` 早已在 `package.json` 中）。无 lockfile 改动。 |

**结论**：底线 "对其他版本零影响" 可以严格证明。

---

## 5. 验证 / 上线检查清单 （在实施过程中，除了静态检查，别的都不用处理）

按下列顺序执行验证（每步对应 §2 的 M 改动）：

1. **静态检查**（M1-M3）：`bun typecheck`（在 `packages/desktop-electron` 目录下）
2. **本地 dev**（M1 反向验证）：`OPENCODE_CHANNEL=dev bun dev` → 启动应用 → 菜单中 "Check for Updates" 应灰显（disabled）。
3. **本地 prod build**（M1 正向）：`OPENCODE_CHANNEL=prod bun run build && OPENCODE_CHANNEL=prod npx electron-builder --linux --publish never` → 启动 AppImage → 菜单中 "Check for Updates" 可点。
4. **试发 CI**（M4 + M5）：在 dev 分支上手动触发 `publish` workflow（`release_electron: true`），版本号用 `0.0.1-spike-updater`：
   - 验证 macOS 矩阵的 dist 同时产出 `.dmg` 与 `*-mac.zip`
   - 验证 `latest-mac.yml` 被 `finalize-latest-yml.ts` 正确合并
   - 验证 GH Release 上有 `latest.yml` / `latest-mac.yml` / `latest-linux.yml` / `latest-linux-arm64.yml` / `latest-arm64.yml` 五份
5. **端到端（手动）**：先发 `v0.0.1-spike-updater` 试用版让朋友装一遍 → 再发 `v0.0.2-spike-updater` → 启动 `0.0.1` 版本 → 等 24h 或菜单手点 Check for Updates → 验证：
   - Windows：下载 + 重启 + 升级到 0.0.2 ✅
   - macOS：只检查 metadata，不下载；提示打开 GitHub Releases；手动下载 `.dmg` 覆盖安装
   - Linux AppImage：下载 + 原地替换 ✅
   - Linux deb/rpm：只检查 metadata，不下载；提示打开 GitHub Releases；手动下载 `.deb` / `.rpm` 后用包管理器升级

---

## 6. 风险与后续

### 6.1 已知 / 残留风险

- **R1（中）**：CI 试发流程（步骤 4）首次跑可能踩到 GitHub Release `--clobber` 行为、artifact-glob 不匹配等小坑，需要预留半天调试时间。
- **R2（低）**：当前 `electron-updater` 已在 main bundle，`setupAutoUpdater()` 恢复后包行为变化，但 bundle 大小不变（已经 import 过）。
- **R3（低）**：现有 Aether 用户**全部都是首次安装**（Electron 之前从未发布过），所以 "老版本升级" 路径在本次发版后才开始累积，第一版用户全部走 GitHub Release 装机。**不存在数据迁移问题**。

### 6.2 不在范围内 / 留待后续

- Aether Web/CLI 的 update 机制（已经独立运转，不在本次范围）
- 切换到自有域名 mirror 的 `setFeedURL({ provider: "generic", url })`（`docs/desktop-electron-alignment-plan.md` §13 的远期目标）
- macOS Developer ID 签名 / 公证接入（后续把 macOS 从"只检查 + 手动安装"升级为完整 in-app 下载/安装）
- Windows Azure Trusted Signing 接入（独立工作流）

---

## 7. 改动汇总（最终一览）

| # | 文件 | 行数估计 | 性质 |
|---|---|---|---|
| M1 | `packages/desktop-electron/src/main/constants.ts` | +1 / -1 | 还原上游 |
| M2 | `packages/desktop-electron/src/main/index.ts` | +45 / -1 | 还原上游 + macOS/Linux 非 AppImage 手动安装分支 |
| M3 | `packages/desktop-electron/src/main/menu.ts` | +6 / -1 | 还原上游 + macOS 新窗口禁用共享更新 UI |
| M4 | `packages/desktop-electron/electron-builder.config.ts` | +1 / -1 | macOS zip target |
| M5 | `.github/workflows/publish.yml` | +2 | 收集 mac zip artifact |
| M6 | `packages/desktop-electron/src/renderer/i18n/*.ts` | ~60-80 | OpenCode → Aether |
| M7 | `packages/desktop-electron/electron-builder.config.ts` | -1 | 删除 beta publish |
| M8 | `packages/desktop-electron/src/main/index.ts` | 已并入 M2 | Linux 非 AppImage 手动安装分支 |

**总改动**：约 140-170 行实质代码 + 60-80 行 i18n 文案。零依赖变更。零跨包改动。

---

## 8. 参考：当前 Aether 实现已就绪的部分（不需再动）

- `src/main/index.ts:6-7`：`import pkg from "electron-updater"; const { autoUpdater } = pkg`
- `src/main/index.ts:326-409`：`checkUpdate / installUpdate / checkForUpdates` 完整实现
- `src/main/ipc.ts:38-72`：三个 IPC handler 已注册
- `src/preload/index.ts:65-67`：preload IPC bridge 已暴露
- `src/preload/types.ts:82-84`：types 已定义
- `src/renderer/updater.ts`：renderer 侧 `UPDATER_ENABLED()` getter + `runUpdater` 已实现
- `src/renderer/index.tsx:160-170`：`Platform.checkUpdate / update` 已 hook；本方案会通过 macOS `updaterEnabled: false` 避免共享 App UI 显示通用更新流程
- `src/main/windows.ts:8, 145-150`：`updaterEnabled` 通过 `window.__OPENCODE__` 注入 renderer 全局
- `electron.vite.config.ts:10, 16`：`OPENCODE_UPDATER_CHANNEL` 注入机制
- `src/main/env.d.ts:3`：`OPENCODE_UPDATER_CHANNEL` 类型声明
- `electron-builder.config.ts:71`：`win.verifyUpdateCodeSignature: false`
- `electron-builder.config.ts:117`：prod publish 指向 `Science-Discovery/Aether`
- `.github/workflows/publish.yml:155-170, 312-319`：`latest*.yml` artifact 上传 + finalize

整套基础设施在前次改造（关闭 in-app updater）中**保留完好**，仅是 flag 被强制 `false`、菜单项被删除、`setupAutoUpdater()` 被掏空 — 本次迁移即"反向操作"。

---

## 9. 实施顺序建议

1. 先做 M1 + M2 + M3（开关 + setup + 菜单）→ 本地 dev + prod build 验证菜单状态正确
2. 再做 M6（i18n 文案）→ 静态可见，但还未触发 updater 流
3. 再做 M4 + M5（macOS zip target + CI 收集）→ 试发一次 CI 验证产物完整性
4. 做 M7（删除 beta publish）
5. 在试用包上做 §5 步骤 5 的端到端验证
6. 合 PR

---

（备忘 end）
