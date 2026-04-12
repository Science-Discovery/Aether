# 文件状态与 Web UI 变更视图栏相关 CI 覆盖分析

本文对照 [docs/web-ui-change-view.md](./web-ui-change-view.md)，专门分析当前仓库里的 CI workflow、测试与构建流程，判断它们对文档所述行为的实际覆盖情况。

这里先固定几个口径：

- `当前 CI`：当前会在 `push dev`、`pull_request` 或手动触发时运行、且与本主题直接相关的检查。
  - `.github/workflows/test.yml` 的 `ui-unit` / `ui-unit-windows`
  - `.github/workflows/test.yml` 的 `app-unit` / `app-unit-windows`
  - `.github/workflows/test.yml` 的 `opencode-unit` / `opencode-unit-windows`
  - `.github/workflows/typecheck.yml`
- `非 CI 覆盖`：仓库里有测试或实现保护，但默认不会作为当前这组 CI 的一部分执行。
  - 主要是 `packages/app/e2e/**/*.spec.ts`
  - 以及受 `!process.env.CI` 限制的 watcher / branch 事件测试
- 覆盖强度：
  - `强覆盖`：当前 CI 中有直接断言该行为的测试
  - `中覆盖`：当前 CI 只测到底层或相邻逻辑，没有完整走到用户视角
  - `弱覆盖`：仓库里有测试，但不进当前 CI；或只有 typecheck / build
  - `无覆盖`：当前没找到对应测试

## 1. 当前 CI 到底跑什么

### 1.1 与本文最相关的 job

| workflow | job | 实际执行内容 | 对本文主题的意义 |
| --- | --- | --- | --- |
| `test.yml` | `ui-unit` / `ui-unit-windows` | `bun --cwd packages/ui test:unit` | 跑 `packages/ui/src/**/*.vitest.ts(x)`，直接覆盖 `SessionReview` 这类 UI 组件 |
| `test.yml` | `app-unit` / `app-unit-windows` | `bun --cwd packages/app test:unit` | 先跑 Bun 测试 `src/**/*.test.ts(x)`，再跑 Vitest `src/**/*.vitest.ts(x)`，覆盖前端页面状态和变更树接线 |
| `test.yml` | `opencode-unit` / `opencode-unit-windows` | `cd packages/opencode && bun test --timeout 30000` | 覆盖 Git/VCS/Snapshot/SessionSummary/Revert 等底层逻辑 |
| `typecheck.yml` | `typecheck` | `bun typecheck` | 保证跨包接口与类型关系不断裂，但不直接证明行为正确 |

### 1.2 对覆盖判断要特别注意的两点

1. Linux 与 Windows job 运行的核心测试套件基本相同。
   这显著增强了平台兼容性信心，但不会把“行为覆盖度”简单翻倍。

2. `app-unit` 现在是两层测试，不再只是 Bun 原生测试。
   它同时包含：
   - Bun 测试：适合纯逻辑状态函数，如 `session-side-panel-state.test.ts`
   - Vitest + Solid 渲染测试：适合 `file-tree.vitest.tsx`、`session-side-panel.vitest.tsx`

### 1.3 当前没进这组 CI 的相关测试

| 测试入口 | 当前状态 | 对本文主题的作用 |
| --- | --- | --- |
| `packages/app/e2e/session/session-review.spec.ts` | 仓库里有，但不在当前 CI 主线 | 覆盖 review 面板真实交互、live diff 后滚动位置等用户视角场景 |
| `packages/app/e2e/files/file-tree.spec.ts` | 仓库里有，但不在当前 CI 主线 | 覆盖文件树展开、切换和真实点击路径 |
| `packages/app/e2e/session/session-undo-redo.spec.ts` | 仓库里有，但不在当前 CI 主线 | 覆盖 `/undo` `/redo` 后 session/review 联动 |
| `packages/opencode/test/file/watcher.test.ts` | 受 `!process.env.CI` 限制 | 覆盖 live watcher 与 `.git` 事件 |
| `packages/opencode/test/project/vcs.test.ts` 的 watcher 分组 | 受 `!process.env.CI` 限制 | 覆盖 `.git/HEAD` 变化后的 `BranchUpdated` 事件 |

## 2. 整体判断

和前一版文档相比，当前 CI 的真实覆盖面已经明显增强，原因主要有三类：

- `SessionSummary` 现在有了直接单测，`session` / `turn` 语义不再只靠 snapshot 底层测试间接支撑。
- `changes` 文件树与 `review` 面板现在都有直接 Vitest 测试，不再几乎完全依赖 E2E。
- `test.yml` 已经扩展到 `ui/app/opencode` 三包、Linux/Windows 双平台，Web UI 相关测试不再只落在 `app-unit (linux)` 上。

如果只按文档里的行为点来判断，而不做代码覆盖率那种精确统计，那么当前状态更接近下面这句话：

- 后端 diff 计算层：已经是 `中到强覆盖`
- Web UI 组件层：从原先的 `弱覆盖` 提升到了 `中覆盖`
- `session.tsx` 这类前端编排与刷新时序：仍然是主要薄弱区

## 3. 与文档章节对照

### 第 0 章：术语

| 文档章节 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `0. 两个必须了解的术语` | `无覆盖` | 这是解释性文字，不是可执行行为。 |

### 第 1 章：先给结论

| 文档章节 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `1. 先给结论` | `中覆盖` | `FileDiff[]` 作为统一数据结构这一点有大量测试支撑；但“结论文本”本身不可能被 CI 直接验证。 |

### 第 2 章：相关代码入口

| 文档章节 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `2. 相关代码入口` | `中覆盖` | `typecheck` 保证入口之间的类型关系；`ui/app/opencode` 单测则直接覆盖其中一部分核心入口。 |

### 第 3 章：UI 结构和用户看到的界面

| 文档章节 | 当前 CI 覆盖 | 非 CI 覆盖 | 说明 |
| --- | --- | --- | --- |
| `3.1 桌面端结构` | `中覆盖` | `panels.spec.ts` | `session-side-panel-state.test.ts` 覆盖桌面双栏/单栏纯状态分支，`session-side-panel.vitest.tsx` 覆盖 `changes/all` 接线；但仍缺完整 DOM 结构集成测试。 |
| `3.2 移动端结构` | `弱覆盖` | `无` | `session-side-panel-state.test.ts` 只覆盖“移动端关闭侧栏”的纯状态，不覆盖真实移动端 `Session / Changes` 顶部切换。 |
| 本章整体 | `中偏弱覆盖` | `有` | 桌面端明显增强，移动端仍是空白区。 |

### 第 4 章：所有“分类”到底有哪些

| 文档章节 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `4.1 第一层分类：变更来源模式` | `中覆盖` | 后端 `git / branch / session / turn` 语义现在都有更多直接测试，但前端 `changesOptions()` 仍没有专门测试。 |
| `4.2 第二层分类：文件状态` | `强覆盖` | `vcs.test.ts`、`snapshot.test.ts`、`summary.test.ts` 都会直接断言 `added / deleted / modified`。 |
| `4.3 第三层分类：内容展示状态` | `中覆盖` | `session-review.vitest.tsx` 直接覆盖 Added / Removed / Modified 以及大 diff 保护；媒体分支仍偏弱。 |

### 第 5 章：四种模式分别怎么计算

| 文档章节 | 当前 CI 覆盖 | 非 CI 覆盖 | 说明 |
| --- | --- | --- | --- |
| `5.1 git 模式` | `强覆盖` | `无` | `packages/opencode/test/project/vcs.test.ts` 直接覆盖 `diff('git')`。 |
| `5.2 branch 模式` | `强覆盖` | `watcher` 分组 | `vcs.test.ts` 与 `git.test.ts` 覆盖 merge-base、默认分支与 branch diff 语义。 |
| `5.3 session 模式` | `强覆盖` | `session-review.spec.ts` | `packages/opencode/test/session/summary.test.ts` 已直接覆盖基线快照、人工编辑纳入、`SessionSummary.diff()` 幂等与 fallback。 |
| `5.4 turn 模式` | `中到强覆盖` | `无` | `summary.test.ts` 已直接覆盖“只包含指定用户消息及其 assistant 回复”的语义。 |
| 本章整体 | `强覆盖` | `有` | 这章已经不再是薄弱区。 |

### 第 6 章：`FileDiff` 的具体生成规则

| 文档章节 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `6.1 文本内容` | `强覆盖` | `snapshot.test.ts` 与 `summary.test.ts` 会直接检查 `before/after` 与文件列表。 |
| `6.2 增删行数` | `强覆盖` | `git.test.ts`、`snapshot.test.ts` 会断言 `additions/deletions`。 |
| `6.3 状态判定` | `强覆盖` | 这一层本来就最稳，现在仍然是全文最强覆盖区之一。 |

### 第 7 章：前端如何选择和维护当前模式

| 文档章节 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `7. 前端如何选择和维护当前模式` | `弱到中覆盖` | `session.tsx` 里的 `changesOptions()`、`reviewDiffs()`、`reviewReady()`、`sessionCount()` 仍没有直接测试。现有测试更多落在辅助状态和组件接线上。 |

最接近本章的当前 CI 测试主要是：

- `packages/app/src/pages/session/session-side-panel-state.test.ts`
- `packages/app/src/context/global-sync/event-reducer.test.ts`
- `packages/app/src/context/global-sync/session-cache.test.ts`

但它们仍然没有直接把“模式选择与计数切换”整条链路跑起来。

### 第 8 章：触发时机：什么时候会加载或刷新变更

| 文档章节 | 当前 CI 覆盖 | 非 CI 覆盖 | 说明 |
| --- | --- | --- | --- |
| `8.1 总览：三种数据流动模式` | `中覆盖` | `session-review.spec.ts` | 三条数据流动路径在实现中成立，但没有专门测试“某模式一定走哪条链路”。 |
| `8.2 wantsReview 门控` | `无覆盖` | `无` | 仍没有直接测试“未打开 review/changes 时不主动加载 diff”。 |
| `8.3 初始加载` | `弱覆盖` | `无` | 没有直接断言四种模式首次进入时的加载路径。 |
| `8.4 AI 执行完成后的刷新` | `弱到中覆盖` | `session-review.spec.ts`、`session-undo-redo.spec.ts` | 有 E2E 研究素材，但当前 CI 里没有直测。 |
| `8.5 外部文件变化` | `中覆盖` | `file/watcher.test.ts` | app 侧有 watcher 辅助测试，但 live watcher 仍不进当前 CI。 |
| `8.6 会话切换` | `弱到中覆盖` | `无` | 缓存清理有测，“先展示缓存、后台刷新”仍没直测。 |
| `8.7 分支信息变化` | `弱覆盖` | `project/vcs.test.ts` 的 watcher 分组 | `.git/HEAD` 事件仍主要依赖 CI 外测试。 |
| `8.8 用户文件操作与手动刷新` | `弱到中覆盖` | `file-tree.spec.ts` | 局部 helper 有测，完整刷新链路没直测。 |
| `8.9 回退与取消回退` | `中覆盖` | `session-undo-redo.spec.ts` | revert 底层较强，UI 联动主要还在 E2E。 |
| `8.10 防抖与去重保护` | `弱覆盖` | `无` | `vcsTask`、`vcsRun`、session inflight 去重仍没有直接测试。 |
| `8.11 触发关系速查表` | `中偏弱覆盖` | `同上` | 这一节本质上是前面 8.x 的总结。 |

### 第 9 章：文件树中的 `changes` 栏是如何工作的

| 文档章节 | 当前 CI 覆盖 | 非 CI 覆盖 | 说明 |
| --- | --- | --- | --- |
| `9.1 它本质上是一个“过滤后的文件树”` | `强覆盖` | `file-tree.spec.ts` | `file-tree.vitest.tsx` 直接覆盖 `allowed` 过滤、父目录保留、已删除文件合成与 A/D/M 标记。 |
| `9.2 点击行为不是“打开文件”，而是“定位 diff”` | `中覆盖` | `无` | `session-side-panel.vitest.tsx` 已直接覆盖 `changes` tab 点击走 `focusReviewDiff`，但还不是完整端到端。 |
| `9.3 all 标签中的文件树又是什么` | `中覆盖` | `file-tree.spec.ts` | `session-side-panel.vitest.tsx` 已覆盖 `all` tab 传 `modified` 并按普通语义打开文件。 |
| 本章整体 | `中到强覆盖` | `有` | 这是本轮补强后提升最明显的章节之一。 |

### 第 10 章：审查面板 `review` 如何工作

| 文档章节 | 当前 CI 覆盖 | 非 CI 覆盖 | 说明 |
| --- | --- | --- | --- |
| `10.1 它是逐文件手风琴` | `中覆盖` | `session-review.spec.ts` | `session-review.vitest.tsx` 已覆盖展开/收起全局状态；但仍缺更复杂的交互链测试。 |
| `10.2 两种 diff 样式` | `无覆盖` | `无` | 仍未看到对 `split / unified` 切换的直接测试。 |
| `10.3 打开状态与滚动位置会被记住` | `中覆盖` | `session-review.spec.ts` | 当前 CI 只覆盖底层 scroll persistence 辅助逻辑，不覆盖 live diff 更新后的真实阅读位置。 |
| `10.4 两层性能保护` | `中覆盖` | `无` | `session-review.vitest.tsx` 已直接覆盖大 diff “Render anyway”；`reviewBatch` 仍缺直接测试。 |
| `10.5 从 review 打开文件时优先真实文件` | `弱覆盖` | `session-review.spec.ts` | 仍缺“旧草稿存在时优先真实文件”的直接断言。 |
| `10.6 旧草稿是待决定的分支` | `中覆盖` | `无` | `file-tab-state.test.ts` 仍只覆盖底层判定。 |
| `10.7 恢复旧草稿后保存仍可能再次确认` | `无覆盖` | `无` | 这一条仍没有直接测试。 |
| 本章整体 | `中覆盖` | `有` | 相比旧状态明显提升，但还有几个关键交互空白。 |

### 第 11 章：空态、加载态和边界行为

| 文档章节 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `11.1 空态` | `弱覆盖` | 仍未看到直接断言空态文案的测试。 |
| `11.2 非 Git 项目` | `中覆盖` | 后端 `branch()` / `defaultBranch()` 的 fallback 有测，但前端文案与按钮没有直测。 |
| `11.3 已删除文件` | `强覆盖` | `file-tree.vitest.tsx` 与 snapshot / summary 测试共同覆盖。 |
| `11.4 重命名文件` | `弱覆盖` | 文档结论仍主要来自实现 `--no-renames`，缺专门测试。 |
| `11.5 媒体与大文件` | `中覆盖` | 大 diff 保护已有直接 UI 测试；媒体路径仍偏弱。 |
| `11.6 旧草稿与当前真实文件冲突` | `中覆盖` | 底层 stale/fresh 判定有测，但真实交互链路仍空。 |
| 本章整体 | `中覆盖` | 删除文件、大 diff 已经更强；空态、rename、旧草稿交互仍偏弱。 |

### 第 13 章：实现上的几个关键事实

| 文档中的关键事实 | 当前 CI 覆盖 | 说明 |
| --- | --- | --- |
| `changes` 树不计算 diff，只负责导航与标记 | `中覆盖` | `file-tree.vitest.tsx` 与 `session-side-panel.vitest.tsx` 已直接触达这层语义。 |
| `session diff` 会在请求时重新对“会话基线 -> 当前工作区”做快照比较 | `强覆盖` | `summary.test.ts` 已直接覆盖。 |
| `turn diff` 不走独立接口，而是挂在用户消息 summary 上 | `中到强覆盖` | `summary.test.ts` 已直接覆盖消息级 summary 隔离。 |
| `branch` 模式使用 merge-base | `强覆盖` | 由 `git.test.ts` 与 `vcs.test.ts` 覆盖。 |
| `/session/:id/diff` 的 `messageID` 当前未使用 | `强覆盖` | `summary.test.ts` 现已直接验证 `messageID` 不影响结果。 |
| summary 稳定依赖数量字段，完整 diff 主要存放在 `session_diff` | `中覆盖` | `summary.test.ts` 覆盖 `session_diff` 重写与 summary 更新，但前端读取链仍缺直测。 |
| VCS 模式前端有并发保护 | `无覆盖` | 这一点仍没有专门测试。 |

## 4. 现在真正还薄弱的地方

即使把本轮新增测试算进去，下面几块仍然是最明显的缺口：

1. `session.tsx` 的编排层。
   `changesOptions()`、`wantsReview`、`reviewReady()`、`sessionCount()`、idle 后自动重拉 VCS diff，这些仍缺直接测试。

2. 移动端结构与行为。
   当前新增测试主要覆盖桌面端、纯状态和组件接线，移动端 `Session / Changes` 切换仍几乎没被验证。

3. `review` 与旧草稿冲突链路。
   stale/fresh 判定有底层测试，但“从 review 打开文件 -> 顶部提示 -> 恢复旧草稿 -> 保存时再次确认”整条链路仍未被 CI 保护。

4. 前端并发与刷新时序。
   `vcsTask` / `vcsRun`、session inflight 去重、会话切换后的双阶段刷新，仍主要靠代码阅读而不是测试。

## 5. 结论

当前这两份文档所描述的能力，已经不再是“后端强、前端几乎没保”的状态了。更准确的说法应该是：

- 后端 diff 计算与 `session/turn` 语义：现在已有扎实的直接单测。
- `changes` 文件树与 `review` 面板：现在已有可观的组件级 CI 覆盖。
- 前端模式编排、刷新时序、移动端和旧草稿冲突交互：仍然是主要薄弱区。

如果只看与这份 Web UI 文档对应的部分，当前 CI 已经能比较可靠地兜住“diff 算得对不对”“changes 树和 review 组件基本行为是否还在”；但还不能把“会话页所有联动与刷新时序都符合文档”视为已经被完全自动化验证。
