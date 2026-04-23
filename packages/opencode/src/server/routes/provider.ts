import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Auth, OAUTH_DUMMY_KEY } from "../../auth"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { ProviderID } from "../../provider/schema"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"

const log = Log.create({ service: "server" })

const EMBEDDING_WHITELIST = [
  { id: "text-embedding-3-small", dimensions: 1536, provider: "OpenAI" },
  { id: "text-embedding-3-large", dimensions: 3072, provider: "OpenAI" },
  { id: "text-embedding-v1", dimensions: 1536, provider: "OpenAI" },
  { id: "text-embedding-v4", dimensions: 1024, provider: "Qwen" },
  { id: "gemini-embedding-001", dimensions: 768, provider: "Google" },
  { id: "gemini-embedding-2-preview", dimensions: 768, provider: "Google" },
]

const WHITELIST_BY_VENDOR: Record<string, typeof EMBEDDING_WHITELIST> = {
  openai: [
    { id: "text-embedding-3-small", dimensions: 1536, provider: "OpenAI" },
    { id: "text-embedding-3-large", dimensions: 3072, provider: "OpenAI" },
    { id: "text-embedding-v1", dimensions: 1536, provider: "OpenAI" },
  ],
  qwen: [{ id: "text-embedding-v4", dimensions: 1024, provider: "Qwen" }],
  dashscope: [{ id: "text-embedding-v4", dimensions: 1024, provider: "Qwen" }],
  alibaba: [{ id: "text-embedding-v4", dimensions: 1024, provider: "Qwen" }],
  google: [
    { id: "gemini-embedding-001", dimensions: 768, provider: "Google" },
    { id: "gemini-embedding-2-preview", dimensions: 768, provider: "Google" },
  ],
}

const KNOWN_PROVIDERS = new Set([
  "302ai",
  "abacus",
  "aihubmix",
  "alibaba",
  "alibaba-cn",
  "alibaba-coding-plan",
  "alibaba-coding-plan-cn",
  "amazon-bedrock",
  "anthropic",
  "azure",
  "azure-cognitive-services",
  "bailing",
  "baseten",
  "berget",
  "cerebras",
  "chutes",
  "clarifai",
  "cloudferro-sherlock",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "cohere",
  "cortecs",
  "deepinfra",
  "deepseek",
  "digitalocean",
  "dinference",
  "drun",
  "evroc",
  "fastrouter",
  "fireworks-ai",
  "firmware",
  "friendli",
  "github-copilot",
  "github-models",
  "gitlab",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "groq",
  "helicone",
  "hpc-ai",
  "huggingface",
  "iflowcn",
  "inception",
  "inference",
  "io-net",
  "jiekou",
  "kilo",
  "kimi-for-coding",
  "kuae-cloud-coding-plan",
  "llama",
  "llmgateway",
  "lmstudio",
  "lucidquery",
  "meganova",
  "minimax",
  "minimax-cn",
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
  "mistral",
  "mixlayer",
  "moark",
  "modelscope",
  "moonshotai",
  "moonshotai-cn",
  "morph",
  "nano-gpt",
  "nebius",
  "nova",
  "novita-ai",
  "nvidia",
  "ollama-cloud",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "ovhcloud",
  "perplexity",
  "perplexity-agent",
  "poe",
  "privatemode-ai",
  "qihang-ai",
  "qiniu-ai",
  "requesty",
  "sap-ai-core",
  "scaleway",
  "siliconflow",
  "siliconflow-cn",
  "stackit",
  "stepfun",
  "submodel",
  "synthetic",
  "tencent-coding-plan",
  "tencent-tokenhub",
  "the-grid-ai",
  "togetherai",
  "upstage",
  "v0",
  "venice",
  "vercel",
  "vivgrid",
  "vultr",
  "wafer.ai",
  "wandb",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-plan",
  "zenmux",
  "zhipuai",
  "zhipuai-coding-plan",
])

const EmbeddingModel = z.object({
  id: z.string(),
  name: z.string(),
  dimensions: z.number().int().optional(),
  provider: z.string().optional(),
  source: z.enum(["runtime", "config", "remote", "whitelist"]),
})

function trim(url?: string) {
  return (url ?? "").trim().replace(/\/+$/, "")
}

function normalize(id: string, providerID: string) {
  const prefix = `${providerID}/`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

function embedding(...parts: Array<string | undefined>) {
  return /(embed|embedding|bge|e5|gte)/i.test(parts.filter(Boolean).join(" "))
}

function model(
  map: Map<string, z.infer<typeof EmbeddingModel>>,
  providerID: string,
  id?: string,
  name?: string,
  source?: z.infer<typeof EmbeddingModel>["source"],
) {
  if (!id || !source) return
  const key = normalize(id, providerID)
  if (!key || !embedding(key, name)) return
  map.set(key, { id: key, name: name || key, source })
}

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: ModelsDev.Provider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const allProviders = await ModelsDev.get()
        const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        const connected = await Provider.list()
        const providers = Object.assign(
          mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
          connected,
        )
        return c.json({
          all: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: await Provider.connected(),
        })
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .get(
      "/:providerID/connection",
      describeRoute({
        summary: "Get provider connection info",
        description: "Get resolved API key, base URL, and embedding models for a connected provider.",
        operationId: "provider.connection",
        responses: {
          200: {
            description: "Provider connection info",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providerID: z.string(),
                    name: z.string(),
                    embeddingProvider: z.union([z.literal("openai"), z.literal("custom")]),
                    apiKey: z.string(),
                    baseURL: z.string(),
                    embeddingModels: z.array(EmbeddingModel),
                  }),
                ),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      async (c) => {
        const { providerID } = c.req.valid("param")
        const config = await Config.get()
        const providers = await Provider.list()
        const info = providers[providerID]
        if (!info) return c.json({ message: "Provider not found" } as any, 404)

        const auth = await Auth.get(providerID)
        const cfg = config.provider?.[providerID]
        const cfgOpts = cfg?.options as Record<string, unknown> | undefined
        const cfgKey = typeof cfgOpts?.apiKey === "string" && cfgOpts.apiKey !== OAUTH_DUMMY_KEY ? cfgOpts.apiKey : ""
        const authKey =
          auth?.type === "api"
            ? auth.key
            : auth?.type === "oauth"
              ? auth.access
              : auth?.type === "wellknown"
                ? auth.token
                : ""
        const apiKey = authKey || cfgKey || (info.key && info.key !== OAUTH_DUMMY_KEY ? info.key : "")
        const baseURL =
          trim(typeof cfgOpts?.baseURL === "string" ? cfgOpts.baseURL : undefined) ||
          trim(typeof cfgOpts?.endpoint === "string" ? cfgOpts.endpoint : undefined) ||
          trim((info.options?.baseURL ?? info.options?.endpoint) as string | undefined) ||
          trim(Object.values(info.models)[0]?.api.url)

        const embeddingModels = new Map<string, z.infer<typeof EmbeddingModel>>()
        for (const item of Object.values(info.models)) {
          model(embeddingModels, providerID, item.api.id || item.id, item.name || item.family || item.id, "runtime")
        }
        for (const [id, item] of Object.entries(cfg?.models ?? {})) {
          model(embeddingModels, providerID, item.id ?? id, item.name ?? id, "config")
        }

        if (apiKey && baseURL) {
          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const resp = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: controller.signal,
            }).finally(() => clearTimeout(timeout))
            if (resp.ok) {
              const data = (await resp.json()) as { data?: { id?: string; name?: string; object?: string }[] }
              const list = data?.data ?? []
              for (const item of list) {
                model(embeddingModels, providerID, item.id, item.name ?? item.object ?? item.id, "remote")
              }
            }
          } catch {
            // silently return empty list on timeout / network error
          }
        }

        if (embeddingModels.size === 0) {
          const vendorList = WHITELIST_BY_VENDOR[providerID]
          const isKnown = KNOWN_PROVIDERS.has(providerID)
          const fallbackList = !isKnown ? EMBEDDING_WHITELIST : (vendorList ?? [])
          for (const wl of fallbackList) {
            embeddingModels.set(wl.id, {
              id: wl.id,
              name: wl.id,
              dimensions: wl.dimensions,
              provider: wl.provider,
              source: "whitelist",
            })
          }
        }

        return c.json({
          providerID,
          name: info.name,
          embeddingProvider: providerID === "openai" ? "openai" : "custom",
          apiKey,
          baseURL,
          embeddingModels: [...embeddingModels.values()],
        })
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          inputs: z.record(z.string(), z.string()).optional().meta({ description: "Prompt inputs" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, inputs } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
          inputs,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code } = c.req.valid("json")
        await ProviderAuth.callback({
          providerID,
          method,
          code,
        })
        return c.json(true)
      },
    ),
)
