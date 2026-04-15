# Aether 记忆系统设计与使用说明

本文描述当前代码中的记忆系统实现（`packages/opencode/src/memory` 及相关接入点）。

## 1. 设计目标

- 为 Agent 提供稳定、可持续的长期记忆，而不是仅依赖单次上下文。
- 将“用户长期偏好”和“项目长期事实”分离，避免跨项目污染。
- 在默认体验中增强跨会话回忆能力，但保持可控（开关、作用域、显式读取门禁）。
- 保证安全性：写入前扫描风险内容，阻断危险记忆进入 durable store。
- 保证可观察性：每次记忆变更都可通过 receipt 回执反馈给用户。

## 2. 架构总览

记忆系统由四层组成：

1. 存储层（file-backed）
- `USER.md`（全局）
- `MEMORY.md`（按项目/工作区作用域隔离）

2. 记忆服务层（`Memory` namespace）
- 读写、检索、压缩、反思、安全扫描、快照、回执队列。

3. 工具层（`memory_*`, `session_*`）
- 暴露给模型的能力接口，承载策略约束（例如 `session_read` 门禁）。

4. 会话集成层（`session/prompt.ts`）
- 会话开始时注入 frozen snapshot。
- 回答末尾附加 memory receipt（以 synthetic text part 保存）。

## 3. 双仓模型

当前采用双仓模型，容量上限均为 `4000` 字符：

- `user`（全局仓）
  - 用于稳定用户偏好、协作习惯、长期沟通约束。
  - 文件路径：`<data>/memory/user/USER.md`

- `memory`（项目仓）
  - 用于项目规则、流程约定、长期有效的工程/研究事实。
  - 文件路径：`<data>/memory/scope/<scopeKey>/MEMORY.md`

作用域规则：

- 有 `workspaceID` 时按 workspace 隔离。
- 有 git 项目 ID 时按项目隔离。
- 非 git 场景下按目录绝对路径哈希隔离（避免多个目录共享同一 project memory）。

## 4. Frozen Snapshot 行为

`Memory.snapshot({ session_id })` 在每个会话只生成/读取一次快照，并缓存：

- 快照内容包含：
  - `user` 条目
  - `memory` 条目
  - recall/write policy 提示

- 快照在同一会话内不刷新：
  - 即使本会话产生新写入，也不会重新注入到当前 system prompt。
  - 新写入会在下一会话生效（或通过工具显式读取 live state）。

## 5. 工具说明

### 5.1 `memory_write`

- 动作：`add | replace | remove`
- 仓位：`user | memory`
- 写入前会执行安全扫描；重复 `add` 会返回 `noop`（不伪造新增）。
- 近容量上限时会触发压缩/合并策略。

### 5.2 `memory_read`

- 读取单仓内容，可按 `index` 读取单条。

### 5.3 `memory_list`

- 同时列出两个仓的条目和容量使用情况。

### 5.4 `memory_search`

- 在双仓内做子串匹配检索。

### 5.5 `session_search`

- 在历史会话文本里搜索（当前实现为 SQL `LIKE`）。
- 默认受 settings 控制（是否开启、作用域 `current_project | global`）。
- 会过滤 memory receipt 文本，避免回执污染召回。
- 可选 `extract_durable`：从命中片段保守提炼 durable memory。

### 5.6 `session_read`

- 分页读取某个历史会话完整消息内容。
- 强门禁：
  - 需用户先显式要求“完整/原文/全量历史”。
  - 后续翻页仅允许在同一个目标会话上继续。

## 6. 安全扫描与回执机制

### 6.1 安全扫描

写入前扫描以下风险：

- prompt injection 指令覆盖类内容
- 凭证/密钥类内容（含典型 token/private key 模式）
- 外传/窃取指令模式（如导出 `.env`、`id_rsa` 等）
- 隐形字符污染（zero-width 等）

命中后会：

- 阻断写入
- 生成 `block` 事件
- 通过会话回执对用户可见

### 6.2 Memory Receipt

- 每次记忆事件（`add/replace/remove/merge/compact/block/noop`）都会进入 event 队列。
- 在 assistant 消息尾部附加 `Memory updates:` 回执（synthetic text part）。
- receipt 会被过滤出模型历史重放与 `session_search` 检索，避免形成自循环污染。

## 7. 反思与整理（Reflection / Consolidation）

当前实现包含多触发整理策略：

- 写入路径：
  - 先去重（light）
  - 使用率达到阈值时执行 strong 压缩/合并

- 会话处理路径：
  - assistant 正常完成时触发 strong reflection
  - structured output 成功路径同样触发 strong reflection
  - loop 收尾阶段触发 light reflection

目标是抑制冗余、保持高密度 durable memory，并控制容量。

## 8. 设置项

配置位于 `config.memory`：

- `cross_session_search_enabled`（默认 `true`）
  - 控制是否允许跨会话搜索与读取能力。

- `cross_session_search_scope`（默认 `current_project`）
  - `current_project`：仅当前项目/目录作用域
  - `global`：跨全部历史会话

- `memory_reflection_enabled`（默认 `true`）
  - 控制反思与整理流程。

UI 入口：`Settings > Memory`，可查看开关与只读 store 面板。

## 9. 当前限制

- `session_search` 仍是 SQL `LIKE` 路线，尚未接入 embedding/FTS 排序与召回优化。
- 检索语义理解能力有限，复杂同义改写场景下召回质量有限。
- 目前验证以 typecheck + memory 专项测试为主，完整 Web UI 多轮人工 E2E smoke 仍建议补做。

## 10. 手工测试建议（Web 模式）

在仓库根目录执行：

```bash
bun dev serve
```

另开一个终端执行：

```bash
bun run --cwd packages/app dev
```

打开本地 Web 地址后，建议按以下顺序验证：

1. 基础写入与回执
- 在对话中让 Agent “记住”一条偏好或项目约定。
- 预期：回答尾部出现 `Memory updates:`，并标明 store/action/summary。

2. Frozen snapshot
- 同会话继续追问，观察是否不会立即把新写入当作 snapshot 重新注入。
- 新开会话后再验证新记忆可见。

3. 跨会话召回
- 使用“上次/之前/我们讨论过”类问法触发 `session_search`。
- 验证 `current_project` 与 `global` 切换对结果范围的影响。

4. `session_read` 门禁与分页
- 明确要求“读取完整历史会话”后读取第一页。
- 再用“继续/下一页”验证同目标会话分页可继续。
- 更换目标会话验证门禁会阻断。

5. 安全阻断
- 尝试写入明显危险内容（如凭证或注入语句）。
- 预期：写入被拦截并出现 `block` 回执。
