# LLM 调用接口系统测试需求文档

## 1. 背景与目标

LLM 调用层是 Aether 的高变更面：上游 SDK、`models.dev` 元数据、各供应商方言都在持续变化，本仓库还在其上叠加了国产模型与 OpenAI-compatible 网关的本地适配。`docs/plan.md` 已经确立了"上游增量同步 + 本地适配层固化"的维护策略，并把"真实供应商 smoke"列为测试矩阵的一部分。本需求文档把这一段具体化为一个可独立运行的 **LLM 调用接口系统测试**，并固定其边界。

系统测试要回答的问题只有一个：**给定一份 provider 配置，opencode 真的能跟真实 endpoint 跑通一次完整的流式对话吗？**

它**不**回答：

- 模型回答得对不对、好不好、措辞如何。
- 跨模型 / 跨 provider 的能力或成本对比。
- 长上下文压力、QPS 上限、SLA 监控。
- UI、SSE 推送、会话持久化等系统其他链路。

它的定位与 `docs/plan.md` 中的"真实供应商 smoke 不作为常规 merge blocker"保持一致：默认手动触发，作为合并前的端到端确认手段，而非 CI 上的硬门禁。

### 1.1 为什么必须保留真实 LLM smoke

`packages/opencode/test/session/llm.test.ts` 已经覆盖了 `LLM.stream()` 的本地契约：它启动 fake endpoint，捕获请求路径、headers 和 body，验证 OpenAI-compatible / OpenAI Responses / Anthropic / Google 等 SDK 形态下的参数转换是否符合预期。这类测试确定、快速、无真实费用，适合进入常规测试矩阵。

但本地契约测试无法证明真实 provider 今天仍然接受这组配置和请求形态。LLM 调用层的实际风险经常出现在 fake endpoint 之外：供应商 baseURL 规则变化、鉴权形态差异、模型 id 下线或别名漂移、OpenAI-compatible 方言不完全兼容、SDK 升级后真实流事件字段变化、usage / reasoning / tool-call 在真实流里的返回形态和本地模拟不一致。这些问题只有真实 HTTPS 请求完整跑到流结束态才能暴露。

因此，LLM smoke test 的必要性不是重复验证 `LLM.stream()` 的内部组装逻辑，而是补上"真实供应商接受度"这一层证据。它指导本系统测试的设计必须满足以下约束：

- 必须使用真实 provider 配置和真实 endpoint，不能用 mock、fake server 或 dry-run 替代。
- 必须完整消费流式响应到 finish 事件，不能只验证请求能发出。
- 必须按 provider / model / case 记录结构化结果，因为失败通常与某个供应商方言或模型能力绑定。
- 必须默认手动触发且显式启用，因为它消耗真实额度、依赖外部网络和供应商稳定性。
- 必须保持最小 smoke 范围，验证可用性和诊断信息，不演化成模型质量评测。

### 1.2 与 `session/llm.test.ts` 的职责边界

| 文件 | 入口 | 是否真实 provider | 主要断言 | 职责 |
|------|------|------------------|----------|------|
| `packages/opencode/test/session/llm.test.ts` | `LLM.stream()` + 本地 fake endpoint | 否 | 请求路径、headers、payload 转换、工具权限、`hasToolCalls()` | 固化本地 LLM 契约，保证 provider / transform 适配逻辑不回归 |
| `packages/opencode/test/system/llm-p0.ts` | `LLM.stream()` + YAML provider 配置 | 是 | 真实流结束、非空输出、reasoning/tool-call 事件、usage 显式化、错误分类 | 验证真实 provider 能接受当前配置并完成一次流式调用 |
| `docs/llm-system-smoke-tests/*` | 文档约束 | 不适用 | 需求、范围、覆盖矩阵、盲区 | 指导系统测试不要和本地契约测试混淆，也不要扩张成评测系统 |

两组测试都经过 `LLM.stream()` 是有意的交集：本地契约测试看"我们准备发送什么"，真实 smoke 看"供应商现在是否接受并完成响应"。前者可以稳定阻止代码层回归，后者用来发现外部 provider / SDK / 方言的真实兼容性问题；二者互补，不能互相替代。

## 2. 验证目标（R-1 ~ R-4）

- **R-1 客户端可创建**：给定 provider 类型、baseURL、API key、model id 与可选模型能力开关，系统测试必须完整走完"加载配置 → 创建内部 LLM 客户端 → 拿到模型实例"的链路。任何一步失败必须立刻报错并指出失败位置（配置缺失 / SDK 加载失败 / 认证失败 / 模型不存在）。
- **R-2 配置组合正确**：必须验证 provider 类型、baseURL、API key、model id 四元组互相匹配。例如 OpenAI-compatible provider 用对了端点形态，Anthropic 形态 provider 用对了 SDK 形态；不匹配组合视为失败。
- **R-3 真实流式回复**：必须真实发起 HTTPS 请求到真实 endpoint 并完整消费一次流式响应到结束态，不允许用 mock、不允许只校验请求体、不允许 dry-run。
- **R-4 失败可诊断**：任何失败必须能立即回答四个问题——哪个 provider、哪个 model、在哪一步失败、底层错误原文是什么。不允许出现 "timeout"、"unknown error" 这类无上下文错误。

## 3. 测试范围

### 范围内

- provider 配置加载与客户端创建。
- 单轮文本流式对话（最小验证形态）。
- 带 system prompt 的对话。
- 多轮历史输入（user/assistant 交替）。
- 含历史工具调用消息和历史工具结果消息的输入回放——仅作为输入历史，验证 provider 能否吞下这种历史不报错。
- usage 统计的回传与显式化处理。

### 范围外

- 回答内容的语义正确性评测、质量打分、关键词命中率统计。
- token 上限调优、成本计算、长上下文压测。
- UI / SSE / 会话存储等其他系统链路。
- 工具的真实执行、权限审批、Agent 切换等会话与工具系统行为。
- 跨模型 / 跨供应商能力 ranking。

## 4. 配置需求

### 4.1 Provider 配置文件

系统测试的 provider 列表必须可在不改测试代码的前提下扩展。需要两份配套 YAML：

- **模板文件**（committed）：列出每条 provider 条目所需字段、字段含义、示例占位值，但不得包含任何真实凭据。
- **真实文件**（gitignored）：结构与模板一致，由开发者本地填入凭据。文件路径与命名约定必须在文档中清楚指明，并显式登记进 `.gitignore`。

当前约定路径：

- 模板文件：`packages/opencode/test/system/llm/providers.example.yaml`
- 本地真实文件：`packages/opencode/test/system/llm/providers.local.yaml`
- 用例目录：`packages/opencode/test/system/llm/cases/`
- 默认报告目录：`.aether/llm-system-reports/`

每个 provider 条目至少能表达：

- provider 标识（在 opencode 内部唯一识别这个 provider 的字符串）。
- provider 类型 / npm 包标识（用于决定走 OpenAI / Anthropic / OpenAI-compatible / 其它形态的客户端创建路径）。
- baseURL（含变量替换占位的能力，例如 `${RESOURCE_NAME}`）。
- API key（或等价凭据，例如 AWS 凭证、OAuth token）。
- 待测的 model id 列表（同一 provider 下可声明多个 model）。
- 每个 model 的能力开关：是否支持 reasoning、是否支持 temperature、interleaved reasoning 字段类型、是否支持工具调用、是否支持视觉输入。
- 可选的额外参数（context / output token 上限等用于初始化客户端所必需的字段）。

行为约束：

- **真实文件缺失或字段为空**：对应 provider 的全部用例必须自动 skip，并在记录中标注跳过原因。即使开发者环境里存在同名 API key，缺失真实配置文件时也不能使用模板发起真实请求。**不**报错、**不**当成 fail。
- **新增一个 provider**：只需在模板里描述字段并在真实文件里填值，**不**修改测试代码。
- **同一 provider 多 model**：必须支持并列声明并独立选择，运行时可指定测哪些 model。

### 4.2 测试用例目录

测试用例必须可在不改测试代码的前提下扩展。需要一个独立的用例目录，每个用例为一个 JSON 文件。

JSON 用例至少能表达：

- 用例 id 与简要描述。
- 单轮 user prompt（最小形态）。
- 可选的 system prompt。
- 可选的多轮对话历史（user/assistant 交替；assistant 消息可包含工具调用消息与对应的工具结果消息，作为历史回放）。
- 可选的附件输入（如图片，用于视觉模型 P1 用例）。
- 可选的能力声明（用例需要 provider 具备哪些能力才会被选中，如"工具调用"、"视觉"）。
- 可选的最低断言（例如要求最终文本非空 / 包含某个最简关键词）。**不允许**在 JSON 里出现复杂的语义断言，避免演化成评测。

约束：

- 用例 JSON 中**禁止**出现绝对路径、机器特定路径、API key、Authorization header 等敏感字段。
- 一个 JSON 用例可被多个 provider 共用；一个 provider 可声明只跑哪些用例。
- 新增能力维度（如未来"音频输入"）时，旧 provider 因未声明该能力而被静默跳过，**不**报错。

### 4.3 Provider × 用例 的匹配

- 默认运行规则：每个启用的 provider 跑一组 P0 基础用例集合。
- 用例可声明所需能力，仅匹配声明了对应能力的 provider。
- 模板与文档必须明确说明匹配规则，运行结果必须反映"哪些组合被实际执行 / 跳过 / 失败"。

## 5. 输入用例形态需求

文档不规定具体 prompt 内容，只规定用例集合的最低形态。

### 5.1 P0 基础集（每个启用 provider 必跑）

- 至少一条短指令型 prompt，验证模型能在 timeout 内给出非空、可截止的流式回复。
- 至少一条带 system prompt 的 prompt，验证 system 字段被正确组装。
- 至少一条带多轮对话历史的 prompt，验证历史拼接到目标 provider 不报错（用例**不**评估模型是否真的"记住了"前文）。

### 5.2 P1 进阶集（仅声明对应能力的 provider 跑）

- 至少一条要求模型主动发起工具调用的 prompt，搭配 fake 工具 schema。用例**仅**校验"模型确实产生了 tool_call 流事件且参数 JSON 可解析"。**不**真实执行工具，**不**回灌工具结果继续第二轮，避免被模型不稳定导致 flaky。
- 至少一条带图片输入的 prompt，仅校验流式回复正常完成且文本非空，不要求语义正确。

## 6. 通过标准

按 P0 / P1 分级：

### 6.1 P0（每个启用 provider 必通过）

- **P0-A 流式终止**：在用例配置的 timeout 内，流必须自然结束（收到 finish 事件或等价信号）。超时即失败，不允许无限挂起。
- **P0-B 非空响应**：流式过程中至少产生一个文本或推理 chunk；最终累积文本非空。
- **P0-C 可观测记录**：每个用例运行完成后必须留下一条结构化记录，至少包含：
  - provider 标识、provider 类型、baseURL、model id；
  - 用例 id；
  - 总耗时（毫秒）；
  - 文本 chunk 数；
  - reasoning chunk 数（如该 model 启用 reasoning）；
  - finish reason；
  - usage（input / output / total token）；
  - 错误分类（成功留空，失败按 §8 分类）。
- **P0-C-bis 双通道输出**：上述记录必须**同时**：
  1. 以结构化 JSON 行形式输出到 stdout / verbose 日志；
  2. 落盘成一份 JSON 报告文件，便于跨次比对与排障归档。
  落盘行为必须可通过开关关闭（**默认开启**）。报告文件路径必须可配置，且必须脱敏（参见 §8、§10）。
- **P0-D usage 缺失显式化**：若 provider 不返回 usage，记录中该字段必须显式标记为 `unsupported` 或 `missing`，并附简短原因。**不**允许静默置 0；**不**允许写 null 不带说明。
- **P0-E 错误信息合格**：所有失败错误信息必须以 `<provider>/<model>/<case>` 前缀标明上下文，并包含底层 SDK 错误原文，不得被吞掉。

### 6.2 P1（仅对声明了对应能力的 provider）

- **P1-A 工具调用形态**：被声明支持工具调用的 provider 必须在 P1 工具调用用例中至少产生一次 tool-call 流事件，且事件参数 JSON 可解析。**仅**校验输出形态，不执行工具，不进入第二轮。
- **P1-B 视觉理解形态**：被声明支持视觉的 provider 必须在 P1 视觉用例中正常完成一次带图片输入的流式回复，仅校验完成与非空。

### 6.3 评测红线

- 不允许把"回答里出现某关键词"作为唯一通过标准。
- 例外：P0 基础集允许保留至多一条最简关键词存在性断言用作回归信号（例如算术结果），**不**允许扩展为多关键词、多分支、多权重的评测。
- 任何把测试演化成"模型能力打分"的改动应被驳回。

## 7. 运行需求

### 7.1 启用方式

- 默认在 CI 中关闭。普通 PR 不应触发真实 API 调用。
- 启用方式必须显式（环境开关或专用命令），并在文档中说明。

### 7.2 入口参数

测试入口必须支持：

- `--provider <id>`：仅运行指定 provider。可重复，或以逗号分隔指定多个。
- `--input <case>`：仅运行指定用例。可重复，或以逗号分隔指定多个。
- 不传参数时默认跑全部启用 provider × 全部 P0 基础集。
- P1 集合的启用方式必须可控（例如 `--p1` 开关或等价能力），文档中需要明确。

### 7.3 并行性

- 不同 provider 之间默认并行执行。
- 同一 provider 内不同用例可并行，但实现应允许收敛为串行以避开供应商速率限制。
- 必须提供一个全局并发上限的可调开关。具体名称由实现决定，需求层只要求"可配且默认值合理（不至于触限流）"。

### 7.4 跳过策略

- 真实配置文件缺失：所有 provider 跳过。
- 单个 provider 字段缺失或 API key 为空：该 provider 全部用例跳过。
- provider 不在 enabled_providers / 等价启用列表中：跳过。
- 用例声明的能力在 provider 上未声明：跳过。
- 所有跳过必须在记录中显式标注原因，不允许"静默不跑"。

### 7.5 超时

- 每个用例必须有独立的超时，默认值由实现决定，需求层要求**可配置且 ≤ 几分钟量级**。
- 触发超时即视为失败，错误分类为 `stream-incomplete`。

### 7.6 运行指南

文档需要包含一段最小流程指引：复制模板 → 填字段 → 启用开关 → 跑单个 provider → 跑全量。具体命令由实现决定。

当前最小流程：

```bash
cd packages/opencode
cp test/system/llm/providers.example.yaml test/system/llm/providers.local.yaml
# 编辑 providers.local.yaml，填入 api_key 或 api_key_env 指向的环境变量
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider deepseek
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-tool --p1
```

可用开关：

- `--provider <id>` / `OPENCODE_SYSTEM_TEST_PROVIDER`：仅运行指定 provider，可重复或用逗号分隔。
- `--input <id>` / `OPENCODE_SYSTEM_TEST_INPUT`：仅运行指定用例，可重复或用逗号分隔。
- `--p1` / `OPENCODE_SYSTEM_TEST_P1=1`：启用 P1 用例。
- `OPENCODE_SYSTEM_LLM_CONFIG`：指定真实 YAML 路径，默认读取 `test/system/llm/providers.local.yaml`；缺失时使用模板枚举 provider/model，但全部因真实配置缺失而跳过。
- `OPENCODE_SYSTEM_LLM_CASES`：指定用例目录。
- `OPENCODE_SYSTEM_TEST_TIMEOUT`：单用例超时，默认 `120000` 毫秒。
- `OPENCODE_SYSTEM_TEST_CONCURRENCY`：真实请求全局并发上限，默认 `4`。
- `OPENCODE_SYSTEM_TEST_REPORT=0`：关闭报告落盘。
- `OPENCODE_SYSTEM_TEST_REPORT_PATH`：指定报告文件路径。

当前模板覆盖的最小真实供应商矩阵：

| Provider | Models |
|----------|--------|
| DashScope / Alibaba Bailian (`alibaba-cn`) | `qwen3.6-plus`, `qwen3.6-flash`, `qwen3.6-max-preview`, `glm-5.1` |
| DeepSeek 官方 (`deepseek`) | `deepseek-v4-flash`, `deepseek-v4-pro` |
| Moonshot CN (`moonshotai-cn`) | `kimi-k2.6` |
| Z.ai (`zai`) | `glm-5.1` |
| Xiaomi MiMo (`xiaomi`) | `mimo-v2.5` |
| MiniMax (`minimax-cn`) | `MiniMax-M2.7` |
| 火山引擎 Ark (`volcengine`) | `doubao-seed-2-0-lite-260215`, `doubao-seed-2-0-mini-260215` |
| 百度千帆 (`qianfan`) | `deepseek-v4-flash` |
| 硅基流动 (`siliconflow-cn`) | `deepseek-ai/DeepSeek-V4-Flash` |

## 8. 失败诊断需求

- 失败必须打印：用例 id、provider 标识、provider 类型、model id、baseURL、耗时、底层错误原文。
- 失败必须分类为以下之一：
  - `config-missing`：配置文件或必填字段缺失；
  - `auth-failed`：凭据被供应商拒绝；
  - `network`：DNS / 连接 / TLS / 代理等网络层错误；
  - `provider-error`：供应商返回的业务错误（4xx / 5xx）；
  - `stream-incomplete`：流未在 timeout 内自然结束；
  - `assertion-failed`：流自然结束但断言不通过（例如文本为空、tool-call 形态错误）。
- 失败时附带的请求体 dump（如有）必须先脱敏：禁止 API key、Authorization、Cookie、客户端证书等出现在控制台或报告文件中。
- 建议但不强制：失败时附带一份脱敏后的 JSON 排障 dump（请求 messages、tools 列表等），便于本地复现。

## 9. 扩展性需求

- **新增 provider**：仅修改模板与本地真实 YAML，**不**改测试代码。
- **新增用例**：仅在用例目录添加 JSON，**不**改测试代码。
- **新增能力维度**：在用例 JSON 中声明新能力字段；未声明该能力的 provider 自动跳过，不报错。
- **同一 provider 多 model**：必须可并列声明，可独立选择执行。
- 文档中必须明确：当 YAML / JSON 字段不向前兼容地变更时，如何处理（建议给出过渡期的字段废弃提示，而不是直接破坏旧文件）。

## 10. 安全与合规

- 真实凭据 YAML 必须在 `.gitignore` 中显式登记。模板文件必须 committed。
- 任何形式的输出（stdout、verbose 日志、报告文件、失败 dump）禁止包含 API key、Authorization header、Cookie、客户端证书。
- 报告文件落盘路径必须避开仓库内被 git track 的位置；建议放在仓库内但被 `.gitignore` 覆盖的目录，或开发者本地数据目录。
- 文档需提醒：本测试默认会**真实付费消耗**，开发者需自行评估额度与速率限制。

## 11. 与 docs/plan.md 的关系

- 本文档承担 `docs/plan.md` 中"测试矩阵 → 真实供应商 smoke"那一段的具体化，作为该段需求落地的对照清单。
- 与 `docs/plan.md` 描述的契约 / 单元测试矩阵互补：
  - 契约 / 单元测试保证 provider / transform 适配层不回归（不消耗真实额度，跑得起 CI）。
  - 系统测试保证一次端到端真实调用能跑通（消耗真实额度，作为合并前手动 smoke）。
- 当 `docs/plan.md` 引用具体 provider（Kimi、GLM、DeepSeek、AIHubMix 等）时，本文档只要求"必须能覆盖这些 provider"，不复述具体适配细节。

## 12. 非目标（明确写出来防止误解）

- **不**做模型质量评测、不做能力 ranking、不做 prompt 工程实验台。
- **不**替代单元 / 契约测试，不替代 provider / transform 适配测试。
- **不**承担长期监控，不是定时巡检系统。
- **不**要求覆盖所有上游支持的 provider，只覆盖本仓库实际维护的 provider 子集。
- **不**绑定具体测试框架、具体并发库、具体 YAML / JSON 解析库——这些属于实现选型。

## 13. 验收

读完本文档后，读者应能：

1. 用一句话回答系统测试要回答的问题，以及它**不**回答的问题。
2. 不看代码即能知道：要新增一个 provider，应改哪份文件、需要哪些字段、哪些字段是敏感的。
3. 不看代码即能知道：要新增一个用例，JSON 应包含哪些必需 / 可选字段，能力声明如何工作。
4. 知道用例在何种条件下被跳过、失败时能拿到哪些诊断信息、报告文件落在哪里。
5. 知道 P0 / P1 的差别，以及 CI 默认行为。

任何未来对 `packages/opencode/test/system/` 的重构，都应以本文档为准；偏离本文档的扩展（特别是把测试演化成评测）应在改动前先更新本文档。
