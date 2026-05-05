# Aether 记忆系统（当前实现）

本文只描述当前已落地实现。

## 1. 运行层与存储区

从运行角度看，当前仍是三层：

- L1：active memory prompt。`USER.md` 中的稳定用户画像会以小上限 baseline 注入；baseline 先选 explicit，再选 inferred，并在同类内使用 `user-meta.json` 的使用反馈分数排序。inbox/daily/session 记忆只有被自动召回、`memory_search` 命中、或本轮 `memory_write` 写入后才进入模型 system prompt，整体约 4000 字符上限。
- L2：session memory pool。会话启动时从磁盘准备；`USER.md` 用于 L1 baseline 与搜索，pending inbox、daily、当前 session short-term memory 默认不全量注入，只由 `memory_search` 或自动召回使用。
- L3：长期文件与持久化派生状态。包含人类可读 memory files、USER sidecar metadata、pending inbox、per-session snapshot、per-session active state、reflection run log 与 refresh/backfill artifacts；进程内缓存只影响当前服务进程内的读取复用。

从实际存储角度看，memory 现在分成 9 块：

1. 全局用户画像：`memory/user/USER.md`。这是 USER 记忆的人类可读真源，会进入 L1 baseline，也会进入 L2 搜索池。
2. 用户画像 metadata：`memory/user/user-meta.json`。这是 USER 条目的 sidecar 使用反馈，不是记忆真源。
3. pending inbox：`memory/inbox/MEMORY.md`。保存尚未 reflection、但需要跨 session 立即可搜的待处理条目。
4. 全局 daily memory：`memory/daily/YYYY-MM-DD/MEMORY.md`。reflection 将 session short-term memory 整理到这里。
5. 当前 session 节点的 short-term memory：`memory/session/<session_id>/MEMORY.md`。`memory_write` 永远写这里。
6. reflection run log：`memory/reflection/run/<run_id>.json`。记录 reflection 是否执行、跳过、写入或失败。
7. prepared snapshot：`storage/memory/snapshot/<session_id>.json`。这是某个 session 启动/重载后准备好的 L2 派生快照。
8. active memory state：`storage/memory/active/<session_id>.json`。记录当前 session 已经 pin 到 L1 的条目。
9. 进程内状态：`liveEvents`、`frozenSnapshots`、`activeMemory`。这些只在当前服务进程中存在，不是 durable memory。
10. memory refresh system artifacts：`memory/system/refresh-ledger.json`、`memory/system/staging/<run_id>/candidates.json`、`memory/system/artifact-index.json`、`memory/system/backup/latest/`。这些记录 memory version refresh/backfill 的版本状态、run log、source coverage、staging candidate hash/provenance、promoted artifact index 和最近一次 durable memory 备份；它们是 memory 自有维护账本，不是人类可读 memory 内容。

下文的 `memory/...` 路径位于 `Global.Path.data/memory/` 下；`storage/...` 路径位于 `Global.Path.data/storage/` 下。

## 2. 持久化路径

- 用户画像：`memory/user/USER.md`
- 待反思跨会话记忆：`memory/inbox/MEMORY.md`
- 用户画像 metadata：`memory/user/user-meta.json`
- 每日长期记忆：`memory/daily/YYYY-MM-DD/MEMORY.md`
- 当前 session 节点短期记忆：`memory/session/<session_id>/MEMORY.md`
- 反思日志：`memory/reflection/run/<run_id>.json`
- memory refresh ledger：`memory/system/refresh-ledger.json`
- refresh staging：`memory/system/staging/<run_id>/candidates.json`
- refresh artifact index：`memory/system/artifact-index.json`
- refresh latest backup：`memory/system/backup/latest/`
- L2 prepared snapshot：`storage/memory/snapshot/<session_id>.json`
- L1 active state：`storage/memory/active/<session_id>.json`

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
- `memory_search` 会保留短语、拆分常见中英文分隔符、为中文片段生成低权重 2/3 字 n-gram，并按相关性分数排序，source priority 作为辅助信号。
- 搜索命中会静默加入 L1，并在本 session 后续持续注入。
- 搜索选中 USER 条目时会更新 `user-meta.json` 的 `selected_count`；默认 pin 后仍留在 active state 的 USER 条目才会更新 `pin_count`。`activePrompt()` 本身不写 metadata，也不自增 `prompt_count`。
- `memory_reload` 会重新读取 L2，并清空 L1 active memory。
- 普通文件工具不应读取记忆目录；agent 需要召回记忆时应使用 `memory_search`，需要管理记忆时才使用 `memory_read` / `memory_list`。

## 5. Memory version refresh / backfill V1

- 当前 refresh 版本为 `memory-v1-tree-backfill`。`GET /memory` 返回 refresh status；已完成版本默认 no-op，未完成版本显示 pending/running/failed/blocked/completed。
- `POST /memory/refresh/dry-run` 仍只执行 inventory/source-ledger 扫描，不写 memory 正文。
- `POST /memory/refresh/run` 执行完整 V1 refresh：复用 tree-aware collector，只处理唯一 logical user turns；从 user text 生成 staging candidates；按历史 day 做 backfill reflection；add-only 写入 daily memory 和 `USER.md`；补齐 USER metadata/provenance；写 artifact index；最后刷新 prepared snapshot/search pool 并 remap active state。接口支持 `scope=current_project|global`，也支持 `force=true`；未带 `force` 时按 ledger coverage 只处理新增/未覆盖来源，没有新来源则记录 `noop`；带 `force` 会重新扫描对应范围，但仍保持聊天 DB 只读、不回放 `memory_write`、不改旧 memory 正文等 V1 边界。
- Settings > Memory 当前提供单一手动入口：“补录记忆”。该按钮调用 `scope=global`，默认只补新增/未覆盖来源，暂时不把 memory version / no-op 概念暴露给用户；`memory.enabled=false` 时按钮不可点击；点击后显示“后台正在补录记忆”，运行中按钮保持禁用，切到别的界面再回来也不会重新变成可点击，hover 提示“正在补录记忆”，直到本次 run 结束；服务启动、打开 app、打开 Settings 或进入聊天时不会自动触发 backfill。
- 补录完成后，Settings > Memory 会显示结果弹窗，包含 run status、候选记忆数、生成的 daily memory 数、追加到 `USER.md` 的习惯数。候选记忆是进入 reflection 的中间候选，不等于最终写入条目。
- 聊天 DB 始终只读。refresh 不修改 `session` / `message` / `part` 表，不回放 `memory_write`，不写旧 session short-term memory，不生成聊天 tool part。
- staging source of truth 是 `memory/system/staging/<run_id>/candidates.json`。run 期间保存可安全使用的候选正文用于 reflection；promote 成功后默认删除候选正文，只保留 candidate id、text hash、logical fingerprint、physical refs、source state、confidence 和状态。风险命中的候选、以及当前无法证明原始 turns 不可访问的 `summary_only` source，不写候选正文。
- durable promote 前会清理上一次 backup，并把当前 durable memory 备份到 `memory/system/backup/latest/`；manifest 记录 run id、文件相对路径、sha1 和大小。
- reflection run log 继续写在 `memory/reflection/run/<run_id>-<target_day>.json`，trigger 为 `backfill`，并记录 target day、staging run/file/candidate ids、summary/error。
- global memory 配置是唯一 runtime 配置来源：项目配置里的 `memory.enabled` 和 `memory.memory_reflection_model` 不参与 memory runtime 判断。global 关闭时，memory tool、召回、reflection 和 refresh/backfill 都按关闭处理。refresh run 不扫描、不生成、不 promote，只记录 `blocked_by_disabled`；恢复启用后可继续运行。
- exact/canonical duplicate 与已有 durable memory 或同 run staging candidate 去重；风险输入被 blocked 且不落候选正文；`summary_only` 来源在当前 V1 中保守 blocked，只记录低置信 provenance，不进入 generator，也不写正文。
- promote durable 写入采用先备份、再计划写入、失败回滚的路径；`artifact-index.json` 同时记录 promoted artifact hash 和 durable before/after hash 索引。`GET /memory` refresh status 会带出最近 run 的 scope、stage、staging/backup path、候选/blocked/deduped/promoted 计数和错误信息。
- refresh 不增加 `selected_count` / `pin_count`，也不做 historical usage replay。已有 memory 正文不被静默改写；reflection 返回的 replace/remove 只记录为 conflict/review-needed artifact，不自动应用。

## 6. Session tree 下的语义

当前 session 已经有 `treeID`、`forkParentSessionID`、`forkAfterUserMessageID` 等分支信息。live memory 文件、prepared snapshot 和 active state 仍没有按 session tree 建模；refresh/backfill 第一阶段的 source collector 已经 tree-aware，只用于历史 source 扫描和去重。

- Memory 的 short-term 文件、prepared snapshot、active state 都按当前 `session_id` 分区，不按 `treeID`、父分支或子树分区。
- `Session.fork()` 会把 fork 锚点之前的 message/part 复制到新 session 流，但不会复制父 session 的 `memory/session/<parent>/MEMORY.md`、prepared snapshot 或 active state。
- fork 出来的 child session 会拥有自己的 `memory/session/<child>/MEMORY.md`。父 session 的 short-term memory 不会自动进入 child 的 L2 pool。
- 父分支中的信息只有在被 reflection 汇总到全局 daily memory 或 `USER.md` 后，才会通过新的 prepare/reload/search 路径被其他 session 看到；如果 fork 复制的历史 message/part 本身含有 memory tool 输出，那只是普通会话历史，不等于继承了 memory state。
- `memory_reflect` 的 `current_scope` 按当前 workspace/project scope 过滤 session memory 文件，不代表当前 session tree 或当前子树。
- daily cron 的 `global` reflection 扫描当天产生或修改过的 session memory 文件，输出仍写入全局 daily memory 与全局 `USER.md`。

因此，旧的“一个 project 下 session 平铺，每个 session 有暂存 memory”在 live 存储层仍基本成立：每个 session 节点仍有独立 short-term memory。变化是 session 现在同时也是树中的分支节点，而第一阶段 refresh collector 会用 tree 信息避免重复 backfill shared-prefix source；live memory 仍没有 tree-aware 继承、合并或 provenance。

## 7. 写入与反思

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

## 8. 配置

当前有效字段：

- `memory.enabled`：启用记忆工具、召回与内置 daily reflection cron，默认 `true`；只读取 global 配置。
- `memory.memory_reflection_model`：可选，指定 reflection 使用的模型；只读取 global 配置。

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

- `GET /memory` 返回 `settings`、`refresh`、`user`、`inbox`、`memory`、`daily`，传入 `session_id` 时额外返回当前 session 的 `active` L1 内容。
- `POST /memory/refresh/dry-run` 执行 source inventory 与 ledger 扫描，不写 memory 正文。
- `POST /memory/refresh/run` 执行完整 V1 refresh/backfill；支持 `scope=current_project|global` 与 `force=true`。
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
- 手动 refresh/backfill 入口：“补录记忆”。该入口全局增量扫描本机可见的历史聊天，只补新增/未覆盖来源，并在 memory 总开关关闭时禁用；运行中显示后台补录提示，按钮禁用态跨 Settings 页面切换保留，hover 显示“正在补录记忆”。
- 补录结果弹窗，居中展示状态、候选记忆数量、daily memory 写入数量和 `USER.md` 追加数量。
- 当前 session 的 L1 active memory 与 prompt preview。
- pending inbox。
- `USER.md`，按 explicit/inferred 分组。
- 最近 30 个有 daily memory 的日期，倒序展示。

## 10. 当前限制

- 不使用 embedding 或向量检索。
- Reflection 依赖可用 LLM；没有候选 short-term memory 和 pending inbox 时不会调用 LLM。
- 旧 scoped memory 与 `ABSTRACT.md` 不再参与新的 L2 pool。
- 每个 session 的 L1 active memory 有约 4000 字符上限；过长条目会被截断或留在 L2/L3 中等待搜索。
