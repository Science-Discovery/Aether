# 飞书端重构操作计划

## 目标

按以下既定方案重构飞书端消息处理流程，不新增额外产品逻辑：

1. 用户输入后，如果是 `/help`，直接在飞书侧返回结果并结束当次会话，不进入后端。
2. 判断用户输入是否属于非 `/stop` 和 `/compact` 的 slash 命令。若是，则直接执行，并结束当次会话；执行过程中自动查看当前 `session id` 和 `session preference`。
3. 否则，查看当前 session 状态，分为：
   - A：空闲
   - B：等待用户授权或者回答问题
   - C：正常执行任务

   对输入 `/stop`：
   - A：提示"没有任务在执行"
   - B、C：停止这个正在运行的 session

   对其它输入：
   - A：正常执行用户输入
   - B：返回 session 状态，并提示用户输入什么内容来授权或回答（参考微信端方案）
   - C：提示当前 session 正在生成回复（具体文案参考微信端）

---

## 现状确认

当前飞书逻辑主要集中在 `packages/opencode/src/feishu/manager.ts`。

已确认的现状：

- `/help` 已在飞书侧直接处理，位于 `packages/opencode/src/feishu/manager.ts:875`
- 所有 slash 命令统一在 `handleCommand()` 中分发，位于 `packages/opencode/src/feishu/manager.ts:851`
- 普通文本当前优先按以下顺序处理：
  1. pending question
  2. pending permission
  3. busy 检查
  4. 创建/复用 session
  5. `syncPending()`
  6. `SessionPrompt.prompt()`
- 当前"忙碌中"提示文案为：
  `当前会话正在生成回复，请等待结束后再发送；\n如需停止请输入 /stop`
  位于 `packages/opencode/src/feishu/manager.ts:535`
- 当前 `/stop` 逻辑会同时把 pending question / pending permission 也视为可停止状态，位于 `packages/opencode/src/feishu/manager.ts:1007`
- 当前 B 状态依赖运行时内存：
  - `_pendingQuestions`
  - `_pendingPermissions`
- 当前也有从 session 同步待处理交互的逻辑 `syncPending()`，位于 `packages/opencode/src/feishu/manager.ts:1373`

---

## 重构原则

本次只按给定方案调整，不做额外能力扩展：

- 不改飞书 route 层，仍由 `packages/opencode/src/server/routes/feishu.ts` 调用 `FeishuManager`
- 不改已有 slash 命令集合和命令语义
- 不改 Session/Question/Permission 基础模型
- 不新增新的后端 API
- 不把 `/help`、非 `/stop` `/compact` 的 slash 命令转入主对话 prompt 流程

---

## 具体改造步骤

### 1. 在飞书侧抽象统一的 session 状态判定

在 `packages/opencode/src/feishu/manager.ts` 内新增一个专用状态判定方法，例如：

- 输入：`chatId`
- 输出：
  - `state: "idle" | "waiting" | "running"`
  - `sessionId`
  - `dir`
  - `pref`
  - 可选的 `question` / `permission`

该方法内部严格按以下顺序判定：

1. 先定位当前 session
   - 复用现有 `currentSession(chatId, true/false)`、`effectiveDir(chatId)`、`SessionPreference.get()`
   - 这里应优先使用"已有 session"；不要为了状态查询无条件新建 session
2. 判断是否存在待回答问题
   - 先看内存中的 `_pendingQuestions[chatId]`
   - 若没有，再调用 `Question.list()` 按 `sessionId` 查找
3. 判断是否存在待授权请求
   - 先看内存中的 `_pendingPermissions[chatId]`
   - 若没有，再调用 `Permission.list()` 按 `sessionId` 查找
4. 判断 session 是否 busy
   - 使用现有 `SessionStatus.get(SessionID.make(sessionId))`
5. 最终归类：
   - 有 question 或 permission => `waiting`
   - 否则 busy => `running`
   - 否则 => `idle`

注意：

- 若当前 chat 尚无 session，则直接判定为 `idle`
- 判定方法内部不要发送消息，只返回状态数据

---

### 2. 重写 `handleMessage()` 的顶层分流顺序

调整 `packages/opencode/src/feishu/manager.ts:447` 附近的主流程，改为严格对应方案的顺序：

#### 2.1 先处理 `/help`

保留现有 `/help` 飞书侧直返逻辑，但将其提升为最优先判断：

- 用户输入文本后
- 如果 `text === "/help"` 或命令首项为 `/help`
- 直接调用现有帮助回复逻辑
- 立即 `return`
- 不进入状态判定
- 不进入主 prompt 流程

#### 2.2 再处理"非 `/stop` 和 `/compact` 的 slash 命令"

若输入以 `/` 开头，且命令不是 `/stop`、`/compact`：

- 直接执行 `handleCommand()`
- 执行中沿用现有 `commandCtx()` 自动查看当前 `session id` 和 `session preference`
- 命令执行完成后立即 `return`
- 不进入下面的 A/B/C 状态判断

这里实际包含：

- `/new`
- `/model`
- `/agent`
- `/approval`
- `/variant`
- `/project`
- `/session`
- 以及未来仍走 `handleCommand()` 的其它非 `/stop` `/compact` slash 命令

#### 2.3 对 `/stop`、`/compact` 和普通文本统一进入状态分流

此时再调用"步骤 1"的统一状态判定方法，得到 A/B/C：

- A = `idle`
- B = `waiting`
- C = `running`

---

### 3. 严格实现 `/stop` 的 A/B/C 规则

在 `handleMessage()` 中针对 `/stop` 单独分支，不再直接沿用现有 `cmdStop()` 的全部语义。

#### 3.1 状态 A：空闲

返回固定语义：

- "没有任务在执行"

对应处理：

- 不调用 `SessionPrompt.cancel()`
- 不清理 pending runtime
- 直接回复并结束

#### 3.2 状态 B：等待用户授权或者回答问题

停止这个正在运行的 session。

执行动作：

- 若 session 存在，调用 `SessionPrompt.cancel(SessionID.make(sessionId))`
- 清理当前 chat 的 `_pendingQuestions`、`_pendingPermissions`
- 返回停止成功文案

原因：

- 方案明确要求 B、C 都停止正在运行的 session
- 即使 B 主要表现为等待交互，仍按方案视为可停止

#### 3.3 状态 C：正常执行任务

沿用停止执行逻辑：

- 调用 `SessionPrompt.cancel(SessionID.make(sessionId))`
- 清理当前 chat 的 pending runtime
- 返回停止成功文案

#### 3.4 `cmdStop()` 的处理方式

为避免双套语义冲突，建议：

- 保留 `cmdStop()` 供内部复用，但改造成"接收外部已判定的状态并执行"
- 或者不再让 `handleMessage()` 对 `/stop` 走 `handleCommand()`，而是在 `handleMessage()` 里直接实现 `/stop` 的 A/B/C 逻辑

推荐后者，因为更符合本次方案"先判状态，再按状态处理 `/stop`"。

---

### 4. 严格实现"其它输入"的 A/B/C 规则

这里的"其它输入"包括：

- 普通文本
- `/compact`

因为根据你的方案，第 2 步已把"非 `/stop`、`/compact` 的 slash 命令"提前直接执行掉，所以剩下的 slash 只有 `/stop` 和 `/compact`。

#### 4.1 状态 A：空闲

正常执行用户输入：

- 普通文本：进入现有主 prompt 流程
- `/compact`：执行现有 `cmdCompact()` 逻辑

这里要注意：

- 只有在状态 A 下，普通文本才允许继续进入 `SessionPrompt.prompt()`
- 只有在状态 A 下，`/compact` 才允许执行

#### 4.2 状态 B：等待用户授权或者回答问题

不再像当前实现那样把用户文本直接当作回答并提交。

而是改为：

- 返回当前 session 状态
- 明确提示用户当前正在等待"授权"还是"回答问题"
- 明确告诉用户应该输入什么内容

具体要求：

- 若是 pending question：
  - 返回 `formatQuestionRequest()` 对应内容，或在其前补一行状态说明
- 若是 pending permission：
  - 返回 `formatPermissionRequest()` 对应内容，或在其前补一行状态说明
- 文案形式参考微信端方案，但实现层面先复用飞书已有的两个 formatter：
  - `formatQuestionRequest()`
  - `formatPermissionRequest()`

这一步的核心变化是：

- B 状态下"其它输入"不直接消费为答案
- 而是先提示用户该如何回答/授权

#### 4.3 状态 C：正常执行任务

返回"当前 session 正在生成回复"的提示，不执行用户输入。

文案要求：

- 具体文案参考微信端
- 若暂时未找到微信端对应文本，先与现有飞书文案保持一致，再在实施时替换为微信端同款

当前飞书现有可对齐文案为：

`当前会话正在生成回复，请等待结束后再发送；如需停止请输入 /stop`

---

### 5. 调整"B 状态自动消费输入"的旧逻辑

当前 `handleMessage()` 中以下逻辑需要迁移或收口：

- `packages/opencode/src/feishu/manager.ts:500`
- `packages/opencode/src/feishu/manager.ts:508`

即：

- 当前 chat 有 pending question 时，直接把文本作为回答
- 当前 chat 有 pending permission 时，直接把文本作为授权回复

这与本次方案中"其它输入在 B 状态下先返回提示，不直接提交"冲突，因此必须修改。

建议改法：

- 将"自动把文本作为回答/授权"的逻辑从主入口移除
- 改成只在明确满足"这是对问题/授权的回复"的专门路径下调用
- 如果本次方案不要求保留自动回复能力，则主入口不再自动消费

按你当前给定方案，建议严格执行：

- 主入口不自动提交 B 状态输入
- 只返回状态提示和输入指引

---

### 6. 重新梳理 `/compact` 的入口位置

当前 `/compact` 由 `handleCommand()` 直接执行。

根据你的方案，应调整为：

- `/compact` 不属于"直接执行并结束"的那一类
- `/compact` 要先参与 A/B/C 状态判定
- 仅当状态 A 时才执行 `cmdCompact()`
- 状态 B 时返回"等待授权/回答"的状态提示
- 状态 C 时返回"正在生成回复"的提示

因此需要把 `/compact` 从"通用 slash 直执行分支"中排除。

---

### 7. 保留并复用现有上下文能力

以下现有能力保持不变，只做调用时机调整：

- `commandCtx(chatId)`  
  用于自动查看当前 `session id`、`session preference`、项目名、会话名、模式、模型
- `currentSession(chatId, create?)`
- `effectiveDir(chatId)`
- `formatQuestionRequest()`
- `formatPermissionRequest()`
- `clearRuntime(chatId)`
- `cmdCompact()`

这样可以保证：

- 非 `/stop` `/compact` slash 命令仍能自动读取 session 上下文
- B 状态提示继续复用当前已存在的飞书格式化文案

---

## 建议的代码落点

### 主要修改文件

- `packages/opencode/src/feishu/manager.ts`

### 重点修改函数

- `handleMessage()`
- `handleCommand()`  
  仅调整其调用入口，不必大改命令内部实现
- `cmdStop()`  
  视实现方式决定是否保留/瘦身
- 新增统一状态判定方法
- 视需要新增：
  - B 状态回复方法
  - C 状态回复方法

---

## 推荐实施顺序

1. 新增统一 session 状态判定方法
2. 重构 `handleMessage()` 顶层分流顺序
3. 将 `/help` 提升为最高优先级直返
4. 将"非 `/stop` `/compact` 的 slash 命令"提前直执行并返回
5. 将 `/stop` 改为按 A/B/C 处理
6. 将 `/compact` 改为先判状态再决定是否执行
7. 删除或迁移"B 状态自动消费输入"的旧逻辑
8. 统一检查 B/C 状态回复文案是否符合微信端方案

---

## 验收清单

### `/help`

- 输入 `/help`
- 飞书直接返回帮助内容
- 不进入 session prompt
- 不创建新 session
- 不触发 Question / Permission / SessionStatus 判断

### 非 `/stop` `/compact` slash 命令

- 输入 `/model`、`/agent`、`/project`、`/session` 等
- 直接执行命令
- 自动读取当前 session id / session preference
- 不进入主 prompt 流程

### `/stop`

- 状态 A：返回"没有任务在执行"
- 状态 B：停止 session，并返回停止成功
- 状态 C：停止 session，并返回停止成功

### `/compact`

- 状态 A：正常执行压缩
- 状态 B：不执行压缩，返回等待授权/回答提示
- 状态 C：不执行压缩，返回"正在生成回复"提示

### 普通文本

- 状态 A：正常进入 prompt
- 状态 B：只返回等待授权/回答提示，不直接当作回答提交
- 状态 C：只返回"正在生成回复"提示，不进入 prompt

---

## 风险点

### 1. `currentSession(chatId, true)` 的副作用

现有 `commandCtx()` 会在缺少 session 时自动创建 session。  
做状态判定时不能无条件复用这个行为，否则"仅查询状态"也会新建 session。

处理要求：

- 状态判定时优先使用不创建 session 的查询方式
- 只有真正进入 A 状态执行用户输入时，才允许按现有逻辑创建 session

### 2. B 状态来源有两套

当前 B 状态既可能来自：

- 内存中的 `_pendingQuestions` / `_pendingPermissions`
- 存储层中的 `Question.list()` / `Permission.list()`

处理要求：

- 统一状态判定时两者都要覆盖
- 以内存优先，存储兜底

### 3. `/stop` 在 B 状态是否一定存在可 cancel 的 prompt

有可能 session 当前并不 busy，只是停在等待授权/提问。  
但方案要求 B、C 都停止 session，因此实现上应允许：

- 即使 `SessionStatus` 不是 `busy`
- 仍清理 pending 状态
- 并尝试调用 cancel 或至少保证当前交互被终止

---

## 与当前实现的差异总结

当前实现：

- B 状态下，普通文本会直接被当作回答/授权输入
- `/compact` 直接执行，不参与 A/B/C 分流
- `/stop` 逻辑混合了 busy 与 pending 判断，但不是按你要求的 A/B/C 入口组织

目标实现：

- `/help` 飞书侧直返并结束
- 非 `/stop` `/compact` slash 命令直接执行并结束
- `/stop`、`/compact`、普通文本统一先判 A/B/C
- B 状态下只提示，不自动消费用户输入
- C 状态下统一返回"正在生成回复"的提示
