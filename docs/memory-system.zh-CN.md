# Aether 记忆系统（当前实现）

本文只描述当前已落地实现。

## 1. 运行层与存储区

从运行角度看，当前仍是三层：

- L1：active memory prompt。`USER.md` 中的稳定用户画像会以小上限 baseline 注入；baseline 先选 explicit，再选 inferred，并在同类内使用 `user-meta.json` 的使用反馈分数排序。daily/session/inbox 记忆只有被自动召回、`memory_search` 命中、或本轮 `memory_write` 写入后才进入模型 system prompt；inbox 不作为 baseline 直接进入 L1。整体约 4000 字符上限。
- L2：session memory pool。会话启动时从磁盘准备；`USER.md` 用于 L1 baseline 与搜索，daily/session 记忆默认不注入，只由 `memory_search` 或自动召回使用；pending inbox 条目也进入 L2/search pool，但会按 global/project/workspace scope 硬过滤。
- L3：长期文件与持久化派生状态。包含人类可读 memory files、per-session snapshot、per-session active state 和 reflection run log；进程内缓存只影响当前服务进程内的读取复用。

从实际存储角度看，memory 现在分成 10 块：

1. 全局用户画像：`memory/user/USER.md`。这是 USER 记忆的人类可读真源，会进入 L1 baseline，也会进入 L2 搜索池。
2. 用户画像 metadata：`memory/user/user-meta.json`。这是 USER 条目的 sidecar 使用反馈，不是记忆真源。
3. 全局 daily memory：`memory/daily/YYYY-MM-DD/MEMORY.md`。reflection 将 session short-term memory 整理到这里。
4. 当前 session 节点的 short-term memory：`memory/session/<session_id>/MEMORY.md`。`memory_write` 永远写这里。
5. reflection run log：`memory/reflection/run/<run_id>.json`。记录 reflection 是否执行、跳过、写入或失败。
6. prepared snapshot：`storage/memory/snapshot/<session_id>.json`。这是某个 session 启动/重载后准备好的 L2 派生快照。
7. active memory state：`storage/memory/active/<session_id>.json`。记录当前 session 已经 pin 到 L1 的条目。
8. Pending inbox：`memory/inbox/global/<entry_id>.json`、`memory/inbox/project/<project_id>/<entry_id>.json`、`memory/inbox/workspace/<workspace_id>/<entry_id>.json`。这是 project/workspace/global scoped live write 的待处理 per-entry JSON source of truth。
9. 进程内状态：`liveEvents`、`frozenSnapshots`、`activeMemory`。这些只在当前服务进程中存在，不是 durable memory。
10. memory refresh system artifacts：`memory/system/refresh-ledger.json`、`memory/system/staging/<run_id>/candidates.json`、`memory/system/artifact-index.json`、`memory/system/backup/latest/`。这些记录 memory version refresh/backfill 的版本状态、run log、source coverage、staging candidate hash/provenance、promoted artifact index 和最近一次 durable memory 备份；它们是 memory 自有维护账本，不是人类可读 memory 内容。

下文的 `memory/...` 路径位于 `Global.Path.data/memory/` 下；`storage/...` 路径位于 `Global.Path.data/storage/` 下。

## 2. 持久化路径

- 用户画像：`memory/user/USER.md`
- 用户画像 metadata：`memory/user/user-meta.json`
- 每日长期记忆：`memory/daily/YYYY-MM-DD/MEMORY.md`
- 当前 session 节点短期记忆：`memory/session/<session_id>/MEMORY.md`
- Pending inbox：`memory/inbox/global/<entry_id>.json`、`memory/inbox/project/<project_id>/<entry_id>.json`、`memory/inbox/workspace/<workspace_id>/<entry_id>.json`
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

- `kind`：`fact | preference | task`
- `USER.md` 的 `source`：`explicit | inferred`
- daily memory 的 `source`：只写 `explicit`

## 4. 会话工作流

- 会话启动时构建 L2 pool，并将 `USER.md` 画像以小上限注入 L1；daily/session 长期内容不全量注入。
- 每轮模型调用前，会根据最新用户消息执行最多 5 条自动召回。
- `memory_search` 会保留短语、拆分常见中英文分隔符、为中文片段生成低权重 2/3 字 n-gram，并按相关性分数排序，source priority 作为辅助信号。
- 搜索命中会静默加入 L1，并在本 session 后续持续注入。
- 搜索选中 USER 条目时会更新 `user-meta.json` 的 `selected_count`；默认 pin 后仍留在 active state 的 USER 条目才会更新 `pin_count`。搜索命中 inbox 条目时会更新 inbox entry 的 `selected_count`，默认 pin 后仍留在 active state 的 inbox 条目才会更新 `pin_count`。同一个 session 对同一个 inbox entry 的 selected/pin 只计一次；live write、write-pin、fork seed、refresh/backfill 不增加这些 count。`activePrompt()` 本身不写 USER metadata，也不自增 `prompt_count`。
- `memory_reload` 会重新读取 L2，并清空 L1 active memory；内部 snapshot/active revalidation 会在 prepare、promotion refresh 和 active prompt 路径重新校验 inbox 条目的 status 与 scope 可见性。

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
- `Session.fork()` 会把 fork 锚点之前的 message/part 复制到新 session 流，但不会复制父 session 的 `memory/session/<parent>/MEMORY.md` 或 prepared snapshot。
- fork 路由会在创建 child 后把父 session 当前 active memory seed 到 child active state：包含 USER、daily、当前 scope 可见的 inbox，以及带有可继承 scope metadata 的 session active 条目；seed 不写 child session memory、不写 inbox、不增加 selected/pin/source count。
- fork 出来的 child session 会拥有自己的 `memory/session/<child>/MEMORY.md`。父 session 的 short-term memory 不会自动进入 child 的 L2 pool；只有 fork 时已经 active 且符合 V1 继承规则的条目会作为 child active snapshot 保留。
- 父分支中的信息只有在被 reflection 汇总到全局 daily memory 或 `USER.md` 后，才会通过新的 prepare/reload/search 路径被其他 session 看到；如果 fork 复制的历史 message/part 本身含有 memory tool 输出，那只是普通会话历史，不等于继承了 memory state。
- `memory_reflect` 的 `current_scope` 按当前 workspace/project scope 过滤 session memory 文件，不代表当前 session tree 或当前子树。
- daily cron 的 `global` reflection 扫描当天产生或修改过的 session memory 文件，并读取所有 pending inbox；输出仍写入全局 daily memory 与全局 `USER.md`，pending inbox 只按 explicit decision 更新状态。

因此，旧的“一个 project 下 session 平铺，每个 session 有暂存 memory”在 live 存储层仍基本成立：每个 session 节点仍有独立 short-term memory。变化是 fork-time active seed 让 child 可延续父 session 当时已经进入 L1 的上下文，而不会把父 session short-term memory 复制成 child 暂存 memory；第一阶段 refresh collector 仍会用 tree 信息避免重复 backfill shared-prefix source。live memory 还没有完整 branch-aware recall、合并或 lineage visibility。

## 7. 写入与反思

- `memory_write` 永远先写入当前 session short-term memory，不直接修改 `USER.md` 或 daily memory。
- `memory_write` 支持 `scope`、`salience_hint`、`salience_reason`。`scope=session:<current_session>` 或缺失/无效 scope 只保留在当前 session memory；`scope=project:<id>`、`scope=workspace:<id>`、`scope=global` 会在写入 session memory 后 deterministic mirror 到 pending inbox。active memory prompt 会暴露当前可用的 session/project/workspace/global scope id，后端也会校验 project/workspace id 必须匹配当前上下文；缺 scope 或不匹配 scope 的 fallback 是 session-only，不打扰用户，只记录内部事件。
- `salience_hint` 表达初始重要性，不伪造 usage count；live write 和 write-pin 都不会增加 inbox selected/pin。
- `memory_reflect` 会调用 LLM，将 short-term memory 整理为 daily memory，并对 `USER.md` 生成 add/replace/remove patch；它也会读取符合 reflection scope 的 pending inbox，并要求 LLM 对每个 inbox entry 给出明确决定：`promote_to_user`、`promote_to_daily`、`merge_with_existing`、`reject_or_stale` 或 `keep_pending`。
- 成功的 reflection run 不会盲清 inbox；只有明确 promoted/merged/rejected 的 entry 会按 revision-aware apply 更新，`keep_pending` 继续留待后续 reflection。
- daily memory 保持事实日志，不按 project/workspace/global scope 做 search/active 硬过滤。`USER.md` 在 V1 仍是 global profile；非 global scoped memory 不能原样进入 USER，只能在 reflection 明确概括成 global 偏好后进入。
- daily cron 会每天触发一次 `memory_reflect`，没有当天 short-term memory 时跳过并写入 skipped run log。

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

## 9. 工具与接口

Agent 可用工具：

- `memory_write`：写当前 session short-term memory；project/workspace/global scope 会镜像到 pending inbox。
- `memory_search`：搜索 L2 pool，并将命中条目加入 L1。
- `memory_reload`：重新加载 L2，并清空当前 L1 active memory。
- `memory_reflect`：显式触发 LLM-based reflection。
- `memory_refresh`：在用户明确要求初始化、补录或刷新历史记忆时，读取本机可见的历史聊天 DB 并执行 refresh/backfill。
- `memory_read`：显式记忆管理读取，不用于普通召回。
- `memory_list`：显式记忆管理列表，不用于普通召回。

HTTP/SDK：

- `GET /memory` 返回 `settings`、`refresh`、`user`、`memory`、`daily`，传入 `session_id` 时额外返回当前 session 的 `active` L1 内容。
- `POST /memory/refresh/dry-run` 执行 source inventory 与 ledger 扫描，不写 memory 正文。
- `POST /memory/refresh/run` 执行完整 V1 refresh/backfill；支持 `scope=current_project|global` 与 `force=true`。
- 生成的 SDK 使用 `Memory.get({ session_id })` 读取 Memory 设置页所需数据。

## 10. Cron 集成

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

## 11. 前端展示

Settings > Memory 展示：

- 总开关。
- 手动 refresh/backfill 入口：“补录记忆”。该入口全局增量扫描本机可见的历史聊天，只补新增/未覆盖来源，并在 memory 总开关关闭时禁用；运行中显示后台补录提示，按钮禁用态跨 Settings 页面切换保留，hover 显示“正在补录记忆”。
- 补录结果弹窗，居中展示状态、候选记忆数量、daily memory 写入数量和 `USER.md` 追加数量。
- 当前 session 的 L1 active memory 与 prompt preview。
- `USER.md`，按 explicit/inferred 分组。
- 最近 30 个有 daily memory 的日期，倒序展示。
