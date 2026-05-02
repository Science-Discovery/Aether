# Aether 记忆系统（当前实现）

本文只描述当前已落地实现。

## 1. 三层缓存

- L1：active memory prompt。`USER.md` 中的稳定用户画像会以小上限 baseline 注入；baseline 先选 explicit，再选 inferred，并在同类内使用 `user-meta.json` 的使用反馈分数排序。daily/session 记忆只有被自动召回、`memory_search` 命中、或本轮 `memory_write` 写入后才进入模型 system prompt，整体约 4000 字符上限。
- L2：session memory pool。会话启动时从磁盘准备；`USER.md` 用于 L1 baseline 与搜索，daily/session 记忆默认不注入，只由 `memory_search` 或自动召回使用。
- L3：磁盘冷存储。包含 `USER.md`、USER sidecar metadata、daily memory、当前 session short-term memory、reflection run log。

## 2. 磁盘路径

- 用户画像：`memory/user/USER.md`
- 用户画像 metadata：`memory/user/user-meta.json`
- 每日长期记忆：`memory/daily/YYYY-MM-DD/MEMORY.md`
- 当前会话短期记忆：`memory/session/<session_id>/MEMORY.md`
- 反思日志：`memory/reflection/run/<run_id>.json`

旧的 `memory/scope/<scopeKey>/MEMORY.md` 和 `ABSTRACT.md` 已废弃，新的 L2 pool 不再读取这些路径。

## 3. 条目格式

`USER.md` 与 daily memory 统一使用：

```text
kind[source]: content
```

- `kind`：`fact | preference | task`
- `USER.md` 的 `source`：`explicit | inferred`
- daily memory 的 `source`：只写 `explicit`

## 4. 会话工作流

- 会话启动时构建 L2 pool，并将 `USER.md` 画像以小上限注入 L1；daily/session 长期内容不全量注入。
- 每轮模型调用前，会根据最新用户消息执行最多 5 条自动召回。
- `memory_search` 会保留短语、拆分常见中英文分隔符、为中文片段生成低权重 2/3 字 n-gram，并按相关性分数排序，source priority 作为辅助信号。
- 搜索命中会静默加入 L1，并在本 session 后续持续注入。
- 搜索选中 USER 条目时会更新 `user-meta.json` 的 `selected_count`；默认 pin 后仍留在 active state 的 USER 条目才会更新 `pin_count`。`activePrompt()` 本身不写 metadata，也不自增 `prompt_count`。
- `memory_reload` 会重新读取 L2，并清空 L1 active memory。

## 5. 写入与反思

- `memory_write` 永远写入当前 session short-term memory，不直接修改 `USER.md` 或 daily memory。
- 如果用户要求长期记住，agent 应把这个意图写进 short-term memory。
- `memory_reflect` 会调用 LLM，将 short-term memory 整理为 daily memory，并对 `USER.md` 生成 add/replace/remove patch。
- daily cron 会每天触发一次 `memory_reflect`，没有当天 short-term memory 时跳过并写入 skipped run log。

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

## 7. Cron 集成

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

## 8. 前端展示

Settings > Memory 展示：

- 总开关、跨会话搜索开关、跨会话搜索范围。
- 当前 session 的 L1 active memory 与 prompt preview。
- `USER.md`，按 explicit/inferred 分组。
- 最近 30 个有 daily memory 的日期，倒序展示。
