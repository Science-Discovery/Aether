# Aether 记忆系统（当前实现）

本文只描述当前代码实现（`packages/opencode` + `packages/app`），不包含已移除或未落地设计。

## 1. 系统概览

当前采用双仓模型：

- `MEMORY`：项目/工作区相关的持久事实
- `USER`：用户画像条目（偏好/约束/能力等）

主代理自行决定何时调用工具写入与检索，不存在单独的“记忆管理模型路由”热路径。

## 2. 持久化与作用域

- 存储位置在 Aether data 目录（非项目仓库文件）：
  - `USER`：`.../memory/user/USER.md`（全局）
  - `MEMORY`：`.../memory/scope/<scopeKey>/MEMORY.md`（作用域）
- `scopeKey` 规则：
  - 有 `workspaceID`：`workspace-<id>`
  - 否则若项目非 global：`project-<projectID>`
  - 否则：按工作目录绝对路径 hash（`directory-<sha1前缀>`）
- 当前容量上限：
  - `USER`：12000（按条目拼接文本长度计）
  - `MEMORY`：12000
- 单条长度限制：
  - `USER`：200 字符（内容部分）
  - `MEMORY`：300 字符

## 3. 设置面（Settings > Memory）

当前仅有以下设置（默认值见代码）：

- `cross_session_search_enabled`（默认 `true`）
- `cross_session_search_scope`：`current_project | global`（默认 `current_project`）
- `memory_reflection_enabled`（默认 `true`）
- `user_profile_enabled`（默认 `true`）
- `user_profile_include_inferred`（默认 `true`）

已移除的旧设计项（当前实现不存在）：

- `memory_management_model`
- `user_profile_history_extract_enabled`
- `user_profile_history_extract_limit`

## 4. 工具面与后端能力

已注册工具（当前实现）：

- `memory_write`（`add | replace | remove`）
- `memory_read`
- `memory_list`
- `memory_search`
- `memory_reflect`（`light | strong`，可指定仓）
- `session_search`
- `session_read`

另外，`GET /memory` 返回只读快照：

- `settings`
- `user` 仓状态
- `memory` 仓状态

## 5. USER 条目格式与注入优先级

`USER` 条目严格格式：

```text
type[source]: content
```

- `type`：`style | workflow | preference | constraint | capability`
- `source`：`explicit | inferred`
- `inferred` 仅允许 `style | preference | capability`

会话启动时会生成并冻结 memory snapshot，注入系统提示，用户画像优先级明确为：

1. 当前轮用户指令优先级最高。
2. 未被当前轮覆盖时，`explicit` 作为强 standing instructions / preferences。
3. `inferred` 仅作为弱提示，且不得与前两者冲突。

当 `user_profile_include_inferred=false` 时，`inferred` 仍可留在磁盘仓，但不会注入快照提示。

## 6. 写入、安全与反思

`memory_write` 流程要点：

- 安全扫描拦截：prompt injection、secret、exfiltration、不可见字符
- 去重/规范化后执行轻量反思；超容量时触发强反思（merge/compact）
- 仍超限则阻断写入（`capacity_limit`）
- 若最终无实质变化，返回 `noop` 事件（不会伪报成功新增）

反思机制：

- 会话首次 `snapshot` 时对 `MEMORY`、`USER` 执行启动强反思（按开关）
- 成功写入后自动轻反思（按开关）
- 可由主代理显式调用 `memory_reflect` 主动触发

## 7. 跨会话检索与读取

### 7.1 `session_search`

- 按分隔符分词（空白、`,，;；/|、`），去空、去重
- 单条 SQL（含文本分支 + title-only 回退分支）
- 支持命中：
  - 消息文本（排除 memory receipt 文本）
  - 会话标题
- title-only 回退支持“无真实文本”会话（包括仅 receipt 文本 part 的会话）
- 输出按会话聚合：每会话一条，snippets 最多 3 条
- 排序：先 `updated_at` 降序，再 `hits` 降序

### 7.2 `session_read`

- 仅分页读取指定会话完整消息（按 message 分页，不按字符）
- 需显式授权：只有用户明确请求“完整/原文/全量历史”后可读第一页
- continuation（如 next page / continue）仅对同一 target session 延续有效

## 8. 回执与可见性

后端提供 `Memory.format(events)`：

- 分段输出 `Memory updates` 与 `Memory failures`
- 每段最多展示 5 条，超出给出剩余计数

前端 Memory 页面提供只读仓视图：

- `MEMORY` 仓原样列表
- `USER` 仓按 `explicit / inferred` 分组展示
