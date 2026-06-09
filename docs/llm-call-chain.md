# Aether LLM 调用链路文档

## 概览

Aether 通过 **Vercel AI SDK (`ai` 5.x)** 统一抽象层与 20+ 家大模型供应商对话。核心设计思路：模型元数据来自 `models.dev`，SDK 适配器按 npm 包名动态加载，所有请求最终汇聚到 `streamText()` 一个调用点。

## 调用链路全景

```mermaid
sequenceDiagram
    participant User as 用户/客户端
    participant Route as HTTP Route<br/>(session.ts)
    participant Session as Session.chat()
    participant Processor as SessionProcessor
    participant LLM as LLM.stream()<br/>唯一入口
    participant Provider as Provider<br/>(getLanguage/getSDK)
    participant Transform as ProviderTransform<br/>(消息适配)
    participant AISDK as Vercel AI SDK<br/>(streamText)
    participant API as 供应商 API

    User->>Route: POST /session/:id/message
    Route->>Session: 创建消息 & 处理器
    Session->>Processor: process(streamInput)

    loop 工具调用循环
        Processor->>LLM: stream(messages, tools, model, ...)
        LLM->>Provider: getLanguage(model)
        Provider->>Provider: getSDK(model)<br/>创建/缓存 SDK 实例
        Provider-->>LLM: LanguageModelV2

        LLM->>LLM: 组装 system prompt<br/>合并 provider options
        LLM->>AISDK: streamText({ model, messages, tools })

        Note over AISDK,Transform: wrapLanguageModel 中间件<br/>调用 ProviderTransform.message()
        AISDK->>Transform: transformParams(prompt)
        Transform->>Transform: unsupportedParts()<br/>normalizeMessages()<br/>applyCaching()
        Transform-->>AISDK: 适配后的消息

        AISDK->>API: HTTP 流式请求 (SSE)
        API-->>AISDK: 流式响应 chunks
        AISDK-->>Processor: fullStream 事件流

        Processor->>Processor: 处理事件<br/>(text/reasoning/tool-call)

        alt 有工具调用
            Processor->>Processor: 执行工具 → 注入结果
            Note over Processor: 继续下一轮循环
        else 无工具调用
            Processor-->>Session: 完成
        end
    end

    Session-->>User: SSE 推送结果
```

## 关键断点详解

### 1. `LLM.stream()` — 唯一 LLM 调用入口

**文件**: `packages/opencode/src/session/llm.ts`

所有 Agent（general/plan/explore/build/compaction/title/summary）最终都通过此函数发起 LLM 调用。它负责：

- 组装 system prompt（Agent prompt + Provider prompt + 用户自定义 prompt）
- 获取 `LanguageModelV2` 实例（`Provider.getLanguage()`）
- 合并 provider options（基础选项 + 模型选项 + Agent 选项 + variant 选项）
- 调用 Vercel AI SDK 的 `streamText()` 发起流式请求
- 应用 `wrapLanguageModel` 中间件，在发送前通过 `ProviderTransform.message()` 转换消息格式

### 2. `Provider.getLanguage()` — SDK 实例化 & 模型获取

**文件**: `packages/opencode/src/provider/provider.ts`

```mermaid
flowchart LR
    A["Provider.getLanguage(model)"] --> B["getSDK(model)"]
    B --> C{内置 bundled?}
    C -->|是| D["BUNDLED_PROVIDERS[npm](options)"]
    C -->|否| E["BunProc.install(npm)"]
    E --> F["import(installedPath)"]
    D --> G["SDK 实例 (缓存)"]
    F --> G
    G --> H{有 customModelLoader?}
    H -->|是| I["modelLoader(sdk, apiID, options)"]
    H -->|否| J["sdk.languageModel(apiID)"]
    I --> K["LanguageModelV2"]
    J --> K
```

### 3. `getSDK()` — 供应商 SDK 实例创建

**文件**: `packages/opencode/src/provider/provider.ts`

```mermaid
flowchart TB
    A["getSDK(model)"] --> B["获取 provider 配置"]
    B --> C["解析 baseURL<br/>(变量替换: ${AZURE_RESOURCE_NAME} 等)"]
    C --> D["注入自定义 fetch"]
    D --> D1["代理支持 (HTTP_PROXY)"]
    D --> D2["SSE chunk 超时"]
    D --> D3["OpenAI itemId 清理"]
    D --> E{npm 包在 BUNDLED_PROVIDERS 中?}
    E -->|是| F["直接调用 bundled 创建函数"]
    E -->|否| G{file:// 路径?}
    G -->|是| H["直接 import 本地包"]
    G -->|否| I["bun install npm@latest"]
    I --> J["import 安装路径"]
    F --> K["缓存 SDK 实例"]
    H --> K
    J --> K
```

### 4. `ProviderTransform` — 请求/响应适配层

**文件**: `packages/opencode/src/provider/transform.ts`

```mermaid
flowchart LR
    subgraph "ProviderTransform.message()"
        A["原始消息"] --> B["unsupportedParts()"]
        B --> C["normalizeMessages()"]
        C --> D{是 Anthropic/Claude?}
        D -->|是| E["applyCaching()"]
        D -->|否| F["跳过"]
        E --> G["remapProviderOptions()"]
        F --> G
        G --> H["适配后消息"]
    end

    subgraph "normalizeMessages() 分支"
        C1["Anthropic: 过滤空消息"]
        C2["Claude: 清洗 toolCallId"]
        C3["Mistral: 修复消息序列<br/>(tool→user 间插入 assistant)"]
        C4["interleaved: reasoning→providerOptions"]
    end
```

| 转换函数 | 说明 |
|----------|------|
| `unsupportedParts()` | 将模型不支持的 modality（图片/音频/PDF）替换为错误文本 |
| `normalizeMessages()` | Anthropic 过滤空消息；Claude 清洗 toolCallId；Mistral 修复消息序列 |
| `applyCaching()` | 为 Anthropic/Bedrock/OpenRouter 等添加 cache control 标记 |
| `options()` | 按供应商设置 thinking/reasoning config、store、promptCacheKey 等 |
| `variants()` | 为 reasoning 模型生成 effort 级别选项（low/medium/high/max） |
| `providerOptions()` | 将选项映射到 AI SDK 期望的 namespace key |

## 支持的供应商 & 适配方式

### 内置 Bundled Providers（直接打包）

| 供应商 | npm 包 | SDK 创建函数 | 模型获取方式 |
|--------|--------|-------------|-------------|
| Anthropic | `@ai-sdk/anthropic` | `createAnthropic` | `sdk.languageModel(id)` |
| OpenAI | `@ai-sdk/openai` | `createOpenAI` | `sdk.responses(id)` |
| Google | `@ai-sdk/google` | `createGoogleGenerativeAI` | `sdk.languageModel(id)` |
| Google Vertex | `@ai-sdk/google-vertex` | `createVertex` | `sdk.languageModel(id)` |
| Google Vertex Anthropic | `@ai-sdk/google-vertex/anthropic` | `createVertexAnthropic` | `sdk.languageModel(id)` |
| Azure | `@ai-sdk/azure` | `createAzure` | `sdk.responses(id)` / `sdk.chat(id)` |
| Amazon Bedrock | `@ai-sdk/amazon-bedrock` | `createAmazonBedrock` | `sdk.languageModel(id)` + 区域前缀 |
| OpenRouter | `@openrouter/ai-sdk-provider` | `createOpenRouter` | `sdk.languageModel(id)` |
| xAI | `@ai-sdk/xai` | `createXai` | `sdk.responses(id)` |
| Mistral | `@ai-sdk/mistral` | `createMistral` | `sdk.languageModel(id)` |
| Groq | `@ai-sdk/groq` | `createGroq` | `sdk.languageModel(id)` |
| DeepInfra | `@ai-sdk/deepinfra` | `createDeepInfra` | `sdk.languageModel(id)` |
| Cerebras | `@ai-sdk/cerebras` | `createCerebras` | `sdk.languageModel(id)` |
| Cohere | `@ai-sdk/cohere` | `createCohere` | `sdk.languageModel(id)` |
| TogetherAI | `@ai-sdk/togetherai` | `createTogetherAI` | `sdk.languageModel(id)` |
| Perplexity | `@ai-sdk/perplexity` | `createPerplexity` | `sdk.languageModel(id)` |
| Vercel | `@ai-sdk/vercel` | `createVercel` | `sdk.languageModel(id)` |
| AI Gateway | `@ai-sdk/gateway` | `createGateway` | `sdk.languageModel(id)` |
| GitLab | `gitlab-ai-provider` | `createGitLab` | `sdk.agenticChat(id)` / `sdk.workflowChat(id)` |
| GitHub Copilot | 自定义 copilot SDK | `createGitHubCopilotOpenAICompatible` | `sdk.responses(id)` / `sdk.chat(id)` |
| OpenAI Compatible | `@ai-sdk/openai-compatible` | `createOpenAICompatible` | `sdk.languageModel(id)` (兜底) |

### 动态安装 Providers

不在内置列表中的 npm 包会通过 `BunProc.install(npm, "latest")` 动态安装后加载（如 `venice-ai-sdk-provider`、`@jerome-benoit/sap-ai-provider-v2` 等）。也支持 `file://` 本地路径加载自定义 provider。

### 特殊 Custom Loaders

部分供应商需要额外逻辑，通过 `CUSTOM_LOADERS` 注册（`packages/opencode/src/provider/provider.ts`）：

| 供应商 | 特殊处理 |
|--------|---------|
| `anthropic` | 注入 `anthropic-beta` header（interleaved-thinking、fine-grained-tool-streaming） |
| `opencode` | 无 API Key 时过滤付费模型，允许 `apiKey: "public"` 免费使用 |
| `openai` / `xai` | 使用 `sdk.responses()` 而非 `sdk.languageModel()` |
| `github-copilot` | GPT-5+ 使用 `sdk.responses()`，其余用 `sdk.chat()` |
| `azure` | 支持 `resourceName` 配置，completionUrls 模式切换 |
| `amazon-bedrock` | AWS 凭证链（profile/accessKey/bearerToken/webIdentity）、跨区域推理前缀 |
| `google-vertex` | GCP OAuth token 注入、project/location 配置 |
| `gitlab` | OAuth/PAT 认证、workflow model 发现、agentic chat |
| `cloudflare-workers-ai` | accountId + apiKey 认证 |
| `cloudflare-ai-gateway` | Unified API 格式（`provider/model`） |
| `sap-ai-core` | AICORE_SERVICE_KEY 认证 |

## 模型元数据来源

```mermaid
flowchart TB
    A["models.dev/api.json<br/>(远程)"] -->|定时刷新 每小时| B["$XDG_CACHE_HOME/aether/models.json<br/>(本地缓存)"]
    C["OPENCODE_MODELS_DEV<br/>(构建时注入 fallback)"] -->|备用| D["ModelsDev.get()"]
    B --> D
    A -->|无缓存且允许联网| D
    D --> E["Provider.state() 初始化"]

    F["Config (opencode.json)<br/>provider 字段"] --> E
    G["Auth (API Key / OAuth)"] --> E
    H["Custom Loaders<br/>(autoload / options)"] --> E
    I["Plugin auth loaders"] --> E

    E --> J["最终 providers 列表<br/>(含所有可用模型)"]

    J --> K{激活检查}
    K -->|不在 disabled_providers| L["可用"]
    K -->|在 enabled_providers 白名单| L
    K -->|不满足条件| M["过滤"]
```

## Provider 激活条件

一个供应商被激活需满足以下任一条件：

1. **环境变量**: provider 定义的 `env` 字段对应的环境变量存在（如 `ANTHROPIC_API_KEY`）
2. **API Key 认证**: 通过 `opencode auth <provider>` 设置了 API Key
3. **配置文件**: `opencode.json` 中 `provider` 字段配置了该供应商
4. **Custom Loader autoload**: loader 返回 `autoload: true`（如 Bedrock 检测到 AWS 凭证）
5. **Plugin 认证**: 插件提供的 auth loader 返回了有效配置

同时不能在 `disabled_providers` 列表中，且若配置了 `enabled_providers` 白名单则必须在其中。

## 流式响应处理

```mermaid
flowchart TB
    A["streamText() 返回 fullStream"] --> B{事件类型}

    B -->|reasoning-start| C["创建 ReasoningPart"]
    B -->|reasoning-delta| D["增量追加 reasoning 文本"]
    B -->|reasoning-end| E["完成 ReasoningPart"]

    B -->|text-delta| F["增量追加 TextPart"]

    B -->|tool-call-start| G["创建 ToolPart<br/>(state: pending)"]
    B -->|tool-call-delta| H["更新 ToolPart 参数"]
    B -->|tool-call| I["执行工具<br/>(state: running → completed)"]

    B -->|step-start| J["记录 StepStartPart<br/>(创建快照)"]
    B -->|step-finish| K["记录 StepFinishPart<br/>(token 统计 & 费用)"]

    B -->|error| L["重试逻辑<br/>(最多 3 次)"]

    I --> M{还有工具调用?}
    M -->|是| N["注入工具结果<br/>继续下一轮 LLM 循环"]
    M -->|否| O["处理完成"]

    N --> A
```

`SessionProcessor` 消费 `streamText` 返回的 `fullStream`，逐事件处理并通过事件总线推送到客户端：

| 事件类型 | 处理 |
|----------|------|
| `reasoning-start/delta/end` | 创建/更新/完成 ReasoningPart |
| `text-delta` | 增量追加 TextPart |
| `tool-call-start/delta` | 创建 ToolPart (pending → running) |
| `step-start/finish` | 记录 StepStart/StepFinish Part（含 token 统计和费用） |
| `error` | 重试逻辑（最多 3 次自动重试） |

工具调用完成后，processor 将结果注入消息，继续下一轮 LLM 循环，直到模型不再请求工具调用。
