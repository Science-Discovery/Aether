import { describe, expect, test } from "bun:test"
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import {
  inferKnowledgeProviderID,
  isEmbeddingModel,
  listEmbeddingModels,
} from "./knowledge-embedding"

const local = [
  {
    id: "all-MiniLM-L6-v2",
    name: "all-MiniLM-L6-v2 (本地)",
    provider: "local" as const,
    dimensions: 384,
    description: "",
  },
]

const providers: ProviderListResponse["all"] = [
  {
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        release_date: "2025-08-07",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        limit: { context: 1, output: 1 },
        options: {},
      },
      "text-embedding-3-small": {
        id: "text-embedding-3-small",
        name: "text-embedding-3-small",
        family: "text-embedding",
        release_date: "2024-01-25",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: false,
        limit: { context: 1, output: 1 },
        options: {},
      },
    },
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    env: [],
    api: "https://api.siliconflow.cn/v1",
    models: {
      "Qwen/Qwen3-Embedding-4B": {
        id: "Qwen/Qwen3-Embedding-4B",
        name: "Qwen3 Embedding 4B",
        family: "qwen-embedding",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: false,
        limit: { context: 1, output: 1 },
        options: {},
      },
    },
  },
]

describe("knowledge embedding helpers", () => {
  test("filters embedding models from configured providers", () => {
    expect(isEmbeddingModel({ id: "text-embedding-3-small", name: "text-embedding-3-small" })).toBe(true)
    expect(isEmbeddingModel({ id: "gpt-5", name: "GPT-5" })).toBe(false)
    expect(listEmbeddingModels("openai", [...providers], local)).toEqual(["text-embedding-3-small"])
    expect(listEmbeddingModels("local", [...providers], local)).toEqual(["all-MiniLM-L6-v2"])
  })

  test("infers provider from stored provider id, base url, and unique model matches", () => {
    expect(
      inferKnowledgeProviderID(
        {
          providerID: "siliconflow",
          embeddingProvider: "custom",
          embeddingModel: "Qwen/Qwen3-Embedding-4B",
          baseURL: "https://api.siliconflow.cn/v1",
        },
        [...providers],
        local,
      ),
    ).toBe("siliconflow")

    expect(
      inferKnowledgeProviderID(
        {
          embeddingProvider: "custom",
          embeddingModel: "unknown",
          baseURL: "https://api.siliconflow.cn/v1/",
        },
        [...providers],
        local,
      ),
    ).toBe("siliconflow")

    expect(
      inferKnowledgeProviderID(
        {
          embeddingProvider: "custom",
          embeddingModel: "Qwen/Qwen3-Embedding-4B",
          baseURL: "",
        },
        [...providers],
        local,
      ),
    ).toBe("siliconflow")

    expect(
      inferKnowledgeProviderID(
        {
          embeddingProvider: "local",
          embeddingModel: "all-MiniLM-L6-v2",
          baseURL: "",
        },
        [...providers],
        local,
      ),
    ).toBe("local")
  })
})
