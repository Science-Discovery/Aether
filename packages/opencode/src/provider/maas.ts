import type { ModelsDev } from "./models"
import { cards } from "./maas-generated"

const url = "https://maas.tatucloud.com"
const cny = 7

type Card = (typeof cards)[number]
type Cfg = Card["configs"][number]
type Price = Cfg["prices"][number]
type Fee = Price & { currency: string }

function select(card: Card) {
  if (card.id === "deepseek-v4-pro") {
    return card.configs.filter(
      (cfg) =>
        cfg.api === "OPENAI" &&
        ops(cfg).includes("OPENAI_CHAT_COMPLETIONS") &&
        !ops(cfg).includes("OPENAI_RESPONSES"),
    )
  }

  const responses = card.configs.filter((cfg) => cfg.api === "OPENAI" && ops(cfg).includes("OPENAI_RESPONSES"))
  if (responses.length > 0) return responses

  const openai = card.configs.filter((cfg) => cfg.api === "OPENAI" && ops(cfg).includes("OPENAI_CHAT_COMPLETIONS"))
  if (openai.length > 0) return openai

  const anthropic = card.configs.filter((cfg) => cfg.api === "ANTHROPIC" && ops(cfg).includes("ANTHROPIC_MESSAGES"))
  if (anthropic.length > 0) return anthropic

  return card.configs.filter(
    (cfg) =>
      cfg.api === "GEMINI" &&
      (ops(cfg).includes("GEMINI_STREAM_GENERATE_CONTENT") || ops(cfg).includes("GEMINI_GENERATE_CONTENT")),
  )
}

function ops(cfg: Cfg): string[] {
  return cfg.ops as unknown as string[]
}

function cap(cfg: Cfg): string[] {
  return cfg.caps as unknown as string[]
}

function op(cfg: Cfg) {
  if (cfg.api === "OPENAI" && ops(cfg).includes("OPENAI_RESPONSES")) return "responses"
  if (cfg.api === "OPENAI") return "chat"
  if (cfg.api === "ANTHROPIC") return "messages"
  return "generate"
}

function api(cfg: Cfg) {
  if (cfg.api === "ANTHROPIC") return { npm: "@ai-sdk/anthropic", api: `${url}/v1` }
  if (cfg.api === "GEMINI") return { npm: "@ai-sdk/google", api: `${url}/v1beta` }
  if (ops(cfg).includes("OPENAI_RESPONSES")) return { npm: "@ai-sdk/openai", api: `${url}/v1` }
  return { npm: "@ai-sdk/openai-compatible", api: `${url}/v1` }
}

function max(prices: Fee[], key: "input" | "output" | "read" | "write", cny: number) {
  return Math.max(
    0,
    ...prices.map((price) => {
      const value = price[key]
      if (value === 0) return 0
      return price.currency === "CNY" ? value / cny : value
    }),
  )
}

function cost(configs: Cfg[], cny: number) {
  const base = configs.flatMap((cfg) =>
    cfg.prices.filter((price) => price.threshold === 0).map((price) => ({ ...price, currency: cfg.currency })),
  )
  const high = configs.flatMap((cfg) =>
    cfg.prices.filter((price) => price.threshold > 0).map((price) => ({ ...price, currency: cfg.currency })),
  )
  return {
    input: max(base, "input", cny) * 1_000_000,
    output: max(base, "output", cny) * 1_000_000,
    cache_read: max(base, "read", cny) * 1_000_000,
    cache_write: max(base, "write", cny) * 1_000_000,
    ...(high.length > 0
      ? {
          context_over_200k: {
            input: max(high, "input", cny) * 1_000_000,
            output: max(high, "output", cny) * 1_000_000,
            cache_read: max(high, "read", cny) * 1_000_000,
            cache_write: max(high, "write", cny) * 1_000_000,
          },
        }
      : {}),
  }
}

function reasoning(card: Card, caps: Set<string>) {
  const id = card.id.toLowerCase()
  if (caps.has("DEEP_RESEARCH")) return true
  return ["gpt-5", "claude", "deepseek", "kimi", "minimax", "glm", "mimo", "qwen3"].some((part) =>
    id.includes(part),
  )
}

export namespace MaaS {
  export const provider: ModelsDev.Provider = {
    id: "maas",
    name: "MaaS",
    env: ["MAAS_API_KEY"],
    api: `${url}/v1`,
    npm: "@ai-sdk/openai-compatible",
    models: Object.fromEntries(
      cards.flatMap((card) => {
        const configs = select(card)
        const cfg = configs[0]
        if (!cfg) return []

        const caps = new Set(configs.flatMap(cap))
        const model: ModelsDev.Model = {
          id: card.id,
          name: card.id,
          family: card.family,
          release_date: "",
          attachment: caps.has("IS_VISION"),
          reasoning: reasoning(card, caps),
          temperature: true,
          tool_call: caps.has("FUNCTION_CALL"),
          cost: cost(configs, cny),
          limit: {
            context: card.context,
            output: card.output || 32_000,
          },
          modalities: {
            input: caps.has("IS_VISION") ? ["text", "image"] : ["text"],
            output: ["text"],
          },
          options: {
            maas: {
              api: cfg.api,
              op: op(cfg),
            },
          },
          provider: api(cfg),
        }

        return [[card.id, model]]
      }),
    ),
  }
}
