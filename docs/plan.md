# LLM 调用接口维护方案

## 背景

Aether 目前已经与上游 opencode 分离，但 LLM 调用层仍然处在高速变化区：Vercel AI SDK、各供应商 SDK、`models.dev` 元数据、新模型的 reasoning / tool call / multimodal 能力都会持续变化。我们需要既能跟上上游对新模型和 SDK 的适配，又不能丢失本仓库对国产模型和国内兼容网关的修正。

现有调用链已经比较集中：

- `packages/opencode/src/session/llm.ts` 是实际 LLM 调用入口，最终调用 `streamText()`。
- `packages/opencode/src/provider/provider.ts` 负责 provider/model 元数据合并、SDK 创建、动态 provider 加载、认证、baseURL、fetch 包装。
- `packages/opencode/src/provider/transform.ts` 负责消息、provider options、reasoning variants、schema 兼容等转换。
- `packages/opencode/test/provider/*` 和 `packages/opencode/test/session/llm.test.ts` 已经有一部分 provider 契约测试。

因此不建议用“定期从上游整块覆盖 LLM 模块”的方式维护。当前国产模型适配已经散布在以上几个文件里，整块覆盖会高概率丢失本地行为。

## 维护策略

采用“上游增量同步 + 本地适配层固化”的策略。

### 上游生命周期观察

截至 2026-04-24 对 `anomalyco/opencode` 的观察，上游更像是高流量、强自动化筛选、维护者强把关的仓库，而不是低噪声 roadmap 仓库。维护 LLM 调用层时不能只盯 open issue 或 open PR。

关键观察：

- 上游 issue 和 PR 积压都在千级量级，open 队列包含大量未确认、未合规、等待设计讨论或长期停留的条目。
- issue 必须使用模板；不合规 issue 会被标记 `needs:compliance`，短时间内不修正会自动关闭。
- PR 必须先关联 issue，描述要短、聚焦、说明验证方式，并使用 conventional commit 标题；不合规 PR 可能被自动拒绝或关闭。
- 上游明确反感大段 AI 生成描述，维护者更偏好小 PR、可复现问题、清晰测试结果。
- PR 列表中可见大量 `needs:issue`、`needs:compliance`、`Vouched`、`Draft`、`contributor` 等状态，说明合并路径受信任机制、合规自动化和维护者人工筛选共同影响。
- 高流量下，open PR 不等于会合并；merged PR、release notes、实际落到 `dev` 的 provider/LLM commit 更值得跟踪。

这些观察对本仓库的含义是：

- 不把上游 open issue 当作待办来源，只作为问题信号。
- 不把上游 open PR 当作补丁来源，除非该 PR 已被核心维护者确认、已有清晰测试，或问题与我们线上 bug 高度一致。
- 常规同步应以 merged PR、`dev` 分支 commit、release notes 和依赖版本变化为准。
- 我们自己的国产模型修复应在本仓库内先形成 issue/测试/最小补丁；需要回馈上游时，再按上游规则拆成小 PR，而不是直接推大段兼容层改造。

### 不采用整块覆盖

不要定期把上游的 `provider.ts`、`transform.ts`、`llm.ts` 直接覆盖到当前仓库。主要风险：

- 会覆盖国产模型参数修正，例如 Qwen、Kimi、GLM、Minimax 的 temperature/top_p/top_k 默认值。
- 会覆盖 reasoning 兼容逻辑，例如 `reasoning_content` / `reasoning_details` 回灌、DashScope `enable_thinking`。
- 会覆盖 OpenAI-compatible 兼容修正，例如 GPT-5 / o-series 的 `max_completion_tokens` 转换。
- 会覆盖国内网关和代理场景，例如 LiteLLM/Anthropic proxy 的 dummy tool 兼容、chunk timeout、HTTP proxy。
- 会让每次同步变成大面积人工回归，无法判断 bug 来自上游变化还是本地补丁丢失。

### 上游只做增量吸收

上游更新应按变更类型分拆吸收：

- SDK / 依赖升级：优先同步 `package.json`、`bun.lock`、patches，并跑 provider 契约测试。
- 新 provider 支持：同步 `BUNDLED_PROVIDERS`、`CUSTOM_LOADERS`、providerOptions namespace 映射和对应测试。
- 新模型能力：同步 `models.dev` schema、reasoning variant、Responses API / Chat API 选择逻辑。
- 通用 bugfix：逐 commit cherry-pick 或手工移植，不覆盖本地国产模型兼容逻辑。
- 上游重构：先在临时分支完成三路 diff，再决定是否跟随重构；不能在业务分支中直接大面积替换。

### 本地适配必须保留

以下能力属于 Aether 本地兼容层，任何上游同步后都必须保留并通过测试：

- OpenAI-compatible provider 的 `includeUsage`、`max_tokens` 到 `max_completion_tokens` 转换。
- interleaved reasoning：把 assistant reasoning part 映射到 `providerOptions.openaiCompatible.reasoning_content` 或 `reasoning_details`。
- DashScope / Alibaba CN reasoning 模型默认发送 `enable_thinking: true`，排除已默认输出 reasoning 的模型。
- Zhipu / ZAI reasoning 参数：`thinking.type = "enabled"` 与 `clear_thinking: false`。
- Kimi K2.5 / K2P5 在 Anthropic SDK 形态下默认启用 thinking budget。
- Qwen / Kimi / Minimax / GLM 等模型的采样参数默认值。
- DeepSeek、Minimax、GLM、Mistral、Kimi 等不暴露通用 reasoning variant，避免错误地传入不兼容 effort。
- LiteLLM proxy 在历史消息含 tool call、当前无工具时注入 `_noop` 工具。
- HTTP proxy、SSE chunk timeout、自定义 baseURL、provider config 连接语义。

## 推荐架构演进

短期不要重写调用链，先把“本地差异”变成明确边界；中期再把特例从大函数里移出去。

### 阶段一：文档化与测试护栏

目标是让后续同步可控。

- 保持 `LLM.stream()` 作为唯一调用入口。
- 保持 `Provider.getLanguage()` / `getSDK()` 作为 SDK 实例化边界。
- 保持 `ProviderTransform` 作为请求转换边界。
- 增加一份 provider 维护清单，记录每个本地特例的原因、覆盖模型、对应测试。
- 对国产模型和 OpenAI-compatible 行为补齐契约测试。

### 阶段二：抽出本地 profile

在不改变外部 API 的前提下，把散落的 provider/model 特例逐步收敛成内部 profile 表。

建议新增内部结构，名称可在实现时按代码风格微调：

- `ProviderProfile`：按 providerID / npm / api id 归类 provider 行为。
- `ModelQuirk`：按 model id/family 匹配特殊参数和禁用项。
- `CompatibilityRule`：描述请求体改写、消息改写、variant 生成和 schema 修正。

示例职责划分：

- `ProviderTransform.temperature/topP/topK` 从硬编码分支改为读取 profile 默认值。
- `ProviderTransform.options` 从长条件分支改为应用 profile rules。
- `ProviderTransform.variants` 只处理通用 provider 行为，国产模型禁用/特殊 reasoning 放入 quirk。
- `Provider.getSDK()` 中的 fetch body patch 保持在 SDK 边界，但规则来源可来自 profile。

这样以后同步上游时，核心文件冲突会更少，本地兼容逻辑也更容易被测试锁住。

### 阶段三：自动化同步流程

建立固定的上游同步分支流程：

1. 从 `dev` 切出 `sync/upstream-llm-YYYYMMDD`。
2. 获取上游默认分支；本仓库默认分支是 `dev`，不要假设本地 `main` 存在。
3. 对以下文件做三路 diff：
   - `packages/opencode/src/session/llm.ts`
   - `packages/opencode/src/provider/provider.ts`
   - `packages/opencode/src/provider/transform.ts`
   - `packages/opencode/src/provider/models.ts`
   - `packages/opencode/src/provider/models-local.ts`
   - `packages/opencode/script/generate.ts`
   - `packages/opencode/test/provider/*`
   - `packages/opencode/test/session/llm.test.ts`
   - `packages/opencode/package.json`
   - `bun.lock`
4. 将上游变更按“SDK 升级 / provider 新增 / model 能力 / 通用 bugfix / 重构”分类。
5. 先看 merged PR、release notes 和已进入 `dev` 的 commit；open PR 只作为参考信号。
6. 对命中的上游改动做二次筛选：
   - 优先吸收 `fix(provider)`、`fix(opencode)`、`feat(provider)`、LLM performance、AI SDK、`models.dev`、reasoning、tool call、streaming 相关变更。
   - 暂缓吸收纯 UI、生态列表、平台安装、未合规或无测试的开放 PR。
   - 对 provider 新增 PR，只有在合并或我们确实需要该 provider 时才移植。
7. 只移植必要改动，保留本地 profile 和本地契约测试。
8. 跑完整 LLM provider 测试矩阵。
9. 在 PR 描述中列出：
   - 吸收的上游 commit 或 diff 范围。
   - 本地保留的国产模型兼容点。
   - 测试结果。
   - 需要真实供应商 smoke 的模型列表。

建议固定维护这些 GitHub 查询，而不是人工浏览完整队列：

- `repo:anomalyco/opencode is:pr is:merged provider`
- `repo:anomalyco/opencode is:pr is:merged "AI SDK"`
- `repo:anomalyco/opencode is:pr is:merged models.dev`
- `repo:anomalyco/opencode is:pr is:merged reasoning`
- `repo:anomalyco/opencode is:pr is:merged "tool call"`
- `repo:anomalyco/opencode is:pr is:merged streamText`
- `repo:anomalyco/opencode is:issue provider LLM`
- `repo:anomalyco/opencode is:issue "openai-compatible"`

## 测试矩阵

所有 LLM 层同步或重构都必须从 `packages/opencode` 目录运行测试，不能从 repo root 跑。

基础命令：

```bash
cd packages/opencode
bun test test/provider/transform.test.ts
bun test test/provider/provider.test.ts
bun test test/session/llm.test.ts
bun typecheck
```

需要重点覆盖的契约：

- OpenAI Responses API：GPT-5 系列使用 Responses API，reasoning effort、max output tokens、`store: false` 不回归。
- OpenAI-compatible：GPT-5 / o-series 请求体使用 `max_completion_tokens`。
- Anthropic：空内容过滤、cache control、toolCallId 清洗不回归。
- Google / Gemini：thinkingConfig、schema sanitizer、array items 修正不回归。
- OpenRouter / Gateway：providerOptions namespace 路由正确。
- DeepSeek / Kimi / GLM：interleaved reasoning 能正确写入 `reasoning_content`。
- Alibaba CN / DashScope：reasoning 模型默认发送 `enable_thinking: true`。
- ZAI / Zhipu：thinking 配置仍存在。
- Minimax / Qwen / Kimi：采样参数默认值不回归。
- LiteLLM proxy：历史消息含 tool call 且当前无工具时注入 `_noop`。
- 自定义 provider：有 models + baseURL 时可以无 api key 连接，本地 provider 配置语义不回归。

真实供应商测试只作为 smoke，不作为常规 merge blocker。建议每次大版本同步后手动抽测：

- 一个 OpenAI 官方模型。
- 一个 Anthropic 官方模型。
- 一个 Gemini 模型。
- 一个 OpenAI-compatible 国产模型，例如 Qwen 或 Kimi。
- 一个 reasoning 国产模型，例如 DeepSeek / GLM / Kimi thinking。
- 一个国内聚合网关或 LiteLLM 代理。

smoke 只验证能完成一次文本回复和一次工具调用，不验证模型输出的具体措辞。

## 版本与发布节奏

推荐节奏：

- 每周检查一次 AI SDK、核心 provider SDK、`models.dev` 和上游 release notes。
- 每两周检查一次上游 opencode 已合并的 LLM/provider 相关 PR 和 `dev` 分支 commit。
- 每月做一次 open issue/PR 扫描，只提取高频问题信号，不直接照搬未合并补丁。
- 新模型发布、旧模型下线、供应商 API 行为变化时临时触发同步。
- 只有在 AI SDK major 版本变化或上游重构 LLM 调用层时，才安排专项同步。

依赖升级原则：

- 先升级 AI SDK 核心包和 bundled provider SDK，避免只升级单个 provider 造成 peer dependency 错位。
- 动态安装 provider 仍保留，但常用 provider 优先 bundled，降低运行时安装失败风险。
- 对上游修复过的 provider package incompatibility，优先采用明确 override，而不是依赖运行时猜测。

## 维护决策规则

遇到新模型或供应商问题时，按以下顺序处理：

1. 如果只是模型元数据变化，优先更新 `models.dev` 数据或本地模型配置，不改调用链。
2. 如果是 OpenAI-compatible 方言差异，优先加 profile/quirk 和契约测试。
3. 如果是官方 SDK 行为变化，优先升级 SDK 并最小化本地 patch。
4. 如果上游已经修复同类问题，优先 cherry-pick 或手工移植该 commit。
5. 如果必须改 `LLM.stream()`，先确认该行为不能放在 `ProviderTransform` 或 SDK fetch wrapper 中。

判断上游 issue/PR 是否值得进入本地同步队列：

1. 已 merged 或已进入 `dev`：可以进入候选。
2. 由 maintainer/member/collaborator 提交或明确确认：可以进入候选，但仍需本地测试。
3. 只是 open PR 且带 `needs:issue` / `needs:compliance`：默认不进入候选。
4. 只是用户 issue：只作为复现线索，必须先在本仓库复现并写测试。
5. 涉及国产模型或 OpenAI-compatible 方言：即使上游未合并，也可以本地修，但必须归入 profile/quirk 并写契约测试。

新增特例必须满足：

- 有明确 provider/model 范围。
- 有失败原因或供应商 API 差异说明。
- 有单元测试或本地 fake server 契约测试。
- 不影响其他 provider 的 payload。

## 风险与应对

主要风险：

- 上游变更频繁，手工同步成本上升。
- AI SDK 对 providerOptions namespace 或 message schema 的行为变化导致隐式回归。
- 国产模型 API 文档与实际行为不一致，导致只能靠真实调用验证。
- `models.dev` 元数据新增字段时，本地 schema 没有及时跟进。

应对方式：

- 把本地兼容行为全部测试化，先让回归可见。
- 用 profile/quirk 降低核心文件冲突面积。
- 对真实供应商测试保持 smoke 级别，避免 flaky 阻塞主线。
- 同步 PR 必须写清楚上游范围和本地保留点。
- 出现重大 SDK 变化时，先在独立分支验证，不混入业务功能开发。

## 结论

LLM 调用层不适合用整块覆盖维护。更稳妥的方案是保持调用入口集中，保留本仓库的国产模型兼容层，通过上游增量同步吸收新模型和 SDK 能力，再用契约测试防止本地适配回归。

短期重点是补齐测试和同步流程；中期重点是把国产模型、OpenAI-compatible 方言、网关代理行为抽成 profile/quirk；长期再考虑把 provider adapter 做成更独立的内部模块，减少与上游核心调用链的冲突。
