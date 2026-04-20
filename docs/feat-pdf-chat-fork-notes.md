# `feat/pdf-chat` 中与会话 Fork 相关的改动说明

## 1. 这次改动想把 Fork 从什么，变成什么

- 旧语义里，`fork` 更像“从当前会话复制一个子会话”。
- 新语义里，`fork` 被提升成“任务树里的分支操作”。一个分支不再只是 `parentID` 关系，而是同时拥有：
  - 它属于哪一棵树：`treeID`
  - 它真正是从哪个会话分出来的：`forkParentSessionID`
  - 它是从父分支的哪一轮之后分出来的：`forkAfterUserMessageID`
  - 它在整棵树里是第几个 fork：`forkIndex`
- 对用户来说，结果是：fork 不再只是“再开一个会话”，而是“从某个历史节点上长出一条新的思路分支”。

## 2. 用户现在如何 Fork

- 用户仍然可以从当前会话发起 fork，但 fork 对话框现在支持传入任意 `sessionID`，因此不仅能从当前页 fork，也能从分支树中的别的节点 fork。
- fork 对话框会列出该会话里的历史用户消息，用户可以明确选“从哪一轮开始分叉”。
- 选中某条历史用户消息后，新分支会：
  - 继承该点之前的共享历史
  - 把该消息对应的输入内容恢复到新分支输入框
  - 直接跳转到新分支继续写下去
- 这很贴近真实使用场景：不是“复制整个会话”，而是“回到那一步，换一个方向继续试”。

相关实现：

- `packages/app/src/components/dialog-fork.tsx`
- `packages/app/src/pages/session.tsx`

## 3. Fork 后，系统如何决定“共享前缀”

- 后端不会简单地把父会话整段复制完。
- 它会先找出“可继承到哪里”：
  - 只把“已经形成完整 user-assistant 回合”的用户消息算作稳定锚点
  - 如果你选的是某条中间消息，它会把 fork 锚点落在“这条消息之前最后一个已完成回合”上
- 这样做的目的，是避免把尚未稳定、尚未完成的回合当成树结构的公共前缀。
- fork 时复制消息也不是无脑全拷贝：
  - 如果指定了 `messageID`，复制会在该消息之前停止
  - assistant 的 `parentID` 会在新分支里重新映射，保证新分支内部消息链完整
- 结果是：分支继承的是“稳定历史”，而不是“任意时刻的快照”。

核心逻辑：

- `packages/opencode/src/session/index.ts`

## 4. Fork 不再只是 Parent-Child，而是“整棵树里的连续编号分支”

- 每个新根会话都会拿到一个 `treeID`。
- 之后从这棵树里 fork 出来的所有分支，默认都继承同一个 `treeID`。
- `forkIndex` 是按整棵树全局递增，不是按单个父节点递增。
- 所以如果你连续从根分、从子分、再从别的分支分，标题会是：
  - `Root (fork #1)`
  - `Root (fork #2)`
  - `Root (fork #3)`
- 如果中间某个分支改名了，后续 fork 会以“当前标题”为基底，但编号仍然沿用整棵树的连续序列。
- 这解决了一个很实际的问题：用户终于能一眼看出“这些 fork 都属于同一棵实验树”。

测试覆盖：

- `packages/opencode/test/session/session.test.ts`

## 5. 系统为 Fork 新增了哪些持久化字段

- 数据库迁移新增了三组字段：
  - `tree_id`
  - `fork_parent_session_id` + `fork_after_user_message_id`
  - `fork_index`
- `parent_id` 仍然保留，但它现在更多承担“树形归属 / 子树移动”的角色。
- 真正描述“这是从哪条分支、哪一轮之后叉出去”的，是 `fork_parent_session_id` 和 `fork_after_user_message_id`。
- 这组字段组合起来，才让后面的树视图、对话图、保护性回滚、分支归档都成立。

相关文件：

- `packages/opencode/migration/20260413153000_add_session_tree_id/migration.sql`
- `packages/opencode/migration/20260413190000_add_session_fork_anchor/migration.sql`
- `packages/opencode/migration/20260416180000_add_session_fork_index/migration.sql`
- `packages/opencode/src/session/session.sql.ts`

## 6. Fork 之后，用户如何“看见”分支结构

- 这次最直接落地的是侧栏里的“对话树”。
- 打开实验开关后，工作区侧栏中的 session 列表不再只是普通 parent-child 展开，而是可以在根会话下内联展开一块 `Conversation tree`。
- 这块视图不是简单列 session 名称，而是消息级图结构：
  - 主线回合
  - 分叉点
  - 尚未产生第一条新回合的分支 bud
  - 当前路径高亮
  - 模型变化用虚线表达
- 用户能看到“当前分支是从哪一轮岔开的”，而不是只能靠标题猜。
- 视图还支持序列优先 / 时间优先、紧凑 / 完整、字号、行距、面板高度。

核心实现：

- `packages/app/src/pages/layout/sidebar-workspace.tsx`
- `packages/app/src/pages/session/branch/sidebar-branch-view.tsx`
- `packages/app/src/pages/session/branch/conversation-graph-model.ts`
- `packages/opencode/src/session/index.ts`

## 7. 分支树和对话图的后端语义

- 后端提供了两个新接口：
  - `session.tree`: 返回整棵 session 树
  - `session.graph`: 返回消息级对话图
- `tree` 解决的是“有哪些分支会话、它们彼此如何挂接”。
- `graph` 解决的是“当前分支和父分支共享了哪些回合、从哪一轮分叉、有没有空 bud 分支、当前路径是哪条”。
- `graph` 的重要设计点：
  - 同一路径的共享前缀不会被重复建模
  - fork 后如果子分支还没继续对话，会生成一个 `bud` 节点
  - 如果跨分支切换了模型，边会变成虚线
- 这说明这次 fork 系统已经不是“列表级别”的，而是“对话演化级别”的。

接口定义：

- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/test/server/session-graph.test.ts`
- `packages/opencode/test/server/session-tree.test.ts`

## 8. Fork 之后，Revert 的语义也变了

- 旧逻辑里，用户在某个历史回合点 `revert`，主要是回滚当前会话。
- 新逻辑里，系统会先判断：这个回滚点是否已经被别的分支依赖。
- 如果满足任一条件，就不允许直接破坏原路径，而是转成一次 fork：
  - 你试图回滚的是当前分支继承来的共享前缀
  - 你试图回滚的那个点之后，已经长出了别的 descendant branch
- 这很关键，因为一旦一段历史已经成为别的分支的公共祖先，它就不再只是“当前会话的私有可回滚区”。
- 对用户来说，表现就是：某些本来会 `revert` 的操作，现在会自动变成“从这里另开一支继续试”。

逻辑位置：

- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session.tsx`

## 9. 归档 / 反归档也改成了“按分支子树”处理

- 如果归档的是整棵树的根，会保持原树结构，只是整棵树一起进入归档态。
- 如果归档的是中间某个 fork 分支：
  - 这个分支和它的所有后代会被整体摘出来
  - 它会变成一个新的已归档根
  - `treeID` 会换成新的
  - 如果它原先依赖树外父分支的 fork 锚点，这些锚点关系会被清掉
- 之后再反归档时，这棵被摘出来的子树会作为独立根恢复，而不会自动挂回原树。
- 这实际上把 fork 子树当成了“可整体搬运的实验分支”。

相关逻辑：

- `packages/opencode/src/session/index.ts`
- `packages/opencode/test/session/session.test.ts`

## 10. 对 Legacy Session 的兼容策略

- 旧会话如果没有 `treeID`，系统不会强行把它解释成新树。
- `session.tree` 和 `session.graph` 会明确返回 `legacy`。
- 但用户仍然可以从 legacy session 继续 fork。
- 这时新 child 会启动一棵新的 tree，自己进入新体系。
- 这保证了老数据不需要整体迁移，也不阻断用户继续使用 fork。

## 11. 当前落地状态：哪些 Fork 能力已经真正接上，哪些还在半路

- 已真正接上的：
  - fork 从历史消息分叉
  - 新树字段入库
  - tree / graph API
  - 侧栏内联 conversation tree
  - revert 保护
  - 子树归档 / 反归档
- 已实现但看起来还没正式接到主路径的：
  - 独立的 `BranchTabPanel`
  - 独立的 `BranchGraphPanel`
- 也就是说，这次提交已经把 fork 的“底层语义”和“侧栏主入口”打通了，但更完整的“专门分支面板”可能是后续拆分点。

## 12. 本次拆分的明确边界

### 保留范围

- 后端 fork 主语义：
  - `tree_id`
  - `fork_parent_session_id`
  - `fork_after_user_message_id`
  - `fork_index`
  - `Session.create` / `Session.fork` 的新树语义
  - fork anchor 解析与 tree parent repair
- 查询接口与前端可见能力：
  - `session.tree`
  - `session.graph`
  - 侧栏内联 `Conversation tree`
  - revert 保护逻辑
- 稳健性相关的 tree 语义：
  - 子树 `archive` / `unarchive`
  - legacy session 兼容路径

### 明确排除范围

- PDF 阅读模式相关改动：
  - `reading-mode`
  - `quick-reading`
  - PDF viewer 及其资源
  - `reading-session.tsx`
  - `reading-layout.ts`
  - 阅读模式上下文与设置
- 不在主路径上的分支面板能力：
  - `BranchTabPanel`
  - `BranchGraphPanel`
  - `branch-tree-loader.ts`
  - `branch-tree-model.ts`
- 非必要的 fork 对话框扩展：
  - `DialogFork` 的 `sessionID` 可选入参扩展暂不纳入

### 依赖判断

- `archive` / `unarchive` 虽不是 fork 本体，但如果保留侧栏分支树并允许归档中间分支，它们属于稳健性依赖，应与 fork tree 一起拆出。
- 侧栏树视图依赖 `session.tree` / `session.graph` 与全局 session descendant 加载逻辑，不能只拆 UI 外壳。

## 13. 分阶段实施方案

### 阶段 1：建立拆分基线

- 从 `origin/beta` 新建拆分分支。
- 以本备忘录为边界，后续每次落改动都复核是否混入 PDF 逻辑。
- 不复用整段 cherry-pick，改为按文件和 hunk 精细拆分。

### 阶段 2：后端最小语义闭环

- 引入 `TreeID` 与 session 持久化字段：
  - `tree_id`
  - `fork_parent_session_id`
  - `fork_after_user_message_id`
  - `fork_index`
- 落三条 migration 与 `session.sql.ts` / `schema.ts` 变更。
- 在 `packages/opencode/src/session/index.ts` 中拆出：
  - fork title / fork index 逻辑
  - fork anchor 解析
  - `resolveForkParent`
  - `normalizeForkParentLink`
  - `repairTreeForkParents`
  - `createNext` / `create` / `fork` 的 tree 语义
- 这一阶段只做后端，不接入 PDF、不接入前端大 UI。

### 阶段 3：查询接口与 archive 语义

- 在 `packages/opencode/src/server/routes/session.ts` 中加入：
  - `session.tree`
  - `session.graph`
  - `session.archive`
  - `session.unarchive`
- 在 `packages/opencode/src/session/index.ts` 中加入：
  - `tree`
  - `graph`
  - 子树 `archive`
  - 子树 `unarchive`
- 保持 legacy session 返回显式 `legacy`，但允许从 legacy fork 到新 tree。

### 阶段 4：后端测试闭环

- 带入并适配以下测试：
  - `packages/opencode/test/session/session.test.ts` 中 tree / fork / archive 相关用例
  - `packages/opencode/test/server/session-tree.test.ts`
  - `packages/opencode/test/server/session-graph.test.ts`
- 先保证语义在服务端稳定，再往前端接线。

### 阶段 5：前端最小行为接线

- 在 `packages/app/src/pages/session/helpers.ts` 中加入：
  - completed turn 计算
  - inherited turn 计算
  - descendant branch 检测
  - `shouldProtectSessionRevert`
- 在 `packages/app/src/pages/session.tsx` 中只接最小行为：
  - revert 前调用 `session.graph`
  - 命中保护条件时转为 fork
- 在 `packages/app/src/context/sync.tsx` 中补 session message cache invalidate 能力，避免 revert / restore 后缓存脏读。

### 阶段 6：侧栏 Conversation Tree 主入口

- 引入以下主路径文件：
  - `packages/app/src/pages/session/branch/conversation-graph-model.ts`
  - `packages/app/src/pages/session/branch/conversation-graph-list.tsx`
  - `packages/app/src/pages/session/branch/sidebar-branch-view.tsx`
- 在以下现有主路径文件中接入最小必要改动：
  - `packages/app/src/pages/layout/sidebar-workspace.tsx`
  - `packages/app/src/pages/layout/sidebar-items.tsx`
  - `packages/app/src/pages/layout.tsx`
  - `packages/app/src/context/global-sync/session-load.ts`
  - `packages/app/src/context/global-sync.tsx`
  - `packages/app/src/context/global-sync/event-reducer.ts`
- 同时引入最小设置项：
  - `branchesTab`
  - `branchGraphFontSize`
  - `branchGraphRowDensity`
  - `branchGraphOrderMode`
- 仅保留侧栏 inline tree，不接独立分支面板。

### 阶段 7：SDK 与最终复核

- 重新生成 JS SDK 与 OpenAPI 产物。
- 复核所有改动文件，确保没有混入：
  - `reading-mode`
  - `quick-reading`
  - PDF viewer
  - 其他阅读模式上下文与页面逻辑
- 运行针对性测试与类型检查。
