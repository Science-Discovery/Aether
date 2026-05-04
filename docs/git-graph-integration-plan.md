# Git Graph 集成方案

> 在 Aether web-ui 变更视图栏中新增 "Git Graph" Tab，基于 vscode-git-graph 算法提供可视化的 git 历史查看与交互。

## 参考仓库

- **vscode-git-graph**: https://github.com/mhutchie/vscode-git-graph.git（已 clone 到 `reference/vscode-git-graph`；如果在修改时发现该仓库已被删除，则需要请示后重新clone作为参照。）
- 核心借鉴：`web/graph.ts` 的图布局算法、`web/main.ts` 的渲染同步机制、`dataSource.ts` 的 git 命令封装

## 总体架构决策

| vscode-git-graph 组件                                      | Aether 对应                                                    | 说明                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `dataSource.ts` — `getCommits()` / `getRefs()`             | `packages/opencode/src/git/index.ts` — 新增 `log()` / `refs()` | Effect Service 模式         |
| `dataSource.ts` — `getRepoInfo()`                          | `packages/opencode/src/project/vcs.ts` — 新增 `graph()`        | 组合 log + refs             |
| Extension ↔ Webview messaging                              | Hono HTTP API (`GET /vcs/graph`) → SDK                         | 同步 REST 请求              |
| `web/graph.ts` — `Graph.loadCommits()` / `determinePath()` | `model.ts` — 纯函数 `computeGraphLayout()`                     | 无框架依赖，可测试          |
| `web/graph.ts` — `Graph.render()` SVG 线 + 圆              | `render.tsx` — SVG `<For>` + `<path>` / `<circle>`             | SolidJS 响应式              |
| `web/main.ts` — `renderTable()` HTML commit 列表           | `render.tsx` — HTML `<For>` 行列表                             | **固定行高**，无需 DOM 测量 |
| `web/main.ts` — `renderGraph()` SVG-HTML 同步              | **无需此层**                                                   | 固定行高消除同步需求        |
| `web/graph.ts` — tooltip system                            | 独立 Tooltip SolidJS 组件                                      | HTML 定位层                 |
| `web/contextMenu.ts`                                       | 复用 `@kobalte/core` 菜单组件                                  |                             |

### 核心分歧决策：渲染同步方式

- **vscode-git-graph**：先渲染 HTML table → 测量 DOM 获取行高 → 回填 SVG 的 `grid.y`（后测量）
- **Aether**：固定 `rowHeight` → SVG 和 HTML 使用同一个值渲染（预计算）

SolidJS 声明式渲染天然保证二者一致性，消除了 DOM 测量带来的复杂性。

## 触发入口

在变更模式下拉框（审查页面上方，包含 `git` / `branch` / `session` / `turn`）中添加 `"graph"` 选项。选中时调用 `tabs().open("git-graph")` + `tabs().setActive("git-graph")`。

## Tab 行为

遵循 **context 模式**：

- 存入 `all[]` 前缀（不可拖拽，排在 context 之后，文件 tabs 之前）
- 可关闭（有 X 按钮）
- 滚动位置持久化（`view().setScroll("git-graph", ...)`）

---

## 阶段 0：后端 API 基础 — Git Log & Refs

**目标**：为前端提供 git graph 所需的全部数据（一个请求）。

### 文件变更

| 文件                                     | 变更                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| `packages/opencode/src/git/index.ts`     | 新增 `log()` 方法、公共化 `refs()` 支持多种 ref 类型 |
| `packages/opencode/src/project/vcs.ts`   | 新增 `graph()` 方法，组合 log + refs 数据            |
| `packages/opencode/src/server/server.ts` | 新增 `GET /vcs/graph` 路由（带 `describeRoute()`）   |
| `packages/sdk/js/`                       | `bun ./script/build.ts` 重新生成 SDK                 |

### Git 命令

```bash
# commit log
git log --format="%H %P %an %ae %at %s" --max-count=300 --all --topo-order

# refs (heads + tags + remotes)
git for-each-ref --format="%(refname:short) %(objectname) %(objecttype)" \
  refs/heads/ refs/tags/ refs/remotes/
```

### API 设计

```
GET /vcs/graph?max=300&branch=all
  → {
      commits: CommitLogItem[],
      head: string,
      tags: TagRef[],
      moreAvailable: boolean
    }
```

```ts
type CommitLogItem = {
  hash: string
  parents: string[]
  author: string
  email: string
  date: number // unix timestamp
  message: string // subject line
  heads: string[] // 本地分支 refs
  tags: TagRef[] // { name, annotated }
  remotes: RemoteRef[] // { name, remote }
}
```

### Effect 新增服务方式

```
1. 在 Git.Interface 中新增方法签名
2. 在 Service.of({...}) 中实现
3. 在文件底部添加 standalone runPromise 函数
4. 在 Hono route handler 中调用 standalone 函数
5. 在 route 上添加 describeRoute() 以生成 OpenAPI spec
6. 运行 bun ./packages/sdk/js/script/build.ts 重新生成 SDK
```

---

## 阶段 1：前端图模型 + 基础 SVG 渲染

**目标**：纯函数实现 git graph lane 分配算法 + SolidJS 渲染组件，可独立开发和验证。

### 新建文件

| 文件                                                  | 职责                                            |
| ----------------------------------------------------- | ----------------------------------------------- |
| `packages/app/src/pages/session/git-graph/model.ts`   | 纯函数：lane 分配 + 颜色分配（无 SolidJS 依赖） |
| `packages/app/src/pages/session/git-graph/render.tsx` | SolidJS 渲染组件（SVG + HTML）                  |

### model.ts — 图布局算法

参考 vscode-git-graph `graph.ts` 的 `loadCommits()` + `determinePath()` 算法，结合 Aether `conversation-graph-model.ts` 的函数式风格：

```
输入: CommitLogItem[], head: string | null
输出: { nodes: GraphNode[], edges: GraphEdge[], lanes: number }

GraphNode = {
  hash, row, lane, colorIndex,
  isHead, isUncommitted,
  message, author, date
}

GraphEdge = {
  fromRow, toRow,
  fromLane, toLane,
  isMerge
}
```

**Lane 分配规则**：

1. First parent 继承父节点的 lane（主干直行）
2. 额外 parent（merge commit）分配新 lane（向右分叉）
3. 已结束的分支释放 lane 供复用
4. HEAD 上方添加 uncommitted changes 虚拟节点（灰色空心圆）

**颜色回收**：vscode-git-graph 的 `getAvailableColour()` 算法 —— 每个 Branch 有 `end`（该分支最后一个 commit 的 index），当 `end > currentRow` 时该颜色可回收。默认 12 色调色板：

```
#0085d9, #d9008f, #00d90a, #d98500, #a300d9, #ff0000,
#00d9cc, #e138e8, #85d900, #dc5b23, #6f24d6, #ffcc00
```

### render.tsx — 渲染方案

```
┌─────────────────────────────────────────────┐
│  ┌─SVG (left, fixed width)──┬──HTML (right)──────────────────────┐
│  │  ●───● main              │  ● main  feat: add git graph       │
│  │  │   │                   │    abc1234  author  2 hours ago    │
│  │  │   ● feat/git-graph    │  ● feat/git-graph  merge commit    │
│  │  ●───┤                   │    def5678  author  3 hours ago    │
│  │      │  ● feat/other     │  ● feat/other  some feature        │
│  │      ●───●               │    ghi9012  author  5 hours ago    │
│  │      │                   │  ○ main  Uncommitted Changes (3)   │
│  │  ●───●                   │  ● main  previous commit           │
│  └──────────────────────────┴────────────────────────────────────┘
│                              ↕ scroll
└─────────────────────────────────────────────┘
```

- 左侧 SVG（固定宽度 = `laneCount * 16 + 24`）：
  - 分支线：Cubic Bezier (`C` 命令)，参考 vscode-git-graph 的 rounded 风格（delta = `rowHeight * 0.8`）
  - commit 节点：`<circle r="4">`（HEAD 为空心圆，uncommitted 为灰色空心圆）
- 右侧 HTML 列表：
  - 每行固定高度 `rowHeight`（约 28px）
  - 显示：refs 标签、message、hash 缩写、author、日期
- **不使用 DOM 测量**：rowHeight 固定值，SVG 和 HTML 天然对齐

### 此阶段可独立测试

使用 mock 数据在开发环境渲染，验证：分支分叉/合并、颜色一致性、lane 回收、HEAD/uncommitted 指示。

---

## 阶段 2：Tab 系统集成

**目标**：将 Git Graph 组件挂入 side panel Tab 系统。

### 文件变更

| 文件                                                       | 变更                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/app/src/context/layout.tsx`                      | `nextSessionTabsForOpen()` 添加 `"git-graph"` case（context 模式） |
| `packages/app/src/pages/session/helpers.ts`                | `createSessionTabs()` 添加 `gitGraphOpen` memo + 回退链            |
| `packages/app/src/pages/session/session-side-panel.tsx`    | 新增 `<Tabs.Trigger value="git-graph">` + `<Tabs.Content>`         |
| `packages/app/src/pages/session/git-graph/tab.tsx`（新建） | Tab 主组件：数据加载 + 响应式 + 滚动持久化                         |
| 18 个 locale 文件 (`packages/app/src/i18n/*.ts`)           | 新增 `"session.tab.gitGraph": "Git Graph"`                         |

### 联动变更

- **变更模式下拉框**（`session.tsx`）：`ChangeMode` 类型扩展为 `"git" | "branch" | "session" | "turn" | "graph"`，选中 `"graph"` 时调用 `tabs().open("git-graph")` + `tabs().setActive("git-graph")`
- **滚动持久化**（`tab.tsx`）：仿照 `SessionContextTab` 模式：

```ts
const scrollKey = () => "git-graph" as const
const restore = view().scroll(scrollKey())

<ScrollView
  onScroll={(e) => view().setScroll(scrollKey(), { top: e.target.scrollTop })}
  initialScrollTop={restore.top}
>
```

---

## 阶段 3：交互增强

1. **Hover Tooltip** — 悬停 commit 圆点 → 显示完整 hash、所有 refs、时间戳
   - HTML 定位层（非 SVG title），参考 vscode-git-graph `showTooltip()`（`web/graph.ts:807-889`）
   - 彩色边框匹配 branch 颜色
   - 超出视口时 clamp

2. **分支过滤下拉** — `all` / `current` / 多选 branch
   - 重新请求 `/vcs/graph?branch=...`

3. **Scroll-to-HEAD** — 按钮/快捷键跳转到 HEAD commit 位置

4. **加载更多** — 滚动触底自动调用 `sdk.client.vcs.graph({ skip: nextSkip, max: 100 })`

5. **未提交变更** — HEAD 上方灰色空心圆
   - 复用现有 `sdk.client.vcs.diff({ mode: "git" })` 获取文件数量
   - hover 时显示变更文件列表

---

## 阶段 4：Commit 详情与 Git 操作

### Commit 详情面板

- 点击 commit → 面板从右侧或底部滑入（**非 inline 插入**，避免 `expandY` 复杂性）
- 显示：完整 author/committer/date/message body
- 文件变更列表（tree 或 list 视图，+/- 统计）
- 点击文件 → 复用 Aether 现有 diff 渲染器（`@pierre/diffs`）

```
新增 API:
GET /vcs/commit/:hash
  → { hash, parents, author, authorEmail, authorDate,
      committer, committerEmail, committerDate,
      message, fileChanges: FileChange[] }
```

### Git 操作（右键菜单）

优先级如下：

| 优先级 | 操作                      | 说明                                |
| ------ | ------------------------- | ----------------------------------- |
| P0     | Checkout branch           | 切换到某个分支                      |
| P0     | Create branch from commit | 在某个 commit 创建新分支            |
| P0     | Copy hash / message       | 复制到剪贴板                        |
| P1     | Merge into current        | 将选中 commit/branch 合并到当前分支 |
| P1     | Rebase current on this    | 将当前分支 rebase 到选中 commit     |
| P2     | Reset to this commit      | 重置当前分支（soft/mixed/hard）     |
| P2     | Revert this commit        | 回滚某个 commit                     |
| P2     | Cherry-pick               | 拣选 commit                         |
| P2     | Tag operations            | 添加/删除 Tag                       |
| P2     | Push/Pull/Fetch           | 远程同步操作                        |

操作通过后端 API 执行（新增 `/vcs/checkout`、`/vcs/merge` 等端点），或复用现有终端面板（`terminal-panel.tsx`）执行 git 命令。

---

## 阶段 5：打磨

- **性能优化**：大数据仓库的虚拟滚动（只渲染可见区域 commits）
- **主题适配**：深色/浅色主题下的配色方案（`tailwindcss` class）
- **移动端适配**：响应式布局，移动端用 `mobileTab` 机制切换
- **i18n 完整覆盖**：所有 UI 文本走国际化
- **设置面板**：用户偏好（graph 配色、默认列可见性、排序方式 date/topo/author-date）
- **分支标签对齐到 graph**（可选）：分支标签显示在 graph lane 中，而非 description 列

---

## 不在此范围的功能（明确排除）

以下 vscode-git-graph 功能不在本次集成范围：

- Graph mask/fade-out（宽度限制渐变蒙版）
- Angular graph style（仅实现 rounded 风格）
- Commit comparison（两个 commit 的比较视图）
- Code review 模式
- External diff tool 集成
- Avatar 头像获取（从 Gravatar/GitHub）
- Issue linking（从 commit message 解析 issue 引用）
- Markdown 渲染 commit message
- GPG 签名状态显示
- Interactive rebase in terminal
- 多 repo 支持（仅单 repo）

---

## 关键实现参考

### vscode-git-graph 核心文件对照

| 文件                                           | 行数  | 核心内容                                                                                        |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| `reference/vscode-git-graph/src/dataSource.ts` | 1330+ | Git 命令封装、格式字符串定义                                                                    |
| `reference/vscode-git-graph/src/types.ts`      | 1401  | 完整类型定义（GitCommit, GitFileChange, etc.）                                                  |
| `reference/vscode-git-graph/web/graph.ts`      | 913   | 图布局算法（`determinePath`、`loadCommits`）、SVG 渲染（`Branch.draw`、`Vertex.draw`）、Tooltip |
| `reference/vscode-git-graph/web/main.ts`       | -     | HTML 表格渲染、SVG-HTML 同步、commit 详情展开                                                   |

### Aether 现有代码可复用模式

| 文件                                                                | 可复用内容                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/app/src/pages/session/branch/conversation-graph-model.ts` | Lane 分配算法框架、函数式纯函数模式、Edge 路径生成           |
| `packages/app/src/pages/session/branch/conversation-graph-list.tsx` | SVG+HTML 双层渲染架构、颜色管理、滚动                        |
| `packages/app/src/pages/session/branch/sidebar-branch-view.tsx`     | SolidJS 响应式数据流（signal → memo → view）、持久化模式     |
| `packages/opencode/src/git/index.ts`                                | Effect Service 模式、`run()` → `lines()` / `text()` 解析模式 |
| `packages/opencode/src/project/vcs.ts`                              | Effect Service + 路由集成模式                                |
| `packages/app/src/context/layout.tsx`                               | Tab 状态管理、`nextSessionTabsForOpen` 路由函数              |
| `packages/app/src/pages/session/helpers.ts`                         | `createSessionTabs` 派生状态模式                             |
