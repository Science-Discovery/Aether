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

export type Overrides = Record<string, Patch>

const log = Log.create({ service: "models.dev.local" })

export const additions = {
  "tatu-maas": MaaS.provider,
} satisfies Record<string, ModelsDev.Provider>

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

export function apply(
  data: Record<string, ModelsDev.Provider>,
  opts?: {
    additions?: Record<string, ModelsDev.Provider>
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
