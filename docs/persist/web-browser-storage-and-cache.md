# Web 版浏览器本地存储与缓存盘点

本文档记录非 Electron 的 Web 版应用会写入用户浏览器本地的内容，包括 HTTP 缓存、
`localStorage`、`sessionStorage` 和 cookie。重点是这些状态在刷新、重启浏览器、
重新打开新版程序后仍可能保留，从而影响用户实际看到的行为。

桌面端和 Electron 端的大部分持久化会通过 `platform.storage` 走桌面端存储；Web 入口
`packages/app/src/entry.tsx` 没有提供 `platform.storage`，所以共享的 `persisted(...)`
在 Web 端会回退到浏览器 `localStorage`。

## HTTP 缓存

这些不是 JavaScript 变量，但它们会落入浏览器的 HTTP 缓存，可能影响更新后浏览器实际执行哪一版前端代码。

| 资源或响应 | 当前缓存头 | 实际对应的东西 |
| --- | --- | --- |
| `/assets/*.js`，且文件名带 hash | `public, max-age=31536000, immutable` | 构建后的前端 JavaScript chunk，例如 session 页面、git graph 页面等功能代码。 |
| `/assets/*.mjs`，且文件名带 hash | `public, max-age=31536000, immutable` | 构建后的模块 chunk。 |
| `/assets/*.css`，且文件名带 hash | `public, max-age=31536000, immutable` | 构建后的 CSS 样式文件。 |
| `index.html` | `no-cache`，带 `ETag` | 应用启动 HTML，里面决定浏览器加载哪批前端 chunk。 |
| 非 hash 的静态 JS/CSS/MJS 文件 | `no-cache`，带 `ETag` | 例如 `oc-theme-preload.js`、PDF viewer 脚本和其他 public 静态资源。 |
| 未命中的 SPA 路由 fallback 到 `index.html` | `no-cache`，带 `ETag` | 用户直接打开应用内部路由时返回的启动 HTML。 |
| `/file/raw` 响应 | `no-cache`，带 `ETag` | 通过后端读取并预览的原始文件内容。 |
| 部分 `/reading-mode/*` 响应 | `no-store` | 阅读模式中明确禁止浏览器缓存的响应。 |

需要特别注意：`no-cache` 并不是“不写缓存”。它的意思是浏览器可以存，但复用前必须重新校验。
如果目标是完全不让浏览器保存 HTTP 缓存，应使用：

```http
Cache-Control: no-store, max-age=0
```

相关代码：

- `packages/opencode/src/server/server.ts`：`WEB_CACHE`、`WEB_REVALIDATE`、hash 资源判断、`ETag`。
- `packages/app/public/_headers`：静态部署时的资源缓存头。
- `packages/opencode/test/server/server-web-cache.test.ts`：当前测试明确断言 hash 资源使用长期 immutable 缓存。

## Web 入口直接写入的变量

这些变量由 Web 入口文件直接读写，没有经过 `Persist` 封装。

| 浏览器变量 | 存储位置 | 实际对应的东西 |
| --- | --- | --- |
| `opencode.settings.dat:defaultServerUrl` | `localStorage` | Web 版默认连接的 server。用户在 server 选择器里设为默认后会写入。若它指向旧的 `localhost` 地址，新版页面可能继续连接旧后端。 |
| `opencode.settings.dat:proxy` | `localStorage` | 代理配置，包括 HTTP/HTTPS 代理开关、host、port。应用启动时会尝试同步到 `/global/proxy`。 |

相关代码：

- `packages/app/src/entry.tsx`：`DEFAULT_SERVER_URL_KEY`、`PROXY_KEY`、`getDefaultUrl`、`getDefaultServer`、`setDefaultServer`、代理同步逻辑。

## `Persist` 封装写入的变量

共享封装在 `packages/app/src/utils/persist.ts` 中。Web 端没有桌面存储实现时，它最终会写浏览器 `localStorage`。

变量命名规则：

| 调用方式 | Web 端实际 key 形式 | 实际对应的东西 |
| --- | --- | --- |
| `persisted("settings.v3", ...)` | `settings.v3` | 全局设置，包括外观、字体、快捷键、通知、更新检查、权限默认值、分支图设置等。 |
| `persisted("highlights.v1", ...)` | `highlights.v1` | 已看过的 release highlights 版本，用来判断是否展示新版说明或高亮提示。 |
| `Persist.global(key)` | `opencode.global.dat:<key>` | 当前浏览器内跨项目共享的全局应用状态。 |
| `Persist.workspace(dir, key)` | `opencode.workspace.<prefix>.<checksum>.dat:workspace:<key>` | 某个项目目录的工作区级状态。 |
| `Persist.session(dir, session, key)` | `opencode.workspace.<prefix>.<checksum>.dat:session:<session>:<key>` | 某个项目目录下某个 session 的状态。 |
| `Persist.scoped(dir, session, key)` | 无 session 时使用 workspace key；有 session 时使用 session key | 既可用于工作区草稿，也可用于具体 session 的状态。 |

其中 `<prefix>` 来自目录路径前缀的清洗结果，`<checksum>` 来自完整目录路径。因此同一个逻辑变量会按不同项目目录分开存储。

### 全局持久化变量

| 浏览器变量 | 实际对应的东西 |
| --- | --- |
| `opencode.global.dat:server` | 保存的 server 列表、每个 server 打开的项目列表、项目展开状态、最后选中的项目。实际影响 server 选择器、工作区侧边栏、项目侧边栏。 |
| `opencode.global.dat:globalSync.project` | 项目列表缓存。应用刚启动、后端同步尚未完成时，用它先展示项目数据。 |
| `opencode.global.dat:globalSync.recent` | 最近项目目录缓存。应用刚启动时用于先展示 recent projects。 |
| `opencode.global.dat:language` | 用户选择的界面语言。也用于应用挂载前预热对应语言包。 |
| `opencode.global.dat:layout` | 主应用布局状态：侧边栏开关和宽度、terminal 开关和高度、review 面板状态、file tree 状态、session 宽度、移动端侧栏、每个 session 打开的 tab、滚动位置、quick reading 暂存状态、tab handoff 状态。 |
| `opencode.global.dat:layout.page` | 页面级导航状态：每个项目最后打开的 session、当前项目、当前 workspace、workspace 顺序和名称、branch 名称、workspace 展开状态、session 展开状态、conversation tree 展开和最后聚焦项、getting started 是否关闭。 |
| `opencode.global.dat:file-tree-expanded.v2` | 文件树中展开的目录，按项目/session scope 区分。 |
| `opencode.global.dat:permission` | 权限自动接受状态，包括目录级/session 级 auto accept 设置。 |
| `opencode.global.dat:model` | 模型选择偏好，包括用户收藏模型、最近使用模型、模型 variant。 |
| `opencode.global.dat:command.catalog.v1` | 命令目录缓存，用于命令发现、命令面板展示和命令元信息保留。 |
| `opencode.global.dat:notification` | 通知列表，包括 turn complete、error 通知、是否已读，以及由它派生的 session/project 未读数量。 |
| `opencode.global.dat:prompt-history` | 普通聊天 prompt 输入历史。 |
| `opencode.global.dat:prompt-history-shell` | shell 模式 prompt 输入历史。 |
| `opencode.global.dat:open.app` | 打开本地目录或文件时使用的偏好应用，例如 macOS 上的 Finder。 |
| `opencode.global.dat:auth.v1` | Web 端外部登录状态，包括 session token、过期时间、账号信息。这是敏感的浏览器本地状态。 |
| `settings.v3` | 用户设置总表：自动保存、release notes 开关、followup 模式、review batch 数量、branches tab 开关、branch graph 字号/密度/排序方式、reasoning summary 展示、工具调用展开状态、更新启动检查、字体大小和字体、快捷键、权限默认值、通知和声音设置、语音模型等。 |
| `highlights.v1` | 用户已看过的版本高亮记录，用于控制 release highlights 是否再次弹出。 |

### 工作区级持久化变量

这些变量使用 `opencode.workspace.<prefix>.<checksum>.dat:*` 命名空间。

| key 后缀 | 实际对应的东西 |
| --- | --- |
| `workspace:vcs` | 某个项目的 VCS 信息缓存，例如 branch/status 等。后端实时同步完成前可先用它展示。 |
| `workspace:project` | 某个项目目录的项目元数据缓存。 |
| `workspace:icon` | 某个项目目录的图标元数据缓存。 |
| `workspace:model-selection` | 某个工作区内的模型/agent/variant 选择，也包含具体 session 的选择记录。 |
| `workspace:terminal` | 某个项目的 terminal tabs。持久化前会裁掉 buffer、cursor、scrollY，所以主要保存 tab 身份和配置，不保存完整 terminal 输出。 |
| `workspace:quick-reading-mode.v2` | quick reading 设置，以及按 PDF 路径保存的阅读快照。 |
| `workspace:file-view` | 尚未进入具体 session 时的文件查看状态，包括滚动位置、PDF 页码和位置、选中行、word wrap、编辑状态、草稿等。 |
| `workspace:prompt` | 尚未进入具体 session 时的 prompt 草稿、光标位置和上下文附件。 |
| `workspace:comments` | 尚未进入具体 session 时的文件行内评论。 |

### Session 级持久化变量

这些变量同样使用 `opencode.workspace.<prefix>.<checksum>.dat:*` 命名空间，但 key 中包含 session ID。

| key 后缀 | 实际对应的东西 |
| --- | --- |
| `session:<sessionID>:prompt` | 某个 session 的 prompt 草稿、光标位置、上下文附件。 |
| `session:<sessionID>:file-view` | 某个 session 的文件查看状态：滚动位置、选中行、PDF 位置、word wrap、编辑状态、草稿等。 |
| `session:<sessionID>:comments` | 某个 session 的文件行内评论。 |
| `session:<sessionID>:terminal` | session 级 terminal 状态。主要用于旧数据迁移或存在 session-specific terminal persistence 时。 |

## 绕过 `Persist` 的直接浏览器存储变量

这些变量直接调用浏览器 API，不经过 `Persist`。

| 浏览器变量 | 存储位置 | 实际对应的东西 |
| --- | --- | --- |
| `opencode-theme-id` | `localStorage` | 当前选择的 UI 主题 ID。主题预加载脚本会在应用挂载前读取它，避免主题闪烁。 |
| `opencode-color-scheme` | `localStorage` | 当前配色方案：浅色、深色或跟随系统。 |
| `opencode-theme-css-light` | `localStorage` | 非默认主题的浅色模式 CSS 变量缓存。 |
| `opencode-theme-css-dark` | `localStorage` | 非默认主题的深色模式 CSS 变量缓存。 |
| `aether-pdf-theme` | `localStorage` | PDF viewer 显示主题：day、night、eye。 |
| `aether-pdf-night-mode` | `localStorage` | 旧版 PDF viewer 夜间模式开关。写入 `aether-pdf-theme` 后会移除它。 |
| `pdf-to-markdown-settings` | `localStorage` | PDF 转 Markdown 设置：专用模型、输出模式、转换后自动打开、冲突处理、输出位置、自定义输出目录。单文件和批量 PDF 转换对话框共用。 |
| `aether-reading-layout:<sessionID>` | `localStorage` | 某个 reading session 的阅读布局方向，例如 PDF 在左还是在右。 |
| `aether.sidebar-branch-view.compact` | `localStorage` | branch/conversation graph 侧栏是否使用 compact 模式。 |
| `aether.sidebar-branch-view.height` | `localStorage` | branch/conversation graph 侧栏用户手动拖动后的高度。 |
| `pdfjs.history` | `localStorage` | bundled PDF.js reference viewer 的文档浏览历史。仅在该 PDF.js viewer 被使用时写入。 |
| `pdfjs.preferences` | `localStorage` | bundled PDF.js reference viewer 的偏好设置。仅在该 PDF.js viewer 被使用时写入。 |
| `pdfjsBreakPoints` | `sessionStorage` | bundled PDF.js debugger 的断点。它是 tab/session 级别状态，不是长期 `localStorage`。 |

相关代码：

- `packages/ui/src/theme/context.tsx`：主题 ID、配色方案、主题 CSS 缓存。
- `packages/app/public/oc-theme-preload.js`：Solid 应用挂载前的主题预加载读写。
- `packages/app/src/components/pdf-viewer-shell-official.tsx`：PDF viewer 主题。
- `packages/app/src/components/dialog-pdf-to-markdown.tsx`：单文件 PDF 转换设置。
- `packages/app/src/components/dialog-batch-pdf-convert.tsx`：批量 PDF 转换设置。
- `packages/app/src/pages/reading-session.tsx`：reading session 布局方向。
- `packages/app/src/pages/session/branch/sidebar-branch-view.tsx`：branch 侧栏 compact 模式和高度。
- `packages/app/public/pdfjs-ref/web/viewer.js`：PDF.js history 和 preferences。
- `packages/app/public/pdfjs-ref/web/debugger.js`：PDF.js debugger breakpoints。

## Cookie

| 浏览器变量 | 存储位置 | 实际对应的东西 |
| --- | --- | --- |
| `oc_locale` | Cookie，`Max-Age=31536000`，`SameSite=Lax` | 当前 UI 语言，用于浏览器和服务端之间的语言协同。 |

相关代码：

- `packages/app/src/context/language.tsx`：`cookie(locale)` 和 `document.cookie = cookie(locale())`。

## 不会写入浏览器持久存储的缓存

下面这些名字看起来像缓存，但只是当前页面生命周期内的内存变量，不会落到浏览器持久存储里。

| 变量或结构 | 实际对应的东西 |
| --- | --- |
| `cache` in `packages/app/src/utils/persist.ts` | `localStorage` 的内存镜像，用来减少重复读取/解析，并在当前页面生命周期内兜底失败的存储写入。 |
| `graphCache` in `packages/app/src/pages/session/branch/sidebar-branch-view.tsx` | 当前页面生命周期内的 conversation graph 内存缓存。 |
| `caches` in `packages/app/src/context/terminal.tsx` | 一个 `Set<Map<...>>`，保存 terminal session 的内存缓存。它不是浏览器的 `window.caches` Cache API。 |
| `sdkCache`、`booting`、`sessionLoads`、`sessionMeta` in `global-sync` | 当前页面生命周期内的 SDK client、启动任务、session 加载任务和 session 元信息缓存。 |

## 禁用浏览器写入的影响

这里有两个不同目标：

1. 防止 Web 版更新后继续使用旧前端资源。
2. 防止 Web 版把任何应用状态写入浏览器本地。

如果目标只是解决更新后前端代码版本不一致，优先处理 HTTP 缓存即可：本机 web server 和静态部署头都应对 Web 资源返回
`Cache-Control: no-store, max-age=0`。这能减少旧 JS/CSS chunk 被浏览器复用的风险，同时保留用户偏好。

如果目标是完全禁止 Web 版写入浏览器本地，则需要 Web-only 的存储策略：

- 将 Web 端 `Persist` 的存储实现替换为内存存储。
- 移除或按 Web 模式保护所有直接 `localStorage` 写入，包括 Web 入口、主题系统、PDF 工具、reading layout、branch 侧栏和 bundled PDF.js viewer。
- 如果 cookie 也不允许写入，则停止 Web 模式下写 `oc_locale`。
- 对所有 Web 静态资源返回 `Cache-Control: no-store, max-age=0`；如果要更彻底，Web API 响应也应统一加 `no-store`。

第二种方案会明显改变 Web 版用户体验：用户刷新或重启浏览器后将不再保留主题、语言、布局、最近项目、server 选择、
prompt 草稿、模型选择、通知历史、terminal tabs、PDF 转换设置等状态。除非这些状态迁移到后端保存，否则它们会变成一次性页面状态。
