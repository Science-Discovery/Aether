# Aether Memory/Profile 发布说明（当前版本）

## 本次发布包含

- 三层记忆缓存：L1 active prompt、L2 session pool、L3 长期文件与持久化派生状态。
- 启动时不再全量注入长期记忆，只准备 L2；命中后才逐步进入 L1。
- `memory_write` 只写当前 session short-term memory。
- `memory_reflect` 调用 LLM，把 short-term memory 整理为 daily memory，并 patch `USER.md`。
- 内置 daily reflection cron：`builtin-memory-reflection-daily`，默认每天 03:00 执行。
- `USER.md` 与 daily memory 使用统一格式：`fact/preference/task[explicit/inferred]: ...`。
- `USER.md` 继续作为人类可读真源；`memory/user/user-meta.json` 作为 sidecar metadata，用于记录 USER 条目的 selected/pin 使用反馈并改进 `<user_profile>` baseline 排序。
- session tree/fork 已成为 session 模型的一部分，但 memory 仍按当前 `session_id` 分区；fork child 会得到自己的 short-term memory namespace，不自动继承父 session 的 memory file、prepared snapshot 或 active state。
- memory version refresh/backfill V1 已新增 status、dry-run 和完整 run：可报告当前版本是否 pending/running/failed/blocked/completed，枚举可达 DB，统计 tree/legacy source coverage，并把结果写入 `memory/system/refresh-ledger.json`；`GET /memory` refresh status 会带出最近 run 的 stage、scope、staging/backup path 和候选/promote/error 计数。
- `POST /memory/refresh/run` 可执行完整历史 backfill：生成 memory-owned staging candidates，按历史日期做 backfill reflection，add-only promote 到 daily memory 和 `USER.md`，写入 latest backup、artifact index 和 reflection run log，并在成功后刷新 prepared snapshot/search pool。promote 写入失败会回滚已触碰的 durable 文件；artifact index 记录 durable before/after hash 索引。接口支持 `scope` 和 `force=true`；未带 `force` 时按 ledger coverage 只处理新增/未覆盖来源，没有新来源则 `noop`，force run 会在同一安全边界内重新扫描。
- Settings > Memory 展示 L1 active memory、USER.md、最近 daily memory，并提供单一“补录记忆”手动入口。该入口以 `scope=global` 增量扫描本机可见的历史聊天，且在 `memory.enabled=false` 时不可点击；点击后显示后台补录提示，运行中按钮禁用态会跨界面切换保留，hover 显示“正在补录记忆”；结果弹窗会反馈状态、候选记忆数、生成的 daily memory 数、追加到 `USER.md` 的习惯数。

## 用户可见行为

- 模型不会在新会话开始时收到完整长期记忆。
- `memory_search` 命中后，对应条目会在当前 session 后续持续注入。
- `memory_search` 命中 USER 条目时会记录选中反馈；只有默认 pin 后仍保留在 active state 的 USER 条目才记录 pin 反馈。
- `memory_reload` 会刷新 L1/L2，适合用户手动编辑记忆文件后使用。
- `GET /memory` 会返回 refresh status；`POST /memory/refresh/dry-run` 只做 source inventory 与 ledger 记录；`POST /memory/refresh/run` 执行完整 V1 refresh/backfill。
- 打开 app、打开 Settings、进入聊天或启动服务不会自动触发 backfill；当前用户可见入口是 Settings > Memory 的“补录记忆”按钮，以及 API run。手动补录运行中只显示轻量后台状态，不提供阶段级实时进度。
- 手动 `current_session` reflection 处理当前 session 的 short-term memory；`current_scope` 按当前 workspace/project scope 过滤；每日 `global` reflection 只处理当天产生或修改过的 short-term session memory。没有输入时跳过。
- 总开关 `memory.enabled=false` 时，memory 工具、召回和内置 daily reflection cron 都被视为关闭；memory runtime 只读取 global memory 配置，不读取项目级 memory 配置。
- `session_search` 和 `session_read` 已移除，agent 不再读取旧 session 正文。

## 当前有效配置

- `memory.enabled`
- `memory.memory_reflection_model`

以下旧字段会被清理：

- `memory_reflection_enabled`
- `user_profile_enabled`
- `user_profile_include_inferred`
- `memory_management_model`
- `user_profile_history_extract_enabled`
- `user_profile_history_extract_limit`

## 最小校验命令

```bash
bun run --cwd packages/opencode typecheck
bun run --cwd packages/app typecheck
bun test test/memory/memory-system.test.ts        # 在 packages/opencode 下
bun test test/cron/cron.test.ts                  # 在 packages/opencode 下
bun run --cwd packages/app test -- settings-memory.vitest.tsx
```

## 已知边界

- 当前仍不使用 embedding/向量检索。
- Reflection 依赖可用 LLM；无 short-term memory 时不会调用 LLM。
- 旧 scoped memory 与 ABSTRACT 不再参与新 L2 pool。
- 当前没有 tree-aware memory 继承、合并或 provenance；`current_scope` 指 workspace/project scope，不是 session tree/subtree。
- refresh/backfill V1 仍然保守：不回放 `memory_write`，不修改聊天 DB，不写旧 session short-term memory，不自动 replace/remove 旧 memory 正文，不做 fuzzy/embedding dedupe，也不回放历史 selected/pin 使用计数；风险候选和当前无法证明原始 turns 不可访问的 `summary_only` source 不写正文。
- refresh 自动后台触发、候选编辑 UI、run 级回滚 UI 和阶段级实时进度尚未实现；当前提供 API dry-run/run，以及 Settings > Memory 的手动全局增量补录入口和运行中禁用提示。
