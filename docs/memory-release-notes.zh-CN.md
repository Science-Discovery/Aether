# Aether Memory/Profile 发布说明（当前版本）

## 本次发布包含

- 三层记忆缓存：L1 active prompt、L2 session pool、L3 disk store。
- 启动时不再全量注入长期记忆，只准备 L2；命中后才逐步进入 L1。
- `memory_write` 始终写当前 session short-term memory；耐久倾向条目会额外进入 pending inbox，供新 session 立即通过 `memory_search` 召回。
- `memory_reflect` 调用 LLM，把 short-term memory 与 pending inbox 整理为 daily memory，并 patch `USER.md`；提示词和本地后处理都会压制重复和冲突画像。
- 内置 daily reflection cron：`builtin-memory-reflection-daily`，默认每天 03:00 执行；如果 Aether 错过预定时间，下一次启动会后台补执行 overdue 的内置 reflection。
- `USER.md` 与 daily memory 使用统一格式：`kind[source]: content`，其中 `kind=fact|preference|task`，`source=explicit|inferred`（daily 仅 explicit）。
- scoped 条目使用实际格式 `kind[source]: scope(...): content`。
- 条目支持 `scope(global)`、`scope(project-...)`、`scope(workspace-...)`、`scope(session-...)`，用于隔离项目/会话特定偏好。
- Settings > Memory 展示 L1 active memory、pending inbox、USER.md、最近 daily memory。
- `GET /memory` 与 SDK `Memory.get({ session_id })` 支持读取 Settings > Memory 需要的当前 L1、pending inbox、USER.md、daily memory 与设置状态。

## 用户可见行为

- 模型不会在新会话开始时收到完整长期记忆。
- `memory_search` 命中后，对应条目会在当前 session 后续持续注入。
- 新 session 可以搜索到 pending inbox 中尚未 reflection 的耐久倾向条目。
- `memory_reload` 会刷新 L1/L2，适合用户手动编辑记忆文件后使用。
- `memory_read` / `memory_list` 仅用于显式记忆管理；普通召回应通过 `memory_search` 完成，agent 不应 glob/read 整个记忆目录。
- 每日 reflection 处理当天产生或修改过的 short-term session memory，以及 pending inbox；两者都没有输入时跳过。
- Reflection 会要求 LLM 对等价/近重复记忆做合并，对冲突记忆做 replace/remove；本地还会去重 daily memory，并把等价 inferred 用户画像升级为 explicit 而不是保留两条。
- 总开关 `memory.enabled=false` 时，memory 工具、召回和内置 daily reflection cron 都被视为关闭。
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
cd packages/app && bun run ./script/vitest.ts run --config ./vitest.config.ts src/components/settings-memory.vitest.tsx
```

## 已知边界

- 当前仍不使用 embedding/向量检索。
- Reflection 依赖可用 LLM；无 short-term memory 且无 pending inbox 时不会调用 LLM。
- 旧 scoped memory 与 ABSTRACT 不再参与新 L2 pool。
