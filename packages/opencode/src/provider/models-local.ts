import type { ModelsDev } from "./models"
import { MaaS } from "./maas"
import { Log } from "@/util/log"

type Note = {
  reason: string
  verified_at: string
}

type Model = {
  provider?: {
    npm?: string
    api?: string
  }
  meta?: Note
}

type Patch = {
  npm?: string
  api?: string
  models?: Record<string, Model>
  meta?: Note
}

type Insert = ModelsDev.Model & {
  meta?: Note
}

export type Overrides = Record<string, Patch>
export type Inserts = Record<string, Record<string, Insert>>

const log = Log.create({ service: "models.dev.local" })

export const additions = {
  "tatu-maas": MaaS.provider,
} satisfies Record<string, ModelsDev.Provider>

// Alibaba Bailian list price is CNY 8 / 2 (cache hit) / 28 per 1M tokens;
// converted to USD at 1 USD ≈ 7.2 CNY to match models.dev's USD convention.
const ALIBABA_COST = {
  input: 1.11,
  cache_read: 0.28,
  output: 3.89,
}

function glm(api: string, reason: string, cost: Insert["cost"] = ALIBABA_COST) {
  return {
    id: "glm-5.2",
    name: "GLM-5.2",
    family: "glm",
    attachment: false,
    reasoning: true,
    tool_call: true,
    interleaved: {
      field: "reasoning_content",
    },
    temperature: true,
    release_date: "",
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    provider: {
      npm: "@ai-sdk/openai-compatible",
      api,
    },
    limit: {
      context: 1_000_000,
      input: 868_928,
      output: 131_072,
    },
    options: {
      maxOutputTokens: 65_536,
    },
    cost,
    meta: {
      reason,
      verified_at: "2026-06-25",
    },
  } satisfies Insert
}

export const inserts = {
  alibaba: {
    "glm-5.2": glm(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "models.dev is missing Alibaba Bailian GLM-5.2 metadata; Alibaba documents OpenAI-compatible chat completions with 1M context",
    ),
  },
  "alibaba-cn": {
    "glm-5.2": glm(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "models.dev is missing Alibaba Bailian GLM-5.2 metadata; Alibaba documents OpenAI-compatible chat completions with 1M context",
    ),
    "qwen3.8-max": {
      id: "qwen3.8-max",
      name: "Qwen3.8 Max",
      family: "qwen",
      attachment: true,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      interleaved: {
        field: "reasoning_content",
      },
      temperature: true,
      release_date: "",
      modalities: {
        input: ["text", "image", "video"],
        output: ["text"],
      },
      provider: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      limit: {
        context: 1_000_000,
        input: 991_000,
        output: 131_072,
      },
      options: {},
      // Alibaba Bailian list price is CNY 12 / 1.2 (cache hit) / 36 per 1M tokens;
      // converted to USD at 1 USD ≈ 7.2 CNY to match models.dev's USD convention.
      cost: {
        input: 1.67,
        cache_read: 0.17,
        output: 5.0,
      },
      meta: {
        reason:
          "models.dev is missing Alibaba Bailian qwen3.8-max metadata; Alibaba documents OpenAI-compatible hybrid reasoning with 1M context and image/video input",
        verified_at: "2026-08-05",
      },
    },
    "deepseek-v4-flash-0731": {
      id: "deepseek-v4-flash-0731",
      name: "DeepSeek V4 Flash 0731",
      family: "deepseek",
      attachment: false,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      interleaved: {
        field: "reasoning_content",
      },
      temperature: true,
      release_date: "2026-07-31",
      modalities: {
        input: ["text"],
        output: ["text"],
      },
      provider: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      limit: {
        context: 1_000_000,
        output: 393_216,
      },
      options: {},
      // Alibaba Bailian list price is CNY 1 / 0.1 (cache hit) / 2 per 1M tokens;
      // converted to USD at 1 USD ≈ 7.2 CNY to match models.dev's USD convention.
      cost: {
        input: 0.14,
        cache_read: 0.01,
        output: 0.28,
      },
      meta: {
        reason:
          "models.dev is missing Alibaba Bailian deepseek-v4-flash-0731 metadata; Alibaba documents OpenAI-compatible hybrid reasoning with 1M context and shared 393,216 output budget",
        verified_at: "2026-08-05",
      },
    },
    "deepseek-v4-pro-0813": {
      id: "deepseek-v4-pro-0813",
      name: "DeepSeek V4 Pro 0813",
      family: "deepseek",
      attachment: false,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      interleaved: {
        field: "reasoning_content",
      },
      temperature: true,
      release_date: "2026-08-13",
      modalities: {
        input: ["text"],
        output: ["text"],
      },
      provider: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      limit: {
        context: 1_000_000,
        output: 393_216,
      },
      options: {},
      // Alibaba Bailian peak-hour list price is CNY 9 / 0.9 (cache hit) / 27 per 1M tokens;
      // converted to USD at 1 USD ≈ 7.2 CNY to match models.dev's USD convention.
      cost: {
        input: 1.25,
        cache_read: 0.125,
        output: 3.75,
      },
      meta: {
        reason:
          "models.dev is missing Alibaba Bailian deepseek-v4-pro-0813 metadata; Alibaba documents OpenAI-compatible hybrid reasoning with 1M context and shared 393,216 output budget",
        verified_at: "2026-08-17",
      },
    },
  },
  aihubmix: {
    "glm-5.2": glm(
      "https://aihubmix.com/v1",
      "models.dev is missing aihubmix GLM-5.2 metadata; aihubmix exposes it through OpenAI-compatible chat completions",
      // aihubmix list price: USD 1.13 input / 3.94 output per 1M tokens
      {
        input: 1.13,
        output: 3.94,
      },
    ),
  },
} satisfies Inserts

export const overrides = {
  opencode: {
    models: {
      "gpt-5.5": {
        provider: {
          npm: "@ai-sdk/openai",
          api: "https://opencode.ai/zen/v1",
        },
        meta: {
          reason: "Pin Responses API routing for opencode gpt-5.5 while stale models.dev caches age out",
          verified_at: "2026-06-06",
        },
      },
      "gpt-5.5-pro": {
        provider: {
          npm: "@ai-sdk/openai",
          api: "https://opencode.ai/zen/v1",
        },
        meta: {
          reason: "Pin Responses API routing for opencode gpt-5.5-pro while stale models.dev caches age out",
          verified_at: "2026-06-06",
        },
      },
    },
  },
  aihubmix: {
    models: {
      "gpt-5.5": {
        provider: {
          npm: "@ai-sdk/openai",
          api: "https://aihubmix.com/v1",
        },
        meta: {
          reason: "aihubmix gpt-5.5 rejects tools with reasoning_effort on chat completions and requires Responses API",
          verified_at: "2026-06-06",
        },
      },
    },
  },
} satisfies Overrides

function fail(msg: string) {
  throw new Error(`Invalid models.dev local overlay: ${msg}`)
}

function invalid(msg: string, strict: boolean) {
  if (strict) fail(msg)
  log.warn(msg)
}

function clean(model: Insert): ModelsDev.Model {
  const result = { ...model }
  delete result.meta
  return result
}

export function apply(
  data: Record<string, ModelsDev.Provider>,
  opts?: {
    additions?: Record<string, ModelsDev.Provider>
    inserts?: Inserts
    overrides?: Overrides
    strict?: boolean
  },
): Record<string, ModelsDev.Provider> {
  const strict = opts?.strict ?? false
  const result = { ...data }

  for (const [id, provider] of Object.entries(opts?.additions ?? additions)) {
    if (provider.id !== id) fail(`addition ${id} has mismatched id ${provider.id}`)
    if (result[id]) fail(`addition ${id} already exists`)
    result[id] = provider
  }

  for (const [id, map] of Object.entries<Record<string, Insert>>(opts?.inserts ?? inserts)) {
    const provider = result[id]
    if (!provider) {
      invalid(`insert provider ${id} does not exist`, strict)
      continue
    }

    const models = { ...provider.models }
    for (const [mid, model] of Object.entries<Insert>(map)) {
      if (model.id !== mid) fail(`insert model ${id}/${mid} has mismatched id ${model.id}`)
      if (models[mid]) {
        invalid(`insert model ${id}/${mid} already exists`, strict)
        continue
      }

      models[mid] = clean(model)
    }

    result[id] = {
      ...provider,
      models,
    }
  }

  for (const [id, patch] of Object.entries(opts?.overrides ?? overrides)) {
    const provider = result[id]
    if (!provider) {
      invalid(`override provider ${id} does not exist`, strict)
      continue
    }

    const map: Record<string, Model> = patch.models ?? {}
    const models = { ...provider.models }
    for (const [mid, model] of Object.entries(map)) {
      const current = models[mid]
      if (!current) {
        invalid(`override model ${id}/${mid} does not exist`, strict)
        continue
      }

      models[mid] = {
        ...current,
        provider: model.provider
          ? {
              ...(current.provider ?? {}),
              ...model.provider,
            }
          : current.provider,
      }
    }

    result[id] = {
      ...provider,
      ...(patch.api ? { api: patch.api } : {}),
      ...(patch.npm ? { npm: patch.npm } : {}),
      models,
    }
  }

  return result
}
