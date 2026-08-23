import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import type { ModelsDev } from "../../src/provider/models"
import { ModelID, ProviderID } from "../../src/provider/schema"

const OUTPUT_TOKEN_MAX = 32000

async function sample(pid: string, id: string) {
  const data = (await Bun.file(new URL("../tool/fixtures/models-api.json", import.meta.url)).json()) as Record<
    string,
    ModelsDev.Provider
  >
  const provider = data[pid]
  if (!provider) throw new Error(`Missing fixture provider: ${pid}`)
  const model = Provider.fromModelsDevProvider(provider).models[id]
  if (!model) throw new Error(`Missing fixture model: ${pid}/${id}`)
  return model
}

function glm(pid: string, npm = "@ai-sdk/openai-compatible", id = "glm-5.2"): Provider.Model {
  return {
    id: ModelID.make(id),
    providerID: ProviderID.make(pid),
    api: {
      id,
      url: "https://api.test.com/v1",
      npm,
    },
    name: "GLM-5.2",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: { field: "reasoning_content" },
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, output: 131_072 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-06-25",
  }
}

describe("ProviderTransform.options - setCacheKey", () => {
  const sessionID = "test-session-123"

  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should set promptCacheKey when providerOptions.setCacheKey is true", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: true },
    })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not set promptCacheKey when providerOptions.setCacheKey is false", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions is undefined", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: undefined,
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions does not have setCacheKey", () => {
    const result = ProviderTransform.options({ model: mockModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should set promptCacheKey for openai provider regardless of setCacheKey", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options({ model: openaiModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should set store=false for openai provider", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options({
      model: openaiModel,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
  })

  test("should set store=false for azure provider by default", () => {
    const model = {
      ...mockModel,
      providerID: "azure",
      api: {
        id: "gpt-5",
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
    }
    const result = ProviderTransform.options({
      model,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
  })
})

describe("ProviderTransform.options - zai/zhipuai thinking", () => {
  const sessionID = "test-session-123"

  const createModel = (pid: string) =>
    ({
      id: `${pid}/glm-4.6`,
      providerID: pid,
      api: {
        id: "glm-4.6",
        url: "https://open.bigmodel.cn/api/paas/v4",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "GLM 4.6",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  for (const pid of ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"]) {
    test(`${pid} should set thinking cfg`, () => {
      const result = ProviderTransform.options({
        model: createModel(pid),
        sessionID,
        providerOptions: {},
      })

      expect(result.thinking).toEqual({
        type: "enabled",
        clear_thinking: false,
      })
    })
  }
})

describe("ProviderTransform.options - Alibaba GLM-5.2 thinking", () => {
  test("sets a bounded thinking budget for Alibaba endpoints", () => {
    const intl = ProviderTransform.options({ model: glm("alibaba"), sessionID: "test" })
    const cn = ProviderTransform.options({ model: glm("alibaba-cn"), sessionID: "test" })

    expect(intl.enable_thinking).toBe(true)
    expect(intl.thinking_budget).toBe(32_000)
    expect(intl.clear_thinking).toBeUndefined()
    expect(cn.enable_thinking).toBe(true)
    expect(cn.thinking_budget).toBe(32_000)
    expect(cn.clear_thinking).toBe(true)
  })

  test("does not add the budget to other GLM models or providers", () => {
    expect(
      ProviderTransform.options({ model: glm("alibaba-cn", undefined, "glm-5.1"), sessionID: "test" }).thinking_budget,
    ).toBeUndefined()
    expect(ProviderTransform.options({ model: glm("aihubmix"), sessionID: "test" }).thinking_budget).toBeUndefined()
  })
})

describe("ProviderTransform.options - google thinkingConfig gating", () => {
  const sessionID = "test-session-123"

  const createGoogleModel = (reasoning: boolean, npm: "@ai-sdk/google" | "@ai-sdk/google-vertex") =>
    ({
      id: `${npm === "@ai-sdk/google" ? "google" : "google-vertex"}/gemini-2.0-flash`,
      providerID: npm === "@ai-sdk/google" ? "google" : "google-vertex",
      api: {
        id: "gemini-2.0-flash",
        url: npm === "@ai-sdk/google" ? "https://generativelanguage.googleapis.com" : "https://vertexai.googleapis.com",
        npm,
      },
      name: "Gemini 2.0 Flash",
      capabilities: {
        temperature: true,
        reasoning,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 1_000_000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("does not set thinkingConfig for google models without reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(false, "@ai-sdk/google"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })

  test("sets thinkingConfig for google models with reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(true, "@ai-sdk/google"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toEqual({
      includeThoughts: true,
    })
  })

  test("does not set thinkingConfig for vertex models without reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(false, "@ai-sdk/google-vertex"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })
})

describe("ProviderTransform.options - gpt-5 textVerbosity", () => {
  const sessionID = "test-session-123"

  const createGpt5Model = (apiId: string) =>
    ({
      id: `openai/${apiId}`,
      providerID: "openai",
      api: {
        id: apiId,
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
      name: apiId,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
      limit: { context: 128000, output: 4096 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("gpt-5.2 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.2")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
  })

  test("gpt-5.1 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.1")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
  })

  test("gpt-5.2-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.2-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.1-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.1-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5.2-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-codex should NOT have textVerbosity set (codex models excluded)", () => {
    const model = createGpt5Model("gpt-5.2-codex")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("fixture gpt-5.5 uses low verbosity with reasoning summary defaults", async () => {
    const model = await sample("openai", "gpt-5.5")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
    expect(result.reasoningEffort).toBe("medium")
    expect(result.reasoningSummary).toBe("auto")
  })

  test("fixture gpt-5.4 uses low verbosity without reasoning summary defaults", async () => {
    const model = await sample("openai", "gpt-5.4")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
    expect(result.reasoningEffort).toBeUndefined()
    expect(result.reasoningSummary).toBeUndefined()
  })
})

describe("ProviderTransform.options - gpt-5 reasoningEffort", () => {
  const sessionID = "test-session-123"

  const createModel = (id: string) =>
    ({
      id: `azure/${id}`,
      providerID: "azure",
      api: {
        id,
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
      name: id,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
      limit: { context: 128000, output: 4096 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("gpt-5-chat should NOT set reasoningEffort", () => {
    const result = ProviderTransform.options({
      model: createModel("gpt-5-chat"),
      sessionID,
      providerOptions: {},
    })

    expect(result.reasoningEffort).toBeUndefined()
  })

  test("gpt-5.5 should NOT set reasoningEffort for Azure", () => {
    const result = ProviderTransform.options({
      model: createModel("gpt-5.5"),
      sessionID,
      providerOptions: {},
    })

    expect(result.reasoningEffort).toBeUndefined()
    expect(result.reasoningSummary).toBe("auto")
  })
})

describe("ProviderTransform.options - gateway", () => {
  const sessionID = "test-session-123"

  const createModel = (id: string) =>
    ({
      id,
      providerID: "vercel",
      api: {
        id,
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
      name: id,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 200_000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2024-01-01",
    }) as any

  test("puts gateway defaults under gateway key", () => {
    const model = createModel("anthropic/claude-sonnet-4")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result).toEqual({
      gateway: {
        caching: "auto",
      },
    })
  })
})

describe("ProviderTransform.providerOptions", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "test/test-model",
      providerID: "test",
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm: "@ai-sdk/openai",
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 200_000,
        output: 64_000,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2024-01-01",
      ...overrides,
    }) as any

  test("uses sdk key for non-gateway models", () => {
    const model = createModel({
      providerID: "my-bedrock",
      api: {
        id: "anthropic.claude-sonnet-4",
        url: "https://bedrock.aws",
        npm: "@ai-sdk/amazon-bedrock",
      },
    })

    expect(ProviderTransform.providerOptions(model, { cachePoint: { type: "default" } })).toEqual({
      bedrock: { cachePoint: { type: "default" } },
    })
  })

  test("maps Bedrock Mantle provider options to OpenAI namespace", () => {
    const model = createModel({
      providerID: "amazon-bedrock",
      api: {
        id: "openai.gpt-5.5",
        url: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
        npm: "@ai-sdk/amazon-bedrock/mantle",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "medium" })).toEqual({
      openai: { reasoningEffort: "medium" },
    })
  })

  test("routes ai-gateway-provider options under openaiCompatible", () => {
    const model = createModel({
      providerID: "cloudflare-ai-gateway",
      api: {
        id: "openai/gpt-5.4",
        url: "https://gateway.ai.cloudflare.com/v1/compat",
        npm: "ai-gateway-provider",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      openaiCompatible: { reasoningEffort: "high" },
    })
  })

  test("removes responses-only reasoning fields for chat completions models", () => {
    const model = createModel({
      providerID: "custom",
      api: {
        id: "gpt-5.5",
        url: "https://api.custom.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })

    expect(
      ProviderTransform.providerOptions(model, {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }),
    ).toEqual({
      custom: {
        reasoningEffort: "high",
      },
    })
  })

  test("keeps responses-only reasoning fields for azure responses models", () => {
    const model = createModel({
      providerID: "azure",
      api: {
        id: "gpt-5",
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
    })

    expect(
      ProviderTransform.providerOptions(model, {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }),
    ).toEqual({
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
      azure: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    })
  })

  test("removes responses-only reasoning fields for azure chat completions models", () => {
    const model = createModel({
      providerID: "azure",
      api: {
        id: "gpt-5",
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
    })

    expect(
      ProviderTransform.providerOptions(
        model,
        {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
        { useCompletionUrls: true },
      ),
    ).toEqual({
      openai: {
        reasoningEffort: "high",
      },
      azure: {
        reasoningEffort: "high",
      },
    })
  })

  test("removes responses-only reasoning fields for azure model-level chat completions models", () => {
    const model = createModel({
      providerID: "azure",
      api: {
        id: "gpt-5",
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
      options: {
        useCompletionUrls: true,
      },
    })

    expect(
      ProviderTransform.providerOptions(
        model,
        {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
        model.options,
      ),
    ).toEqual({
      openai: {
        reasoningEffort: "high",
      },
      azure: {
        reasoningEffort: "high",
      },
    })
  })

  test("uses gateway model provider slug for gateway models", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 12_000 } })).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    })
  })

  test("falls back to gateway key when gateway api id is unscoped", () => {
    const model = createModel({
      id: "anthropic/claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 12_000 } })).toEqual({
      gateway: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    })
  })

  test("splits gateway routing options from provider-specific options", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(
      ProviderTransform.providerOptions(model, {
        gateway: { order: ["vertex", "anthropic"] },
        thinking: { type: "enabled", budgetTokens: 12_000 },
      }),
    ).toEqual({
      gateway: { order: ["vertex", "anthropic"] },
      anthropic: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    } as any)
  })

  test("falls back to gateway key when model id has no provider slug", () => {
    const model = createModel({
      id: "claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      gateway: { reasoningEffort: "high" },
    })
  })

  test("maps amazon slug to bedrock for provider options", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "amazon/nova-2-lite",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningConfig: { type: "enabled" } })).toEqual({
      bedrock: { reasoningConfig: { type: "enabled" } },
    })
  })

  test("uses groq slug for groq models", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "groq/llama-3.3-70b-versatile",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningFormat: "parsed" })).toEqual({
      groq: { reasoningFormat: "parsed" },
    })
  })

  test("fixture vercel gemini 3.1 routes options under google", async () => {
    const model = await sample("vercel", "google/gemini-3.1-pro-preview")
    expect(model.api.npm).toBe("@ai-sdk/gateway")

    expect(
      ProviderTransform.providerOptions(model, {
        gateway: { order: ["google"] },
        includeThoughts: true,
        thinkingLevel: "high",
      }),
    ).toEqual({
      gateway: { order: ["google"] },
      google: {
        includeThoughts: true,
        thinkingLevel: "high",
      },
    })
  })

  test("fixture vercel deepseek v4 routes options under deepseek", async () => {
    const model = await sample("vercel", "deepseek/deepseek-v4-pro")
    expect(model.api.npm).toBe("@ai-sdk/gateway")

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      deepseek: { reasoningEffort: "high" },
    })
  })

  test("fixture openrouter gemini 3.1 uses openrouter provider options", async () => {
    const model = await sample("openrouter", "google/gemini-3.1-pro-preview")
    expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")

    expect(ProviderTransform.providerOptions(model, { reasoning: { effort: "high" } })).toEqual({
      openrouter: { reasoning: { effort: "high" } },
    })
  })

  test("fixture openrouter deepseek v4 uses openrouter provider options", async () => {
    const model = await sample("openrouter", "deepseek/deepseek-v4-pro")
    expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")

    expect(ProviderTransform.providerOptions(model, { reasoning: { effort: "high" } })).toEqual({
      openrouter: { reasoning: { effort: "high" } },
    })
  })

  test("fixture vercel gpt-5.5 routes options under openai", async () => {
    const model = await sample("vercel", "openai/gpt-5.5")
    expect(model.api.npm).toBe("@ai-sdk/gateway")

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      openai: { reasoningEffort: "high" },
    })
  })

  test("fixture openrouter gpt-5.5 uses openrouter provider options", async () => {
    const model = await sample("openrouter", "openai/gpt-5.5")
    expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")

    expect(ProviderTransform.providerOptions(model, { reasoning: { effort: "high" } })).toEqual({
      openrouter: { reasoning: { effort: "high" } },
    })
  })

  test("strips maxOutputTokens from provider options", () => {
    const model = createModel({
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })

    expect(ProviderTransform.providerOptions(model, { maxOutputTokens: 65_536, reasoningEffort: "high" })).toEqual({
      test: { reasoningEffort: "high" },
    })
  })
})

describe("ProviderTransform.maxOutputTokens", () => {
  const model = {
    id: "test/model",
    providerID: "test",
    api: { id: "model", url: "https://test.com", npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, input: 868_928, output: 131_072 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-06-23",
  } as Provider.Model

  test("uses default request cap without options", () => {
    expect(ProviderTransform.maxOutputTokens(model)).toBe(OUTPUT_TOKEN_MAX)
  })

  test("uses explicit request cap", () => {
    expect(ProviderTransform.maxOutputTokens(model, { maxOutputTokens: 65_536 })).toBe(65_536)
  })

  test("ignores invalid request cap", () => {
    expect(ProviderTransform.maxOutputTokens(model, { maxOutputTokens: -1 })).toBe(OUTPUT_TOKEN_MAX)
  })

  test("does not exceed model output limit", () => {
    expect(ProviderTransform.maxOutputTokens(model, { maxOutputTokens: 262_144 })).toBe(131_072)
  })
})

describe("ProviderTransform.schema - gemini array items", () => {
  test("adds missing items for array properties", () => {
    const geminiModel = {
      providerID: "google",
      api: {
        id: "gemini-3-pro",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        nodes: { type: "array" },
        edges: { type: "array", items: { type: "string" } },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.nodes.items).toBeDefined()
    expect(result.properties.edges.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini nested array items", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("adds type to 2D array with empty inner items", () => {
    const schema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          items: {
            type: "array",
            items: {}, // Empty items object
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Inner items should have a default type
    expect(result.properties.values.items.items.type).toBe("string")
  })

  test("adds items and type to 2D array with missing inner items", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "array" }, // No items at all
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.items.items).toBeDefined()
    expect(result.properties.data.items.items.type).toBe("string")
  })

  test("handles deeply nested arrays (3D)", () => {
    const schema = {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "array",
              // No items
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.matrix.items.items.items).toBeDefined()
    expect(result.properties.matrix.items.items.items.type).toBe("string")
  })

  test("preserves existing item types in nested arrays", () => {
    const schema = {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          items: {
            type: "array",
            items: { type: "number" }, // Has explicit type
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Should preserve the explicit type
    expect(result.properties.numbers.items.items.type).toBe("number")
  })

  test("handles mixed nested structures with objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        spreadsheetData: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "array",
                items: {}, // Empty items
              },
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.spreadsheetData.properties.rows.items.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini combiner nodes", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  const walk = (node: any, cb: (node: any, path: (string | number)[]) => void, path: (string | number)[] = []) => {
    if (node === null || typeof node !== "object") {
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, cb, [...path, i]))
      return
    }
    cb(node, path)
    Object.entries(node).forEach(([key, value]) => walk(value, cb, [...path, key]))
  }

  test("keeps edits.items.anyOf without adding type", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                },
                required: ["old_string", "new_string"],
              },
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            ],
          },
        },
      },
      required: ["edits"],
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(Array.isArray(result.properties.edits.items.anyOf)).toBe(true)
    expect(result.properties.edits.items.type).toBeUndefined()
  })

  test("does not add sibling keys to combiner nodes during sanitize", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
        value: {
          oneOf: [{ type: "string" }, { type: "boolean" }],
        },
        meta: {
          allOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
            },
            {
              type: "object",
              properties: { b: { type: "string" } },
            },
          ],
        },
      },
    } as any
    const input = JSON.parse(JSON.stringify(schema))
    const result = ProviderTransform.schema(geminiModel, schema) as any

    walk(result, (node, path) => {
      const hasCombiner = Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)
      if (!hasCombiner) {
        return
      }
      const before = path.reduce((acc: any, key) => acc?.[key], input)
      const added = Object.keys(node).filter((key) => !(key in before))
      expect(added).toEqual([])
    })
  })
})

describe("ProviderTransform.schema - gemini non-object properties removal", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("removes properties from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("string")
    expect(result.properties.data.properties).toBeUndefined()
  })

  test("removes required from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "string" },
          required: ["invalid"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("array")
    expect(result.properties.data.required).toBeUndefined()
  })

  test("removes properties and required from nested non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "number",
              properties: { bad: { type: "string" } },
              required: ["bad"],
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.outer.properties.inner.type).toBe("number")
    expect(result.properties.outer.properties.inner.properties).toBeUndefined()
    expect(result.properties.outer.properties.inner.required).toBeUndefined()
  })

  test("keeps properties and required on object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("object")
    expect(result.properties.data.properties).toBeDefined()
    expect(result.properties.data.required).toEqual(["name"])
  })

  test("does not affect non-gemini providers", () => {
    const openaiModel = {
      providerID: "openai",
      api: {
        id: "gpt-4",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(openaiModel, schema) as any

    expect(result.properties.data.properties).toBeDefined()
  })
})

describe("ProviderTransform.schema - moonshot $ref siblings", () => {
  const moonshotModel = {
    providerID: "moonshotai",
    api: {
      id: "kimi-k2",
    },
  } as any

  test("removes sibling descriptions from referenced schemas", () => {
    const result = ProviderTransform.schema(
      moonshotModel,
      {
        type: "object",
        properties: {
          value: {
            $ref: "#/$defs/Value",
            description: "Moonshot rejects sibling keywords after ref expansion.",
          },
        },
        $defs: {
          Value: {
            description: "Referenced schema description stays here.",
            type: "object",
          },
        },
      } as any,
    ) as any

    expect(result.properties.value).toEqual({
      $ref: "#/$defs/Value",
    })
    expect(result.$defs.Value.description).toBe("Referenced schema description stays here.")
  })

  test("also runs for kimi models outside the moonshot provider", () => {
    const result = ProviderTransform.schema(
      {
        providerID: "openrouter",
        api: {
          id: "moonshotai/kimi-k2",
        },
      } as any,
      {
        type: "object",
        properties: {
          value: {
            $ref: "#/$defs/Value",
            description: "This sibling is rejected.",
          },
        },
      } as any,
    ) as any

    expect(result.properties.value).toEqual({
      $ref: "#/$defs/Value",
    })
  })

  test("converts tuple-style array items to a single item schema", () => {
    const result = ProviderTransform.schema(moonshotModel, {
      type: "object",
      properties: {
        point: {
          type: "array",
          items: [{ type: "number" }, { type: "number" }],
          minItems: 2,
          maxItems: 2,
        },
      },
    } as any) as any

    expect(result.properties.point.items).toEqual({
      type: "number",
    })
  })
})

describe("ProviderTransform.message - DeepSeek reasoning content", () => {
  test("fixture deepseek v4 models preserve interleaved reasoning metadata", async () => {
    const flash = await sample("deepseek", "deepseek-v4-flash")
    const pro = await sample("deepseek", "deepseek-v4-pro")

    expect(ProviderTransform.variants(flash)).toEqual({
      high: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      max: { thinking: { type: "enabled" }, reasoningEffort: "max" },
    })
    expect(ProviderTransform.variants(pro)).toEqual({
      high: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      max: { thinking: { type: "enabled" }, reasoningEffort: "max" },
    })
    expect(flash.capabilities.interleaved).toEqual({ field: "reasoning_content" })
    expect(pro.capabilities.interleaved).toEqual({ field: "reasoning_content" })

    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "v4 thinking" },
          { type: "text", text: "answer" },
        ],
      },
    ]
    const result = ProviderTransform.message(msgs, flash, {})

    expect(result[0].content).toEqual([{ type: "text", text: "answer" }])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("v4 thinking")
  })

  test("DeepSeek with tool calls includes reasoning_content in providerOptions", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          {
            type: "tool-call",
            toolCallId: "test",
            toolName: "bash",
            input: { command: "echo hello" },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelID.make("deepseek/deepseek-chat"),
        providerID: ProviderID.make("deepseek"),
        api: {
          id: "deepseek-chat",
          url: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "DeepSeek Chat",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: {
            field: "reasoning_content",
          },
        },
        cost: {
          input: 0.001,
          output: 0.002,
          cache: { read: 0.0001, write: 0.0002 },
        },
        limit: {
          context: 128000,
          output: 8192,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([
      {
        type: "tool-call",
        toolCallId: "test",
        toolName: "bash",
        input: { command: "echo hello" },
      },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("Let me think about this...")
  })

  test("Non-DeepSeek providers leave reasoning content unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Should not be processed" },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelID.make("openai/gpt-4"),
        providerID: ProviderID.make("openai"),
        api: {
          id: "gpt-4",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        name: "GPT-4",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: {
          input: 0.03,
          output: 0.06,
          cache: { read: 0.001, write: 0.002 },
        },
        limit: {
          context: 128000,
          output: 4096,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result[0].content).toEqual([
      { type: "reasoning", text: "Should not be processed" },
      { type: "text", text: "Answer" },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })
})

describe("ProviderTransform.message - surrogate sanitization", () => {
  const model = {
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("replaces lone surrogates in model-visible text", () => {
    const lone = "\uD83D"
    const valid = "🚀"
    const text = (label: string) => `${label} ${lone} and ${valid}`
    const expected = (label: string) => `${label} � and ${valid}`
    const msgs = [
      { role: "system", content: text("system") },
      { role: "user", content: text("user string") },
      {
        role: "user",
        content: [
          { type: "text", text: text("user text") },
          { type: "image", image: "data:image/png;base64,abcd" },
        ],
      },
      { role: "assistant", content: text("assistant string") },
      {
        role: "assistant",
        content: [
          { type: "text", text: text("assistant text") },
          { type: "reasoning", text: text("assistant reasoning") },
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "Read",
            output: { type: "content", value: [{ type: "text", text: text("assistant tool content") }] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "Read",
            output: { type: "text", value: text("tool text") },
          },
          {
            type: "tool-result",
            toolCallId: "call-3",
            toolName: "Read",
            output: { type: "error-text", value: text("tool error") },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content).toBe(expected("system"))
    expect(result[1].content).toBe(expected("user string"))
    expect(result[2].content[0].text).toBe(expected("user text"))
    expect(result[2].content[1]).toEqual({ type: "image", image: "data:image/png;base64,abcd" })
    expect(result[3].content[0].text).toBe(expected("assistant string"))
    expect(result[3].content[1].text).toBe(expected("assistant text"))
    expect(result[3].content[2].text).toBe(expected("assistant reasoning"))
    expect(result[3].content[3].output.value[0].text).toBe(expected("assistant tool content"))
    expect(result[4].content[0].output.value).toBe(expected("tool text"))
    expect(result[4].content[1].output.value).toBe(expected("tool error"))
  })
})

describe("ProviderTransform.message - empty image handling", () => {
  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should replace empty base64 image with error text", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: "data:image/png;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("should keep valid base64 images unchanged", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
  })

  test("should handle mixed valid and empty images", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these images" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
          { type: "image", image: "data:image/jpeg;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(3)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Compare these images" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
    expect(result[0].content[2]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })
})

describe("ProviderTransform.message - anthropic empty content filtering", () => {
  const anthropicModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("filters out messages with empty string content", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("filters out empty text parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Hello" },
          { type: "text", text: "" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Hello" })
  })

  test("filters out empty reasoning parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "Answer" },
          { type: "reasoning", text: "" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Answer" })
  })

  test("preserves empty reasoning parts with Anthropic signatures", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: { anthropic: { signature: "sig" } },
          },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({
      type: "reasoning",
      text: "",
      providerOptions: { anthropic: { signature: "sig" } },
    })
  })

  test("preserves empty reasoning parts with Bedrock redacted data", () => {
    const bedrockModel = {
      ...anthropicModel,
      id: "amazon-bedrock/anthropic.claude-opus-4-6",
      providerID: "amazon-bedrock",
      api: {
        id: "anthropic.claude-opus-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: { bedrock: { redactedData: "data" } },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, bedrockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({
      type: "reasoning",
      text: "",
      providerOptions: { bedrock: { redactedData: "data" } },
    })
  })

  test("removes entire message when all parts are empty", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "reasoning", text: "" },
        ],
      },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("keeps non-text/reasoning parts even if text parts are empty", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool-call", toolCallId: "123", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({
      type: "tool-call",
      toolCallId: "123",
      toolName: "bash",
      input: { command: "ls" },
    })
  })

  test("keeps messages with valid text alongside empty parts", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "" },
          { type: "text", text: "Result" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "reasoning", text: "Thinking..." })
    expect(result[0].content[1]).toEqual({ type: "text", text: "Result" })
  })

  test("filters empty content for bedrock provider", () => {
    const bedrockModel = {
      ...anthropicModel,
      id: "amazon-bedrock/anthropic.claude-opus-4-6",
      providerID: "amazon-bedrock",
      api: {
        id: "anthropic.claude-opus-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
    }

    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, bedrockModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toHaveLength(1)
    expect(result[1].content[0]).toEqual({ type: "text", text: "Answer" })
  })

  test("does not filter for non-anthropic providers (but merges consecutive)", () => {
    const openaiModel = {
      ...anthropicModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }

    const msgs = [
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, {})

    // Consecutive assistant messages are merged for non-Anthropic providers
    expect(result).toHaveLength(1)
    // Empty string content becomes empty text part after merge
    const content = result[0].content as any[]
    expect(content.some((part: any) => part.type === "text" && part.text === "")).toBe(true)
  })
})

describe("ProviderTransform.message - strip openai metadata when store=false", () => {
  const openaiModel = {
    id: "openai/gpt-5",
    providerID: "openai",
    api: {
      id: "gpt-5",
      url: "https://api.openai.com",
      npm: "@ai-sdk/openai",
    },
    name: "GPT-5",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("preserves itemId and reasoningEncryptedContent when store=false", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("rs_123")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBe("msg_456")
  })

  test("preserves itemId and reasoningEncryptedContent when store=false even when not openai", () => {
    const zenModel = {
      ...openaiModel,
      providerID: "zen",
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, zenModel, { store: false }) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("rs_123")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBe("msg_456")
  })

  test("preserves other openai options including itemId", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
    expect(result[0].content[0].providerOptions?.openai?.otherOption).toBe("value")
  })

  test("preserves metadata for openai package when store is true", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    // openai package preserves itemId regardless of store value
    const result = ProviderTransform.message(msgs, openaiModel, { store: true }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })

  test("preserves metadata for non-openai packages when store is false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    // store=false preserves metadata for non-openai packages
    const result = ProviderTransform.message(msgs, anthropicModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })

  test("preserves metadata using providerID key when store is false", () => {
    const opencodeModel = {
      ...openaiModel,
      providerID: "opencode",
      api: {
        id: "opencode-test",
        url: "https://api.opencode.ai",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              opencode: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, opencodeModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.opencode?.itemId).toBe("msg_123")
    expect(result[0].content[0].providerOptions?.opencode?.otherOption).toBe("value")
  })

  test("preserves itemId across all providerOptions keys", () => {
    const opencodeModel = {
      ...openaiModel,
      providerID: "opencode",
      api: {
        id: "opencode-test",
        url: "https://api.opencode.ai",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const msgs = [
      {
        role: "assistant",
        providerOptions: {
          openai: { itemId: "msg_root" },
          opencode: { itemId: "msg_opencode" },
          extra: { itemId: "msg_extra" },
        },
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: { itemId: "msg_openai_part" },
              opencode: { itemId: "msg_opencode_part" },
              extra: { itemId: "msg_extra_part" },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, opencodeModel, { store: false }) as any[]

    expect(result[0].providerOptions?.openai?.itemId).toBe("msg_root")
    expect(result[0].providerOptions?.opencode?.itemId).toBe("msg_opencode")
    expect(result[0].providerOptions?.extra?.itemId).toBe("msg_extra")
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_openai_part")
    expect(result[0].content[0].providerOptions?.opencode?.itemId).toBe("msg_opencode_part")
    expect(result[0].content[0].providerOptions?.extra?.itemId).toBe("msg_extra_part")
  })

  test("does not strip metadata for non-openai packages when store is not false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {}) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })
})

describe("ProviderTransform.message - providerOptions key remapping", () => {
  const createModel = (providerID: string, npm: string) =>
    ({
      id: `${providerID}/test-model`,
      providerID,
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm,
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("azure keeps 'azure' key and does not remap to 'openai'", () => {
    const model = createModel("azure", "@ai-sdk/azure")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          azure: { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.azure).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.openai).toBeUndefined()
  })

  test("copilot remaps providerID to 'copilot' key", () => {
    const model = createModel("github-copilot", "@ai-sdk/github-copilot")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          copilot: { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.copilot).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["github-copilot"]).toBeUndefined()
  })

  test("bedrock remaps providerID to 'bedrock' key", () => {
    const model = createModel("my-bedrock", "@ai-sdk/amazon-bedrock")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          "my-bedrock": { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.bedrock).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["my-bedrock"]).toBeUndefined()
  })
})

describe("ProviderTransform.message - claude w/bedrock custom inference profile", () => {
  test("adds cachePoint", () => {
    const model = {
      id: "amazon-bedrock/custom-claude-sonnet-4.5",
      providerID: "amazon-bedrock",
      api: {
        id: "arn:aws:bedrock:xxx:yyy:application-inference-profile/zzz",
        url: "https://api.test.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      name: "Custom inference profile",
      capabilities: {},
      options: {},
      headers: {},
    } as any

    const msgs = [
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.bedrock).toEqual(
      expect.objectContaining({
        cachePoint: {
          type: "default",
        },
      }),
    )
  })
})

describe("ProviderTransform.message - bedrock caching with non-bedrock providerID", () => {
  test("applies cache options at message level when npm package is amazon-bedrock", () => {
    const model = {
      id: "aws/us.anthropic.claude-opus-4-6-v1",
      providerID: "aws",
      api: {
        id: "us.anthropic.claude-opus-4-6-v1",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      name: "Claude Opus 4.6",
      capabilities: {},
      options: {},
      headers: {},
    } as any

    const msgs = [
      {
        role: "system",
        content: [{ type: "text", text: "You are a helpful assistant" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // Cache should be at the message level and not the content-part level
    expect(result[0].providerOptions?.bedrock).toEqual({
      cachePoint: { type: "default" },
    })
    expect(result[0].content[0].providerOptions?.bedrock).toBeUndefined()
  })
})

describe("ProviderTransform.message - cache control on gateway", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "anthropic/claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
      name: "Claude Sonnet 4",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 200_000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
      ...overrides,
    }) as any

  test("gateway does not set cache control for anthropic models", () => {
    const model = createModel()
    const msgs = [
      {
        role: "system",
        content: [{ type: "text", text: "You are a helpful assistant" }],
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content[0].providerOptions).toBeUndefined()
    expect(result[0].providerOptions).toBeUndefined()
  })

  test("non-gateway anthropic keeps existing cache control behavior", () => {
    const model = createModel({
      providerID: "anthropic",
      api: {
        id: "claude-sonnet-4",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    })
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      openrouter: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      bedrock: {
        cachePoint: {
          type: "default",
        },
      },
      openaiCompatible: {
        cache_control: {
          type: "ephemeral",
        },
      },
      copilot: {
        copilot_cache_control: {
          type: "ephemeral",
        },
      },
    })
  })
})

describe("ProviderTransform.variants", () => {
  const createMockModel = (overrides: Partial<any> = {}): any => ({
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.001,
      output: 0.002,
      cache: { read: 0.0001, write: 0.0002 },
    },
    limit: {
      context: 200_000,
      output: 64_000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
    ...overrides,
  })

  test("returns empty object when model has no reasoning capabilities", () => {
    const model = createMockModel({
      capabilities: { reasoning: false },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("deepseek returns empty object", () => {
    const model = createMockModel({
      id: "deepseek/deepseek-chat",
      providerID: "deepseek",
      api: {
        id: "deepseek-chat",
        url: "https://api.deepseek.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("minimax returns empty object", () => {
    const model = createMockModel({
      id: "minimax/minimax-model",
      providerID: "minimax",
      api: {
        id: "minimax-model",
        url: "https://api.minimax.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("glm returns empty object", () => {
    const model = createMockModel({
      id: "glm/glm-4",
      providerID: "glm",
      api: {
        id: "glm-4",
        url: "https://api.glm.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("Alibaba GLM-5.2 exposes every documented reasoning effort", () => {
    for (const pid of ["alibaba", "alibaba-cn"]) {
      const result = ProviderTransform.variants(glm(pid))
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      expect(result.none).toEqual({
        enable_thinking: false,
        thinking_budget: undefined,
        reasoningEffort: undefined,
        reasoning_effort: undefined,
      })
      expect(result.minimal).toEqual({ enable_thinking: true, reasoningEffort: "minimal" })
      expect(result.max).toEqual({ enable_thinking: true, reasoningEffort: "max" })
    }
  })

  test("GLM-5.2 uses provider-specific upstream variants", () => {
    expect(ProviderTransform.variants(glm("openrouter", "@openrouter/ai-sdk-provider"))).toEqual({
      high: { reasoning: { effort: "high" } },
      xhigh: { reasoning: { effort: "xhigh" } },
    })
    expect(ProviderTransform.variants(glm("aihubmix"))).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
    expect(ProviderTransform.variants(glm("anthropic", "@ai-sdk/anthropic", "vendor/glm-5p2"))).toEqual({
      high: { effort: "high" },
      max: { effort: "max" },
    })
  })

    test("mistral returns empty object", () => {
      const model = createMockModel({
        id: "mistral/mistral-large",
        providerID: "mistral",
        api: {
        id: "mistral-large-latest",
        url: "https://api.mistral.com",
        npm: "@ai-sdk/mistral",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  describe("@openrouter/ai-sdk-provider", () => {
    test("returns empty object for non-qualifying models", () => {
      const model = createMockModel({
        id: "openrouter/test-model",
        providerID: "openrouter",
        api: {
          id: "test-model",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("fixture mistral small 2603 keeps mistral package without variants", async () => {
      const model = await sample("mistral", "mistral-small-2603")
      expect(model.api.npm).toBe("@ai-sdk/mistral")
      expect(model.capabilities.input.image).toBe(true)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("gpt models return OPENAI_EFFORTS with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/gpt-4",
        providerID: "openrouter",
        api: {
          id: "gpt-4",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.low).toEqual({ reasoning: { effort: "low" } })
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    test("gemini-3 returns OPENAI_EFFORTS with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/gemini-3-5-pro",
        providerID: "openrouter",
        api: {
          id: "gemini-3-5-pro",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
    })

    test("grok-4 returns empty object", () => {
      const model = createMockModel({
        id: "openrouter/grok-4",
        providerID: "openrouter",
        api: {
          id: "grok-4",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("grok-3-mini returns low and high with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/grok-3-mini",
        providerID: "openrouter",
        api: {
          id: "grok-3-mini",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({ reasoning: { effort: "low" } })
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    test("fixture gemini 3.1 returns openrouter reasoning variants", async () => {
      const model = await sample("openrouter", "google/gemini-3.1-flash-lite-preview")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    test("fixture deepseek v4 returns openrouter reasoning variants", async () => {
      const model = await sample("openrouter", "deepseek/deepseek-v4-flash")
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(ProviderTransform.variants(model)).toEqual({
        high: { reasoning: { effort: "high" } },
        max: { reasoning: { effort: "max" } },
      })
    })

    test("fixture openrouter gpt-5.4 uses openrouter reasoning variants", async () => {
      const model = await sample("openrouter", "openai/gpt-5.4")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high", "xhigh"])
      expect(result.xhigh).toEqual({ reasoning: { effort: "xhigh" } })
    })

    test("fixture openrouter gpt-5.4 pro keeps openrouter override", async () => {
      const model = await sample("openrouter", "openai/gpt-5.4-pro")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(model.capabilities.input.pdf).toBe(true)
      expect(Object.keys(result)).toEqual(["medium", "high", "xhigh"])
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    test("fixture openrouter image model keeps image output without variants", async () => {
      const model = await sample("openrouter", "black-forest-labs/flux.2-pro")
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(model.capabilities.output.image).toBe(true)
      expect(model.capabilities.output.text).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture openrouter gemini image model returns reasoning variants", async () => {
      const model = await sample("openrouter", "google/gemini-3.1-flash-image-preview")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(model.capabilities.output.image).toBe(true)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    test("fixture openrouter gpt oss free returns reasoning variants", async () => {
      const model = await sample("openrouter", "openai/gpt-oss-120b:free")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    test("fixture openrouter nvidia reasoning model has no generic variants", async () => {
      const model = await sample("openrouter", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(model.capabilities.input.video).toBe(true)
      expect(model.capabilities.input.audio).toBe(true)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture openrouter sourceful image model keeps image output without variants", async () => {
      const model = await sample("openrouter", "sourceful/riverflow-v2-max-preview")
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(model.capabilities.input.image).toBe(true)
      expect(model.capabilities.output.image).toBe(true)
      expect(model.capabilities.output.text).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture openrouter mimo omni preserves multimodal interleaved metadata", async () => {
      const model = await sample("openrouter", "xiaomi/mimo-v2-omni")
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(model.capabilities.input.audio).toBe(true)
      expect(model.capabilities.input.pdf).toBe(true)
      expect(model.capabilities.interleaved).toEqual({ field: "reasoning_details" })
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture openrouter glm preserves reasoning content metadata without variants", async () => {
      const model = await sample("openrouter", "z-ai/glm-5")
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(model.capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture openrouter claude opus 4.7 uses openrouter reasoning variants", async () => {
      const model = await sample("openrouter", "anthropic/claude-opus-4.7")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@openrouter/ai-sdk-provider")
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })
  })

  describe("@ai-sdk/gateway", () => {
    test("anthropic sonnet 4.6 models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4-6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.medium).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "medium",
      })
    })

    test("anthropic sonnet 4.6 dot-format models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4.6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.medium).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "medium",
      })
    })

    test("anthropic opus 4.6 dot-format models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4.6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("anthropic opus 4.7 models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-7",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4.7",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "xhigh",
      })
    })

    test("anthropic models return anthropic thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })

    test("returns OPENAI_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "gateway/gateway-model",
        providerID: "gateway",
        api: {
          id: "gateway-model",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture vercel gemini 3.1 returns gateway google thinking variants", async () => {
      const model = await sample("vercel", "google/gemini-3.1-flash-lite-preview")
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({
        includeThoughts: true,
        thinkingLevel: "low",
      })
      expect(result.high).toEqual({
        includeThoughts: true,
        thinkingLevel: "high",
      })
    })

    test("fixture vercel deepseek v4 returns reasoning variants", async () => {
      const model = await sample("vercel", "deepseek/deepseek-v4-flash")
      expect(ProviderTransform.variants(model)).toEqual({
        high: { thinking: { type: "enabled" }, reasoningEffort: "high" },
        max: { thinking: { type: "enabled" }, reasoningEffort: "max" },
      })
    })

    test("fixture vercel claude opus 4.7 returns summarized adaptive variants", async () => {
      const model = await sample("vercel", "anthropic/claude-opus-4.7")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/gateway")
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "xhigh",
      })
    })
  })

  describe("@ai-sdk/github-copilot", () => {
    test("standard models return low, medium, high", () => {
      const model = createMockModel({
        id: "gpt-4.5",
        providerID: "github-copilot",
        api: {
          id: "gpt-4.5",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5.1-codex-max includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex-max",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex-max",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.1-codex-mini does not include xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex-mini",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex-mini",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })

    test("gpt-5.1-codex does not include xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })

    test("gpt-5.2 includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.2",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.2",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
      expect(result.xhigh).toEqual({
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5.2-codex includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.2-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.2-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.3-codex includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.3-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.3-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.4 includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.4",
        release_date: "2026-03-05",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.4",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })
  })

  describe("@ai-sdk/cerebras", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "cerebras/llama-4",
        providerID: "cerebras",
        api: {
          id: "llama-4-sc",
          url: "https://api.cerebras.ai",
          npm: "@ai-sdk/cerebras",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture llama 3.1 8b has no reasoning variants", async () => {
      const model = await sample("cerebras", "llama3.1-8b")
      expect(model.api.npm).toBe("@ai-sdk/cerebras")
      expect(model.capabilities.reasoning).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@ai-sdk/togetherai", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "togetherai/llama-4",
        providerID: "togetherai",
        api: {
          id: "llama-4-sc",
          url: "https://api.togetherai.com",
          npm: "@ai-sdk/togetherai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/xai", () => {
    test("grok-3 returns empty object", () => {
      const model = createMockModel({
        id: "xai/grok-3",
        providerID: "xai",
        api: {
          id: "grok-3",
          url: "https://api.x.ai",
          npm: "@ai-sdk/xai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("grok-3-mini returns low and high with reasoningEffort", () => {
      const model = createMockModel({
        id: "xai/grok-3-mini",
        providerID: "xai",
        api: {
          id: "grok-3-mini",
          url: "https://api.x.ai",
          npm: "@ai-sdk/xai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture grok 4.20 reasoning keeps xai package without generic variants", async () => {
      const model = await sample("xai", "grok-4.20-0309-reasoning")
      expect(model.api.npm).toBe("@ai-sdk/xai")
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@ai-sdk/deepinfra", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "deepinfra/llama-4",
        providerID: "deepinfra",
        api: {
          id: "llama-4-sc",
          url: "https://api.deepinfra.com",
          npm: "@ai-sdk/deepinfra",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/openai-compatible", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "custom-provider/custom-model",
        providerID: "custom-provider",
        api: {
          id: "custom-model",
          url: "https://api.custom.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture github copilot gpt-5.4 uses compatible reasoning variants", async () => {
      const model = await sample("github-copilot", "gpt-5.4")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.api.url).toBe("https://api.githubcopilot.com")
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture fastrouter glm keeps reasoning metadata without variants", async () => {
      const model = await sample("fastrouter", "z-ai/glm-5")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture scaleway embedding has no tool or reasoning variants", async () => {
      const model = await sample("scaleway", "qwen3-embedding-8b")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.toolcall).toBe(false)
      expect(model.capabilities.reasoning).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture 302ai claude opus 4.6 uses compatible reasoning variants", async () => {
      const model = await sample("302ai", "claude-opus-4-6")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.input.pdf).toBe(true)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture alibaba cn glm keeps reasoning content metadata", async () => {
      const model = await sample("alibaba-cn", "glm-5")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture alibaba cn deepseek v4 returns reasoning variants", async () => {
      const flash = await sample("alibaba-cn", "deepseek-v4-flash")
      const pro = await sample("alibaba-cn", "deepseek-v4-pro")
      const r1 = await sample("alibaba-cn", "deepseek-r1")
      const want = {
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      }

      expect(ProviderTransform.variants(flash)).toEqual(want)
      expect(ProviderTransform.variants(pro)).toEqual(want)
      expect(ProviderTransform.variants(r1)).toEqual({})

      const base = ProviderTransform.options({ model: pro, sessionID: "test", providerOptions: {} })
      expect(ProviderTransform.providerOptions(pro, { ...base, ...want.max })).toEqual({
        "alibaba-cn": {
          enable_thinking: true,
          reasoningEffort: "max",
        },
      })
    })

    test("alibaba cn deepseek v4 dated variants return reasoning effort", () => {
      const want = {
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      }
      for (const id of ["deepseek-v4-flash-0731", "deepseek-v4-pro-0813"]) {
        const model = createMockModel({
          id,
          providerID: "alibaba-cn",
          api: {
            id,
            url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            npm: "@ai-sdk/openai-compatible",
          },
        })
        expect(ProviderTransform.variants(model)).toEqual(want)
      }
    })

    test("fixture chutes non-reasoning model has no variants", async () => {
      const model = await sample("chutes", "XiaomiMiMo/MiMo-V2-Flash-TEE")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.reasoning).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture huggingface deepseek keeps reasoning content metadata", async () => {
      const model = await sample("huggingface", "deepseek-ai/DeepSeek-V4-Pro")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture nano gpt anthropic model uses compatible reasoning variants", async () => {
      const model = await sample("nano-gpt", "anthropic/claude-opus-4.6")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.input.pdf).toBe(true)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture nano gpt non-reasoning model has no variants", async () => {
      const model = await sample("nano-gpt", "amazon/nova-2-lite-v1")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.reasoning).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("fixture cloudflare workers ai gpt oss uses compatible override", async () => {
      const model = await sample("cloudflare-workers-ai", "@cf/openai/gpt-oss-120b")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture kilo claude uses compatible reasoning variants", async () => {
      const model = await sample("kilo", "anthropic/claude-opus-4.7")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.input.pdf).toBe(true)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture llmgateway gpt-5 uses compatible reasoning variants", async () => {
      const model = await sample("llmgateway", "gpt-5")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("fixture model-level package overrides", () => {
    test("aihubmix migrated models use aihubmix package override", async () => {
      const model = await sample("aihubmix", "claude-opus-4-7")
      expect(model.api.npm).toBe("@aihubmix/ai-sdk-provider")
      expect(model.capabilities.input.pdf).toBe(true)
      expect(ProviderTransform.variants(model)).toEqual({})
    })

    test("cloudflare ai gateway migrated models use gateway package override", async () => {
      const model = await sample("cloudflare-ai-gateway", "anthropic/claude-opus-4-7")
      expect(model.api.npm).toBe("ai-gateway-provider")
      expect(model.api.url).toBe("https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/compat/")
      expect(ProviderTransform.variants(model)).toEqual({
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
      })
    })
  })

  describe("ai-gateway-provider (cloudflare-ai-gateway)", () => {
    const createModel = (id: string, date = "2024-01-01") =>
      createMockModel({
        id: `cloudflare-ai-gateway/${id}`,
        providerID: "cloudflare-ai-gateway",
        api: {
          id,
          url: "https://gateway.ai.cloudflare.com/v1/compat",
          npm: "ai-gateway-provider",
        },
        release_date: date,
      })

    for (const item of [
      { id: "openai/gpt-5.4", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5.2-codex", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5.3-codex", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-pro", efforts: ["high"] },
      { id: "openai/gpt-5.2-pro", efforts: ["medium", "high", "xhigh"] },
      { id: "openai/gpt-5-chat-latest", efforts: [] },
      { id: "openai/gpt-5.2-chat-latest", efforts: ["medium"] },
    ]) {
      test(`${item.id} returns supported reasoning efforts`, () => {
        const result = ProviderTransform.variants(createModel(item.id, "2026-03-05"))
        expect(Object.keys(result)).toEqual(item.efforts)
      })
    }

    test("non-openai upstream falls back to widely-supported OAI efforts", () => {
      expect(ProviderTransform.variants(createModel("anthropic/claude-sonnet-4-6"))).toEqual({
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
      })
    })
  })

  describe("@ai-sdk/azure", () => {
    test("o1-mini returns empty object", () => {
      const model = createMockModel({
        id: "o1-mini",
        providerID: "azure",
        api: {
          id: "o1-mini",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("standard azure models return custom efforts with reasoningSummary", () => {
      const model = createMockModel({
        id: "o1",
        providerID: "azure",
        api: {
          id: "o1",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5 adds minimal effort", () => {
      const model = createMockModel({
        id: "gpt-5",
        providerID: "azure",
        api: {
          id: "gpt-5",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["minimal", "low", "medium", "high"])
    })

    for (const item of [
      { id: "gpt-5-1", efforts: ["none", "low", "medium", "high"] },
      { id: "gpt-5-4", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5-5", efforts: ["none", "low", "medium", "high", "xhigh"] },
    ]) {
      test(`${item.id} returns supported Azure reasoning efforts`, () => {
        const result = ProviderTransform.variants(
          createMockModel({
            id: item.id,
            providerID: "azure",
            api: {
              id: item.id,
              url: "https://azure.com",
              npm: "@ai-sdk/azure",
            },
          }),
        )
        expect(Object.keys(result)).toEqual(item.efforts)
      })
    }

    test("fixture gpt-5.4 returns azure reasoning variants", async () => {
      const model = await sample("azure", "gpt-5.4")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/azure")
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high", "xhigh"])
      expect(result.high).toEqual({
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("fixture kimi k2.5 uses model-level openai-compatible provider", async () => {
      const model = await sample("azure", "kimi-k2.5")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.api.url).toBe("https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/models")
      expect(model.capabilities.interleaved).toBe(true)
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@ai-sdk/openai", () => {
    test("gpt-5-pro returns only high effort", () => {
      const model = createMockModel({
        id: "gpt-5-pro",
        providerID: "openai",
        api: {
          id: "gpt-5-pro",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high"])
    })

    test("standard openai models return custom efforts with reasoningSummary", () => {
      const model = createMockModel({
        id: "gpt-5",
        providerID: "openai",
        api: {
          id: "gpt-5",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2024-06-01",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["minimal", "low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("models after 2025-11-13 include 'none' effort", () => {
      const model = createMockModel({
        id: "gpt-5-nano",
        providerID: "openai",
        api: {
          id: "gpt-5-nano",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2025-11-14",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high"])
    })

    test("models after 2025-12-04 include 'xhigh' effort", () => {
      const model = createMockModel({
        id: "openai/gpt-5-reasoning",
        providerID: "openai",
        api: {
          id: "gpt-5-reasoning",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2025-12-05",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
    })

    for (const item of [
      { id: "o1", date: "2024-12-17", efforts: ["low", "medium", "high"] },
      { id: "o3-deep-research", date: "2025-06-26", efforts: ["medium"] },
      { id: "gpt-5.1", date: "2025-11-13", efforts: ["none", "low", "medium", "high"] },
      { id: "gpt-5.4", date: "2026-03-05", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4-pro", date: "2026-03-05", efforts: ["medium", "high", "xhigh"] },
      { id: "gpt-5-codex", date: "2025-09-23", efforts: ["low", "medium", "high"] },
      { id: "gpt-5.3-codex", date: "2026-01-22", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5-chat-latest", date: "2025-08-07", efforts: [] },
      { id: "gpt-5.2-chat-latest", date: "2025-12-11", efforts: ["medium"] },
    ]) {
      test(`${item.id} returns supported reasoning efforts`, () => {
        const result = ProviderTransform.variants(
          createMockModel({
            id: item.id,
            providerID: "openai",
            api: {
              id: item.id,
              url: "https://api.openai.com",
              npm: "@ai-sdk/openai",
            },
            release_date: item.date,
          }),
        )
        expect(Object.keys(result)).toEqual(item.efforts)
      })
    }

    test("fixture gpt-5.5 includes current reasoning efforts", async () => {
      const model = await sample("openai", "gpt-5.5")
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high", "xhigh"])
      expect(result.xhigh).toEqual({
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("fixture gpt-5.4 uses reasoning effort variants without responses metadata", async () => {
      const model = await sample("openai", "gpt-5.4")
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high", "xhigh"])
      expect(result.high).toEqual({
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("fixture gpt-image-1 exposes image output without reasoning variants", async () => {
      const model = await sample("openai", "gpt-image-1")
      expect(model.api.npm).toBe("@ai-sdk/openai")
      expect(model.capabilities.output.image).toBe(true)
      expect(model.capabilities.output.text).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@ai-sdk/amazon-bedrock/mantle", () => {
    test("gpt-5.5 returns OpenAI-style reasoning variants", () => {
      const model = createMockModel({
        id: "openai.gpt-5.5",
        providerID: "amazon-bedrock",
        api: {
          id: "openai.gpt-5.5",
          url: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
          npm: "@ai-sdk/amazon-bedrock/mantle",
        },
        release_date: "2026-04-23",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high", "xhigh"])
      expect(result.medium).toEqual({
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })
  })

  describe("@ai-sdk/anthropic", () => {
    test("sonnet 4.6 returns adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "anthropic",
        api: {
          id: "claude-sonnet-4-6",
          url: "https://api.anthropic.com",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("opus 4.7 returns adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4.7",
        providerID: "anthropic",
        api: {
          id: "claude-opus-4.7",
          url: "https://api.anthropic.com",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("vertex opus 4.8 suffix models return summarized adaptive thinking options", () => {
      const model = createMockModel({
        id: "google-vertex-anthropic/claude-opus-4-8@default",
        providerID: "google-vertex-anthropic",
        api: {
          id: "claude-opus-4-8@default",
          url: "https://vertexai.googleapis.com",
          npm: "@ai-sdk/google-vertex/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("returns high and max with thinking config", () => {
      const model = createMockModel({
        id: "anthropic/claude-4",
        providerID: "anthropic",
        api: {
          id: "claude-4",
          url: "https://api.anthropic.com",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })

    test("fixture claude opus 4.7 returns summarized adaptive variants", async () => {
      const model = await sample("anthropic", "claude-opus-4-7")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/anthropic")
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("fixture vertex anthropic claude opus 4.7 returns summarized adaptive variants", async () => {
      const model = await sample("google-vertex-anthropic", "claude-opus-4-7@default")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/google-vertex/anthropic")
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.max).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "max",
      })
    })

    test("fixture google vertex claude opus 4.7 uses model-level anthropic provider", async () => {
      const model = await sample("google-vertex", "claude-opus-4-7@default")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/google-vertex/anthropic")
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("fixture azure claude opus 4.6 uses model-level anthropic provider", async () => {
      const model = await sample("azure", "claude-opus-4-6")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/anthropic")
      expect(model.api.url).toBe("https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1")
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("fixture kimi coding k2p6 uses anthropic thinking variants", async () => {
      const model = await sample("kimi-for-coding", "k2p6")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/anthropic")
      expect(model.capabilities.input.video).toBe(true)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
    })

    test("fixture minimax m2.7 keeps anthropic package without variants", async () => {
      const model = await sample("minimax", "MiniMax-M2.7")
      expect(model.api.npm).toBe("@ai-sdk/anthropic")
      expect(model.api.url).toBe("https://api.minimax.io/anthropic/v1")
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@ai-sdk/amazon-bedrock", () => {
    test("anthropic sonnet 4.6 returns adaptive reasoning options", () => {
      const model = createMockModel({
        id: "bedrock/anthropic-claude-sonnet-4-6",
        providerID: "bedrock",
        api: {
          id: "anthropic.claude-sonnet-4-6",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.max).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "max",
        },
      })
    })

    test("anthropic opus 4.7 returns adaptive reasoning options", () => {
      const model = createMockModel({
        id: "bedrock/anthropic-claude-opus-4-7",
        providerID: "bedrock",
        api: {
          id: "anthropic.claude-opus-4.7",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "xhigh",
          display: "summarized",
        },
      })
    })

    test("anthropic opus 4.8 returns summarized adaptive reasoning options", () => {
      const model = createMockModel({
        id: "bedrock/anthropic-claude-opus-4-8",
        providerID: "bedrock",
        api: {
          id: "anthropic.claude-opus-4.8",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "high",
          display: "summarized",
        },
      })
    })

    test("fixture bedrock global claude opus 4.7 returns summarized adaptive variants", async () => {
      const model = await sample("amazon-bedrock", "global.anthropic.claude-opus-4-7")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/amazon-bedrock")
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "xhigh",
          display: "summarized",
        },
      })
    })

    test("fixture bedrock nvidia reasoning model uses reasoningConfig variants", async () => {
      const model = await sample("amazon-bedrock", "nvidia.nemotron-super-3-120b")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/amazon-bedrock")
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.high).toEqual({
        reasoningConfig: {
          type: "enabled",
          maxReasoningEffort: "high",
        },
      })
    })

    test("fixture bedrock deepseek and minimax models do not create generic variants", async () => {
      expect(ProviderTransform.variants(await sample("amazon-bedrock", "deepseek.v3.2"))).toEqual({})
      expect(ProviderTransform.variants(await sample("amazon-bedrock", "minimax.minimax-m2.5"))).toEqual({})
    })

    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningConfig", () => {
      const model = createMockModel({
        id: "bedrock/llama-4",
        providerID: "bedrock",
        api: {
          id: "llama-4-sc",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningConfig: {
          type: "enabled",
          maxReasoningEffort: "low",
        },
      })
    })
  })

  describe("@ai-sdk/google", () => {
    test("gemini-2.5 returns high and max with thinkingConfig and thinkingBudget", () => {
      const model = createMockModel({
        id: "google/gemini-2.5-pro",
        providerID: "google",
        api: {
          id: "gemini-2.5-pro",
          url: "https://generativelanguage.googleapis.com",
          npm: "@ai-sdk/google",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 16000,
        },
      })
      expect(result.max).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 32768,
        },
      })
    })

    test("other gemini models return low and high with thinkingLevel", () => {
      const model = createMockModel({
        id: "google/gemini-2.0-pro",
        providerID: "google",
        api: {
          id: "gemini-2.0-pro",
          url: "https://generativelanguage.googleapis.com",
          npm: "@ai-sdk/google",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "low",
        },
      })
      expect(result.high).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      })
    })

    test("fixture gemini-3.1 pro preview uses high thinking defaults", async () => {
      const model = await sample("google", "gemini-3.1-pro-preview")
      expect(model.api.npm).toBe("@ai-sdk/google")
      expect(model.capabilities.reasoning).toBe(true)
      expect(Object.keys(model.variants ?? {})).toEqual(["low", "medium", "high"])
      expect(
        ProviderTransform.options({
          model,
          sessionID: "test-session-123",
          providerOptions: {},
        }).thinkingConfig,
      ).toEqual({
        includeThoughts: true,
        thinkingLevel: "high",
      })
    })

    test("fixture gemini-3.1 flash lite preview uses small thinkingLevel", async () => {
      const model = await sample("google", "gemini-3.1-flash-lite-preview")
      expect(model.api.npm).toBe("@ai-sdk/google")
      expect(Object.keys(model.variants ?? {})).toEqual(["minimal", "low", "medium", "high"])
      expect(ProviderTransform.smallOptions(model)).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "minimal",
        },
      })
      expect(
        ProviderTransform.options({
          model,
          sessionID: "test-session-123",
          providerOptions: {},
        }).thinkingConfig,
      ).toEqual({
        includeThoughts: true,
        thinkingLevel: "high",
      })
    })
  })

  describe("@ai-sdk/google-vertex", () => {
    test("gemini-2.5 returns high and max with thinkingConfig and thinkingBudget", () => {
      const model = createMockModel({
        id: "google-vertex/gemini-2.5-pro",
        providerID: "google-vertex",
        api: {
          id: "gemini-2.5-pro",
          url: "https://vertexai.googleapis.com",
          npm: "@ai-sdk/google-vertex",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
    })

    test("other vertex models return low and high with thinkingLevel", () => {
      const model = createMockModel({
        id: "google-vertex/gemini-2.0-pro",
        providerID: "google-vertex",
        api: {
          id: "gemini-2.0-pro",
          url: "https://vertexai.googleapis.com",
          npm: "@ai-sdk/google-vertex",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
    })

    test("fixture gemini 3.1 flash lite returns medium thinking variants", async () => {
      const model = await sample("google-vertex", "gemini-3.1-flash-lite")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/google-vertex")
      expect(model.capabilities.input.audio).toBe(true)
      expect(Object.keys(result)).toEqual(["minimal", "low", "medium", "high"])
      expect(result.high).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      })
    })
  })

  describe("@ai-sdk/cohere", () => {
    test("returns empty object", () => {
      const model = createMockModel({
        id: "cohere/command-r",
        providerID: "cohere",
        api: {
          id: "command-r",
          url: "https://api.cohere.com",
          npm: "@ai-sdk/cohere",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("fixture aya vision exposes image input without variants", async () => {
      const model = await sample("cohere", "c4ai-aya-vision-32b")
      expect(model.api.npm).toBe("@ai-sdk/cohere")
      expect(model.capabilities.input.image).toBe(true)
      expect(model.capabilities.toolcall).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@ai-sdk/groq", () => {
    test("returns none and WIDELY_SUPPORTED_EFFORTS with thinkingLevel", () => {
      const model = createMockModel({
        id: "groq/llama-4",
        providerID: "groq",
        api: {
          id: "llama-4-sc",
          url: "https://api.groq.com",
          npm: "@ai-sdk/groq",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high"])
      expect(result.none).toEqual({
        reasoningEffort: "none",
      })
      expect(result.low).toEqual({
        reasoningEffort: "low",
      })
    })

    test("fixture compound returns groq reasoning variants", async () => {
      const model = await sample("groq", "groq/compound")
      const result = ProviderTransform.variants(model)
      expect(model.api.npm).toBe("@ai-sdk/groq")
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high"])
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("fixture whisper exposes audio input without variants", async () => {
      const model = await sample("groq", "whisper-large-v3")
      expect(model.api.npm).toBe("@ai-sdk/groq")
      expect(model.capabilities.input.audio).toBe(true)
      expect(model.capabilities.input.text).toBe(false)
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@ai-sdk/perplexity", () => {
    test("returns empty object", () => {
      const model = createMockModel({
        id: "perplexity/sonar-plus",
        providerID: "perplexity",
        api: {
          id: "sonar-plus",
          url: "https://api.perplexity.ai",
          npm: "@ai-sdk/perplexity",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("fixture sonar deep research has no variants", async () => {
      const model = await sample("perplexity", "sonar-deep-research")
      expect(model.api.npm).toBe("@ai-sdk/perplexity")
      expect(model.capabilities.reasoning).toBe(true)
      expect(ProviderTransform.variants(model)).toEqual({})
    })
  })

  describe("@jerome-benoit/sap-ai-provider-v2", () => {
    test("anthropic models return thinking variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/anthropic--claude-sonnet-4",
        providerID: "sap-ai-core",
        api: {
          id: "anthropic--claude-sonnet-4",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })

    test("anthropic 4.6 models return adaptive thinking variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/anthropic--claude-sonnet-4-6",
        providerID: "sap-ai-core",
        api: {
          id: "anthropic--claude-sonnet-4-6",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.low).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "low",
      })
      expect(result.max).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "max",
      })
    })

    test("anthropic reversed opus 4.7 models return summarized adaptive thinking variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/anthropic--claude-4.7-opus",
        providerID: "sap-ai-core",
        api: {
          id: "anthropic--claude-4.7-opus",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("gemini 2.5 models return thinkingConfig variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/gcp--gemini-2.5-pro",
        providerID: "sap-ai-core",
        api: {
          id: "gcp--gemini-2.5-pro",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 16000,
        },
      })
      expect(result.max).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 24576,
        },
      })
    })

    test("gpt models return reasoningEffort variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/azure-openai--gpt-4o",
        providerID: "sap-ai-core",
        api: {
          id: "azure-openai--gpt-4o",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("o-series models return reasoningEffort variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/azure-openai--o3-mini",
        providerID: "sap-ai-core",
        api: {
          id: "azure-openai--o3-mini",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("sonar models return empty object", () => {
      const model = createMockModel({
        id: "sap-ai-core/perplexity--sonar-pro",
        providerID: "sap-ai-core",
        api: {
          id: "perplexity--sonar-pro",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("mistral models return empty object", () => {
      const model = createMockModel({
        id: "sap-ai-core/mistral--mistral-large",
        providerID: "sap-ai-core",
        api: {
          id: "mistral--mistral-large",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })
  })
})

describe("ProviderTransform.smallOptions - gpt-5 chat/search", () => {
  const createModel = (id: string) => {
    const model = {
      id: `openai/${id}`,
      providerID: "openai",
      api: {
        id,
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
      release_date: "2026-01-01",
    } as any
    model.variants = ProviderTransform.variants(model)
    return model
  }

  for (const item of [
    { id: "gpt-5-chat-latest", options: { store: false } },
    {
      id: "gpt-5.1-chat-latest",
      options: {
        store: false,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    {
      id: "gpt-5.2-chat-latest",
      options: {
        store: false,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    {
      id: "gpt-5-search-api",
      options: {
        store: false,
        reasoningEffort: "none",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
  ]) {
    test(`${item.id} returns only supported small options`, () => {
      expect(ProviderTransform.smallOptions(createModel(item.id))).toEqual(item.options)
    })
  }
})

describe("ProviderTransform.smallOptions - google thinking controls", () => {
  const createModel = (id: string) => {
    const model = {
      id: `google/${id}`,
      providerID: "google",
      api: {
        id,
        url: "https://generativelanguage.googleapis.com",
        npm: "@ai-sdk/google",
      },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
    } as any
    model.variants = ProviderTransform.variants(model)
    return model
  }

  for (const item of [
    { id: "gemini-3-pro-preview", options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
    { id: "gemini-3-flash-preview", options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "minimal" } } },
    {
      id: "gemini-3.1-flash-image-preview",
      options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "minimal" } },
    },
    { id: "gemini-3-pro-image-preview", options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
    { id: "gemini-2.5-pro", options: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } },
    { id: "gemini-2.5-flash", options: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } },
  ]) {
    test(`${item.id} returns supported small thinking options`, () => {
      expect(ProviderTransform.smallOptions(createModel(item.id))).toEqual(item.options)
    })
  }

  test("does not synthesize thinking options when variants are empty", () => {
    expect(ProviderTransform.smallOptions({ ...createModel("gemini-2.5-pro"), variants: {} })).toEqual({})
  })
})

describe("ProviderTransform.message - consecutive assistant message merging", () => {
  const alibabaModel = {
    id: "alibaba-cn/glm-5",
    providerID: "alibaba-cn",
    api: {
      id: "glm-5",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "GLM-5",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: { field: "reasoning_content" },
    },
    cost: { input: 0.86, output: 3.15, cache: { read: 0, write: 0 } },
    limit: { context: 202752, output: 16384 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-02-11",
  } as any

  test("merges consecutive assistant messages with text + tool_call", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "help me" }] },
      { role: "assistant", content: [{ type: "text", text: "Let me organize the tasks" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "todowrite", input: { todos: [] } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "todowrite",
            output: { type: "text", value: "3 todos" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Here's the plan" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, alibabaModel, {})

    expect(result).toHaveLength(4)
    expect(result[0].role).toBe("user")
    expect(result[1].role).toBe("assistant")
    expect(result[1].content).toEqual([
      { type: "text", text: "Let me organize the tasks" },
      { type: "tool-call", toolCallId: "call-1", toolName: "todowrite", input: { todos: [] } },
    ])
    expect(result[2].role).toBe("tool")
    expect(result[3].role).toBe("assistant")
    expect(result[3].content).toEqual([{ type: "text", text: "Here's the plan" }])
  })

  test("merges three consecutive assistant messages", () => {
    const msgs = [
      { role: "assistant", content: "step1" },
      { role: "assistant", content: [{ type: "text", text: "step2" }] },
      { role: "assistant", content: "step3" },
    ] as any[]

    const result = ProviderTransform.message(msgs, alibabaModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("assistant")
    expect(result[0].content).toEqual([
      { type: "text", text: "step1" },
      { type: "text", text: "step2" },
      { type: "text", text: "step3" },
    ])
  })

  test("interleaved reasoning extraction on merged messages", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking1" },
          { type: "text", text: "text_before" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking2" },
          { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, alibabaModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toEqual([
      { type: "text", text: "text_before" },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
    ])
    expect((result[0] as any).providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })

  test("interleaved reasoning re-injection for non-DashScope providers", () => {
    const otherModel = {
      ...alibabaModel,
      providerID: "aihubmix",
    } as any

    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking1" },
          { type: "text", text: "response_text" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, otherModel, {})

    expect(result[0].content).toEqual([{ type: "text", text: "response_text" }])
    expect((result[0] as any).providerOptions?.openaiCompatible?.reasoning_content).toBe("thinking1")
  })

  test("siliconflow-cn also discards interleaved reasoning_content", () => {
    const sfModel = {
      ...alibabaModel,
      providerID: "siliconflow-cn",
    } as any

    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking1" },
          { type: "text", text: "response_text" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, sfModel, {})

    expect(result[0].content).toEqual([{ type: "text", text: "response_text" }])
    expect((result[0] as any).providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })

  test("skips merge for Anthropic provider", () => {
    const anthropicModel = {
      ...alibabaModel,
      providerID: "anthropic",
      api: { id: "claude-3", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
      capabilities: { ...alibabaModel.capabilities, interleaved: false },
    }

    const msgs = [
      { role: "assistant", content: "text1" },
      { role: "assistant", content: [{ type: "text", text: "text2" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
  })

  test("skips merge for google-vertex-anthropic provider", () => {
    const vertexAnthropicModel = {
      ...alibabaModel,
      providerID: "google-vertex-anthropic",
      api: { id: "claude-3", url: "https://vertexai.googleapis.com", npm: "@ai-sdk/google-vertex/anthropic" },
      capabilities: { ...alibabaModel.capabilities, interleaved: false },
    }

    const msgs = [
      { role: "assistant", content: "text1" },
      { role: "assistant", content: [{ type: "text", text: "text2" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, vertexAnthropicModel, {})

    expect(result).toHaveLength(2)
  })

  test("handles empty string content in consecutive assistant messages", () => {
    const msgs = [
      { role: "assistant", content: "" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, alibabaModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].role).toBe("assistant")
    expect(result[0].content).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } }])
  })

  test("deep-merges providerOptions from consecutive assistant messages", () => {
    const openaiCompatModel = {
      ...alibabaModel,
      capabilities: { ...alibabaModel.capabilities, interleaved: false },
    }

    const msgs = [
      {
        role: "assistant",
        content: [{ type: "text", text: "text1" }],
        providerOptions: {
          openaiCompatible: { custom_field: "a" },
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "text2" }],
        providerOptions: {
          openaiCompatible: { another_field: "b" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiCompatModel, {})

    expect(result).toHaveLength(1)
    expect((result[0] as any).providerOptions?.openaiCompatible).toEqual({
      custom_field: "a",
      another_field: "b",
    })
  })

  test("does not affect non-consecutive messages", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, alibabaModel, {})

    expect(result).toHaveLength(3)
    expect(result[0].role).toBe("user")
    expect(result[1].role).toBe("assistant")
    expect(result[2].role).toBe("user")
  })
})
