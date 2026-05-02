# Aether Memory/Profile 发布说明（当前版本）

## 本次发布包含

- 三层记忆缓存：L1 active prompt、L2 session pool、L3 disk store。
- 启动时不再全量注入长期记忆，只准备 L2；命中后才逐步进入 L1。
- `memory_write` 只写当前 session short-term memory。
- `memory_reflect` 调用 LLM，把 short-term memory 整理为 daily memory，并 patch `USER.md`。
- 内置 daily reflection cron：`builtin-memory-reflection-daily`，默认每天 03:00 执行。
- `USER.md` 与 daily memory 使用统一格式：`fact/preference/task[explicit/inferred]: ...`。
- `USER.md` 继续作为人类可读真源；`memory/user/user-meta.json` 作为 sidecar metadata，用于记录 USER 条目的 selected/pin 使用反馈并改进 `<user_profile>` baseline 排序。
- Settings > Memory 展示 L1 active memory、USER.md、最近 daily memory。

## 用户可见行为

- 模型不会在新会话开始时收到完整长期记忆。
- `memory_search` 命中后，对应条目会在当前 session 后续持续注入。
- `memory_search` 命中 USER 条目时会记录选中反馈；只有默认 pin 后仍保留在 active state 的 USER 条目才记录 pin 反馈。
- `memory_reload` 会刷新 L1/L2，适合用户手动编辑记忆文件后使用。
- 每日 reflection 只处理当天产生或修改过的 short-term session memory；没有输入时跳过。
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
bun run --cwd packages/app test -- settings-memory.vitest.tsx
```

## 已知边界

- 当前仍不使用 embedding/向量检索。
- Reflection 依赖可用 LLM；无 short-term memory 时不会调用 LLM。
- 旧 scoped memory 与 ABSTRACT 不再参与新 L2 pool。
