# Aether Desktop Icons Plan

跨平台桌面端图标统一为 Aether Web 版品牌的完整实施方案。

## 背景与现状审计

- `packages/desktop-electron/icons/prod/icon.png`（512×512）md5 与 `packages/ui/src/assets/favicon/web-app-manifest-512x512.png` 一致 ✓，是新 Aether 品牌。
- `packages/desktop-electron/icons/prod/{32x32,64x64,128x128,128x128@2x}.png` 在 dev / beta / prod 三个频道中完全相同（md5 一致），是**早期非 Aether 的遗留小尺寸 PNG**。
- `packages/desktop-electron/icons/<channel>/icon.icns` 与 `icon.ico` 二进制内容未经 Aether 品牌重生成，需要重新合成。
- 三个频道的 `icons/<channel>/` 下都缺：
  - `48x48.png`、`16x16.png`、`24x24.png`、`256x256.png`、`512x512.png`（literal 文件名，hicolor 主题需要）
  - `dock.png`（macOS Dock 高分图标）
- 三个频道的 `icons/<channel>/` 都存在大量遗留资源，与 Electron 桌面端无关：
  - `android/`（mipmap 与 ic_launcher，与 Tauri/移动端遗留有关）
  - `ios/`（AppIcon-*）
  - `Square107x107Logo.png` … `StoreLogo.png`（Windows Store / UWP 历史资源）

后果：
- Linux electron-builder 在 deb/rpm/AppImage 中只识别 `<size>x<size>.png` 命名约定，因此现在打出的包里**hicolor 主题图标全是旧的非 Aether 图**，且没有 512px / 256px / 48px / 16px 尺寸 → HiDPI 显示糊、小尺寸用 256/128 缩放。
- Windows `icon.ico` 与 macOS `icon.icns` 内容陈旧。
- `packages/desktop-electron/src/main/windows.ts::setDockIcon` 当前读 `128x128@2x.png`（同样是旧图），不是 Aether 品牌。
- 上游 opencode 期望读 `dock.png`，命名收敛不一致。

## 源资产决策

- **首选源**：`packages/ui/src/assets/favicon/favicon-v3.svg`（矢量，任意尺寸高质量重采样）。
- **兜底源**：`packages/ui/src/assets/favicon/web-app-manifest-512x512.png`（已确认是 Aether 品牌，prod 当前 `icon.png` 与其 md5 一致）。
- 二选一时优先 SVG；SVG 渲染需要 `sharp`（自带 librsvg / resvg 后端）。
- **不**使用 `packages/web/public/favicon-96x96-v3.png`（仅 96px，重采样失真）。

## 各平台规范

### Linux（electron-builder hicolor 主题）

electron-builder Linux 把 `linux.icon` 当作目录处理，扫描其中所有 `<width>x<height>.png`，并在 deb/rpm 安装时复制到 `/usr/share/icons/hicolor/<size>/apps/<appId>.png`。AppImage 嵌入最大尺寸。`icon.png`、`128x128@2x.png` 等不符合该命名约定的文件被忽略。

`resources/icons/` 需要的 PNG（每个 channel）：

```text
16x16.png
24x24.png
32x32.png
48x48.png
64x64.png
128x128.png
256x256.png
512x512.png
```

可选保留（仅为兼容旧逻辑或 macOS 沿用）：

```text
icon.png             # 512×512，等同 512x512.png 的内容，方便其它入口直接引用
dock.png             # 512×512，macOS Dock；setDockIcon 显式读取
icon.icns            # macOS 主图标
icon.ico             # Windows 主图标
```

### Windows

单一 `icon.ico`，**必含**以下尺寸（PNG-compressed 用于 ≥256）：

```text
16  24  32  48  64  128  256
```

`electron-builder.config.ts` 中 `win.icon`、`nsis.installerIcon`、`nsis.installerHeaderIcon` 均复用同一个 `resources/icons/icon.ico`。

### macOS

单一 `icon.icns`，**必含**下列尺寸，每个尺寸含 @1x 和 @2x（即 `iconutil` 期望的 10 个 PNG）：

```text
icon_16x16.png       (16)
icon_16x16@2x.png    (32)
icon_32x32.png       (32)
icon_32x32@2x.png    (64)
icon_128x128.png     (128)
icon_128x128@2x.png  (256)
icon_256x256.png     (256)
icon_256x256@2x.png  (512)
icon_512x512.png     (512)
icon_512x512@2x.png  (1024)
```

`icns` 生成方式：
- 在 macOS host 上跑 `iconutil -c icns icon.iconset/`；
- 跨平台 CI 用 `@fiahfy/icns-convert` 或 `png2icns`（纯 Node，无系统依赖）。

`dock.png`（512×512）单独放在 `resources/icons/` 下，供 `setDockIcon` 显式读取。

### 协议关联（次要图标）

- macOS：协议处理器自动使用 `.app` 主图标，无需额外资源。
- Linux：xdg-mime 默认走 `.desktop` 文件的 `Icon=` 字段（指向 hicolor 主题项），无需额外资源。
- Windows：`aether://` 注册表项的图标可指向 NSIS 安装目录下的 `icon.ico,0`，electron-builder 默认行为已覆盖。

## 自动生成脚本设计

新增 `packages/desktop-electron/scripts/build-icons.ts`，目标：

- 输入：channel（`dev` / `beta` / `prod`）。
- 输出：覆盖写入 `packages/desktop-electron/icons/<channel>/`：
  - `16x16.png` / `24x24.png` / `32x32.png` / `48x48.png` / `64x64.png` / `128x128.png` / `256x256.png` / `512x512.png`
  - `icon.png`（= 512×512）
  - `dock.png`（= 512×512）
  - `icon.ico`（含 16/24/32/48/64/128/256）
  - `icon.icns`（含 16/32/64/128/256/512/1024，及对应 @2x）
- 删除 `<channel>/android/`、`<channel>/ios/`、`<channel>/Square*.png`、`<channel>/StoreLogo.png` 等与 Electron 无关的 Tauri / 移动端遗留资源。

### 依赖

加入 `packages/desktop-electron/package.json` `devDependencies`：

- `sharp`：PNG 重采样、SVG 渲染。
- `png-to-ico`：多尺寸 PNG → 单一 ICO。
- `@fiahfy/icns-convert`：多尺寸 PNG → 单一 ICNS（跨平台，无 macOS-only `iconutil` 依赖）。

### 脚本结构（概要）

```ts
// packages/desktop-electron/scripts/build-icons.ts
import { $ } from "bun"
import sharp from "sharp"
import pngToIco from "png-to-ico"
import { convert } from "@fiahfy/icns-convert"

const SRC_SVG = "../../packages/ui/src/assets/favicon/favicon-v3.svg"
const SRC_PNG = "../../packages/ui/src/assets/favicon/web-app-manifest-512x512.png"

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]   // 含 @2x

const channel = process.argv[2] ?? "prod"
const out = `icons/${channel}`

// 1. 重置目标目录（保留 README.md，删除一切其它）
// 2. 渲染所有尺寸 PNG（优先 SVG，失败回落 PNG 上采样）
// 3. 写 icon.png、dock.png（512×512）
// 4. 用 PNG_SIZES 的子集生成 icon.ico
// 5. 用 ICNS_SIZES 的子集生成 icon.icns
// 6. 输出 md5：512x512.png 必须与 web-app-manifest-512x512.png 一致
```

dev / beta channel 的角标设计本轮**延后**，三个频道使用同一份生成结果。后续若加角标，仅在 channel ≠ "prod" 时对生成的 PNG 叠加 channel 标签层。

### npm scripts

`packages/desktop-electron/package.json`：

```json
"scripts": {
  "icons:prod": "bun ./scripts/build-icons.ts prod",
  "icons:beta": "bun ./scripts/build-icons.ts beta",
  "icons:dev":  "bun ./scripts/build-icons.ts dev",
  "icons:all":  "bun run icons:prod && bun run icons:beta && bun run icons:dev"
}
```

CI **不强制**运行该脚本（保持产物 check-in，避免每次发版都依赖 sharp/icns-convert 的二进制下载）；首次执行与品牌变更时本地运行后 commit 产物。

## 主进程联动改造

`packages/desktop-electron/src/main/windows.ts::setDockIcon`：

```ts
export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}
```

替换现在读 `128x128@2x.png` 的逻辑（与上游 opencode 收敛）。

`src/renderer/index.tsx` 中的通知图标当前 fetch 自 `https://opencode.ai/favicon-96x96-v3.png`（命名笔记已记），改为打包内静态资源（指向 renderer 同目录下从 `web-app-manifest-512x512.png` 复制的本地 PNG），消除外网依赖与跨品牌图标。

## 校验与测试

新增 `packages/desktop-electron/scripts/build-icons.test.ts`：

- 断言每个 channel 下 8 个 `<size>x<size>.png`、`icon.png`、`dock.png`、`icon.ico`、`icon.icns` 都存在。
- 断言每个 PNG 的实际宽高匹配文件名。
- 断言 prod channel 的 `512x512.png` md5 与 `packages/ui/src/assets/favicon/web-app-manifest-512x512.png` 一致（如果生成走 SVG 路径，对比 SVG 在 512px 下渲染结果与源 PNG 视觉差异 ≤ 阈值）。
- 断言 `<channel>/android/`、`<channel>/ios/`、`<channel>/Square*.png` 已被脚本删除。

## 执行步骤（按顺序）

1. **加依赖**：
   - 在 `packages/desktop-electron/package.json` `devDependencies` 加入 `sharp`、`png-to-ico`、`@fiahfy/icns-convert`。
   - `bun install` 验证。
2. **写脚本**：
   - 新增 `packages/desktop-electron/scripts/build-icons.ts`。
   - 新增 `packages/desktop-electron/scripts/build-icons.test.ts`。
   - 在 `package.json` 加 `icons:*` 脚本。
3. **本地运行生成**：
   - `bun run icons:prod && bun run icons:beta && bun run icons:dev`
   - 复核生成结果（人眼 + md5）。
4. **联动代码改造**：
   - `src/main/windows.ts::setDockIcon` 改读 `dock.png`。
   - `src/renderer/index.tsx` 通知图标改用本地资源。
5. **删除遗留资源**：
   - 由 `build-icons.ts` 在每次运行时自动删除 `<channel>/{android,ios,Square*.png,StoreLogo.png}`，不留手工删除步骤。
6. **CI 校验**：
   - 把 `bun run --cwd packages/desktop-electron test build-icons` 加入 PR 检查（确认产物未被误删）。
7. **commit 产物**：
   - 把生成的 PNG / ICO / ICNS 全部 check-in（与上游 opencode 做法一致）。

## 未来扩展

- 若需要 dev / beta channel 视觉区分：在 `build-icons.ts` 内增加 `--badge dev|beta` 选项，对 PNG 叠加角标层后再合成 ICO/ICNS。
- 若 Aether 品牌升级：只需替换 `packages/ui/src/assets/favicon/favicon-v3.svg`（或 `web-app-manifest-512x512.png`），重跑 `bun run icons:all` 即可。
