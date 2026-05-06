# Aether 记忆系统（当前实现）

本文只描述当前已落地实现。

## 1. 三层缓存

- L1：active memory prompt。`USER.md` 中的稳定用户画像会以小上限 baseline 注入；inbox/daily/session 记忆只有被自动召回、`memory_search` 命中、或本轮 `memory_write` 写入后才进入模型 system prompt，整体约 4000 字符上限。
- L2：session memory pool。会话启动时从磁盘准备；`USER.md` 用于 L1 baseline 与搜索，pending inbox、daily、当前 session short-term memory 默认不全量注入，只由 `memory_search` 或自动召回使用。
- L3：磁盘冷存储。包含 `USER.md`、pending inbox、daily memory、当前 session short-term memory、reflection run log。

## 2. 磁盘路径

- 用户画像：`memory/user/USER.md`
- 待反思跨会话记忆：`memory/inbox/MEMORY.md`
- 每日长期记忆：`memory/daily/YYYY-MM-DD/MEMORY.md`
- 当前会话短期记忆：`memory/session/<session_id>/MEMORY.md`
- 反思日志：`memory/reflection/run/<run_id>.json`

旧的 `memory/scope/<scopeKey>/MEMORY.md` 和 `ABSTRACT.md` 已废弃，新的 L2 pool 不再读取这些路径。

## 3. 条目格式

`USER.md` 与 daily memory 统一使用：

```text
kind[source]: content
```

```text
kind[source]: scope(global|project-...|workspace-...|session-...): content
```

- `kind`：`fact | preference | task`
- `USER.md` 的 `source`：`explicit | inferred`
- daily memory 的 `source`：只写 `explicit`
- 条目可选前缀：`scope(global)`、`scope(project-...)`、`scope(workspace-...)`、`scope(session-...)`。实际位置在 `kind[source]:` 之后，即 `kind[source]: scope(...): content`。`scope(global)` 与无 scope 条目一样全局可见；project/workspace/session scope 只进入匹配上下文的 L2 pool，用于处理不同项目或会话偏好冲突。

## 4. 会话工作流

- 会话启动时构建 L2 pool，并将 `USER.md` 画像以小上限注入 L1；inbox/daily/session 长期内容不全量注入。
- 每轮模型调用前，会根据最新用户消息执行最多 5 条自动召回。
- `memory_search` 支持常见分隔符拆分多个关键词，任意关键词命中即候选。
- 搜索命中会静默加入 L1，并在本 session 后续持续注入。
- `memory_reload` 会重新读取 L2，并清空 L1 active memory。
- 普通文件工具不应读取记忆目录；agent 需要召回记忆时应使用 `memory_search`，需要管理记忆时才使用 `memory_read` / `memory_list`。

## 5. 写入与反思

- `memory_write` 永远写入当前 session short-term memory，不直接修改 `USER.md` 或 daily memory。
- 看起来需要跨会话立即生效的条目（例如用户要求长期记住、默认偏好、项目事实、任务）会同时镜像到 pending inbox。因此用户在一个 session 写入全局偏好后，另一个新 session 可以立刻通过 `memory_search` 找到它，不必等到凌晨 reflection。
- 如果条目只适用于某个 project/workspace/session，agent 应写入 `scope(...)` 前缀，避免全局偏好污染。
- `memory_reflect` 会调用 LLM，将 short-term memory 与 pending inbox 整理为 daily memory，并对 `USER.md` 生成 add/replace/remove patch。
- `memory_reflect` 的提示词会要求 LLM 先处理矛盾和重复：显式记忆优先于 inferred 记忆；窄 scope 记忆优先于全局冲突记忆；部分冲突时只替换冲突片段并保留不冲突细节；更新已有画像时优先 replace/remove，而不是 add。
- 本地后处理会去除等价的 daily memory，并防止 `USER.md` 中因为 explicit/inferred 来源不同而出现同内容重复；如果新增 explicit 条目与已有 inferred 条目等价，会将 inferred 升级为 explicit。
- reflection 成功且非 dry-run 后会移除已经处理过的 pending inbox 条目。
- daily cron 会每天触发一次 `memory_reflect`。没有当天 short-term memory 且没有 pending inbox 时跳过并写入 skipped run log。

### Reflection 范围

`memory_reflect` 支持三个范围：

- `current_session`：只处理当前 session short-term memory，以及明确标记 `scope(session-<session_id>)` 的 inbox 条目。
- `current_scope`：处理当前 project/workspace/session 可见的今日 short-term memory 与 inbox 条目。
- `global`：处理今日所有 short-term memory 与全部 inbox 条目。

未标记 scope 或 `scope(global)` 的 inbox 条目不会被 `current_session` reflection 消费，留给 global reflection 处理，避免一个 session 抢先清掉另一个 session 也需要的 pending memory。

## 6. 配置

当前有效字段：

- `memory.enabled`：启用记忆工具、召回与内置 daily reflection cron，默认 `true`。
- `memory.memory_reflection_model`：可选，指定 reflection 使用的模型。

`session_search` 和 `session_read` 已移除；agent 不再读取旧 session 正文，召回内容只来自 memory files。

已废弃字段会在配置加载时清理：

- `memory_reflection_enabled`
- `user_profile_enabled`
- `user_profile_include_inferred`
- `memory_management_model`
- `user_profile_history_extract_enabled`
- `user_profile_history_extract_limit`

## 7. 工具与接口

Agent 可用工具：

- `memory_write`：写当前 session short-term memory；耐久倾向条目可镜像到 pending inbox。
- `memory_search`：搜索 L2 pool，并将命中条目加入 L1。
- `memory_reload`：重新加载 L2，并清空当前 L1 active memory。
- `memory_reflect`：手动触发 reflection。
- `memory_read`：显式记忆管理读取，不用于普通召回。
- `memory_list`：显式记忆管理列表，不用于普通召回。

HTTP/SDK：

- `GET /memory` 返回 `settings`、`user`、`inbox`、`memory`、`daily`，传入 `session_id` 时额外返回当前 session 的 `active` L1 内容。
- 生成的 SDK 使用 `Memory.get({ session_id })` 读取 Memory 设置页所需数据。

## 8. Cron 集成

服务启动时会确保存在可编辑、可删除后重建的内置 job：

```json
{
  "id": "builtin-memory-reflection-daily",
  "name": "Daily memory reflection",
  "mode": "direct",
  "schedule_type": "cron",
  "schedule_value": "0 3 * * *",
  "payload": {
    "action": "memory_reflect",
    "scope": "global",
    "dry_run": false,
    "trigger": "cron"
  }
}
```

如果 Aether 在预定时间未运行，服务下一次启动后会检查内置 reflection job 是否已经 overdue；若 memory 与 cron 均启用且任务不在运行中，会立刻在后台补执行一次 scheduled reflection。普通 cron job 仍保持启动恢复时不立即执行的保护。

## 9. 前端展示

Settings > Memory 展示：

- 总开关（`memory.enabled`）。
- 当前 session 的 L1 active memory 与 prompt preview。
- pending inbox。
- `USER.md`，按 explicit/inferred 分组。
- 最近 30 个有 daily memory 的日期，倒序展示。

## 10. 当前限制

- 不使用 embedding 或向量检索。
- Reflection 依赖可用 LLM；没有候选 short-term memory 和 pending inbox 时不会调用 LLM。
- 旧 scoped memory 与 `ABSTRACT.md` 不再参与新的 L2 pool。
- 每个 session 的 L1 active memory 有约 4000 字符上限；过长条目会被截断或留在 L2/L3 中等待搜索。
