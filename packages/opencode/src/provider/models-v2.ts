import z from "zod"

const Price = z.number().min(0)

const CachePrice = z
  .object({
    read: Price.optional(),
    write: z.union([Price, z.record(z.string(), Price)]).optional(),
    storage: Price.optional(),
  })
  .passthrough()

const Override = z
  .object({
    when: z.record(z.string(), z.unknown()),
    price: Price.optional(),
    cache: CachePrice.optional(),
    reasoning: Price.optional(),
  })
  .passthrough()

const InputCost = z
  .object({
    unit: z.string().optional(),
    price: Price,
    cache: CachePrice.optional(),
    overrides: z.array(Override).optional(),
  })
  .passthrough()

const OutputCost = z
  .object({
    unit: z.string().optional(),
    price: Price,
    reasoning: Price.optional(),
    overrides: z.array(Override).optional(),
  })
  .passthrough()

const MediaCost = z
  .object({
    input: z.object({ price: Price }).passthrough().optional(),
    output: z.object({ price: Price }).passthrough().optional(),
  })
  .passthrough()

const Cost = z
  .object({
    text: z
      .object({
        input: InputCost.optional(),
        output: OutputCost.optional(),
      })
      .passthrough()
      .optional(),
    audio: MediaCost.optional(),
    image: MediaCost.optional(),
    video: MediaCost.optional(),
    multipliers: z.array(z.unknown()).optional(),
  })
  .passthrough()

const ApiEntry = z
  .object({
    base_url: z.string(),
    sdk: z
      .object({
        aisdk: z.string().optional(),
        opencodeai: z.string().optional(),
      })
      .passthrough()
      .optional(),
    compatibility: z
      .object({
        reasoning_field: z.string().optional(),
        replay_reasoning: z.boolean().optional(),
        max_tokens_field: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const Reasoning = z
  .object({
    supported: z.boolean(),
    default: z.unknown().optional(),
    toggle: z.boolean().optional(),
    effort: z.array(z.string()).optional(),
    budget: z
      .object({
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const Capabilities = z
  .object({
    tools: z.object({ supported: z.boolean() }).passthrough(),
    reasoning: Reasoning,
    cache: z.unknown().optional(),
    structured_output: z.boolean().optional(),
    temperature: z.boolean().optional(),
    top_p: z.boolean().optional(),
    top_k: z.boolean().optional(),
    system_updates: z.boolean().optional(),
    effort_updates: z.boolean().optional(),
    stream_usage: z.boolean().optional(),
  })
  .passthrough()

const Modalities = z
  .object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  })
  .passthrough()

const Model = z
  .object({
    id: z.string(),
    canonical_id: z.string().optional(),
    type: z.string(),
    name: z.string(),
    description: z.string(),
    family: z.string().optional(),
    open_weights: z.boolean(),
    knowledge: z.string().optional(),
    release_date: z.string(),
    last_updated: z.string().optional(),
    deprecation_date: z.string().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    modalities: Modalities,
    capabilities: Capabilities,
    limit: z
      .object({
        context: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
      })
      .passthrough()
      .optional(),
    cost: Cost.optional(),
    api: z.record(z.string(), ApiEntry),
    experimental: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough()

const Provider = z
  .object({
    id: z.string(),
    name: z.string(),
    doc: z.string(),
    env: z.array(z.string()),
    models: z.record(z.string(), Model),
  })
  .passthrough()

export const Database = z.record(z.string(), Provider)
export type Database = z.infer<typeof Database>
export type Model = z.infer<typeof Model>

type Limit = {
  context: number
  input?: number
  output: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isV2(value: unknown): value is Database {
  if (!record(value)) return false
  return Object.values(value).some((provider) => {
    if (!record(provider) || !record(provider.models)) return false
    return Object.values(provider.models).some((model) => record(model) && record(model.capabilities))
  })
}

export function normalize(value: unknown): unknown {
  return chatOnly(isV2(value) ? toV1(value) : value)
}

function chatOnly(value: unknown): unknown {
  if (!record(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, provider]): [string, unknown][] => {
      // Keep malformed entries intact so the remote schema can reject them.
      if (!record(provider) || !record(provider.models)) return [[id, provider]]
      const models = Object.fromEntries(
        Object.entries(provider.models).filter(([, model]) => {
          if (!record(model)) return true
          return model.type === undefined || model.type === "chat"
        }),
      )
      if (Object.keys(models).length === 0) return []
      return [[id, { ...provider, models }]]
    }),
  )
}

export function toV1(input: Database): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).flatMap(([id, provider]): [string, Record<string, unknown>][] => {
      const models = Object.fromEntries(
        Object.entries(provider.models).flatMap(([mid, model]): [string, Record<string, unknown>][] => {
          if (model.type !== "chat") return []
          const api = Object.entries(model.api)[0]
          if (!api) return []
          const [protocol, entry] = api
          const npm = entry.sdk?.aisdk
          if (!npm) return []
          const limit = model.limit
          if (limit?.context === undefined || limit.output === undefined) return []
          return [
            [
              mid,
              toModel(model, protocol, entry, npm, {
                context: limit.context,
                input: limit.input,
                output: limit.output,
              }),
            ],
          ]
        }),
      )
      if (Object.keys(models).length === 0) return []
      const first = Object.values(models)[0] as { provider: { npm: string; api: string } }
      return [
        [
          id,
          {
            id: provider.id,
            name: provider.name,
            doc: provider.doc,
            env: provider.env,
            npm: first.provider.npm,
            api: first.provider.api,
            models,
          },
        ],
      ]
    }),
  )
}

function toModel(model: Model, protocol: string, entry: z.infer<typeof ApiEntry>, npm: string, limit: Limit) {
  return withoutUndefined({
    id: model.id,
    name: model.name,
    description: model.description,
    family: model.family,
    release_date: model.release_date,
    last_updated: model.last_updated ?? model.release_date,
    attachment: model.modalities.input.some((item) => item !== "text"),
    reasoning: model.capabilities.reasoning.supported,
    reasoning_options: options(model.capabilities.reasoning),
    temperature: model.capabilities.temperature ?? false,
    tool_call: model.capabilities.tools.supported,
    structured_output: model.capabilities.structured_output,
    knowledge: model.knowledge,
    open_weights: model.open_weights,
    status: model.status,
    interleaved: interleaved(entry.compatibility),
    modalities: {
      input: modalities(model.modalities.input),
      output: modalities(model.modalities.output),
    },
    limit,
    cost: cost(model.cost),
    provider: withoutUndefined({
      npm,
      api: entry.base_url,
      shape: shape(protocol, npm),
    }),
  })
}

function options(reasoning: Model["capabilities"]["reasoning"]) {
  if (!reasoning.supported) return undefined
  const effort = reasoning.effort?.filter((item) => item !== "default")
  return [
    ...(reasoning.toggle ? [{ type: "toggle" }] : []),
    ...(effort?.length ? [{ type: "effort", values: effort }] : []),
    ...(reasoning.budget ? [{ type: "budget_tokens", ...reasoning.budget }] : []),
  ]
}

function interleaved(value: z.infer<typeof ApiEntry>["compatibility"]) {
  const field = value?.reasoning_field
  if (field === "reasoning_content" || field === "reasoning_details") return { field }
  if (field !== undefined || value?.replay_reasoning) return true
  return undefined
}

function modalities(values: string[]) {
  return [
    ...new Set(
      values.flatMap((value) => {
        if (value === "application/pdf") return ["pdf"]
        if (["decision", "embedding", "reranking"].includes(value)) return ["text"]
        const base = value.split("/")[0]!
        if (["text", "image", "audio", "video"].includes(base)) return [base]
        return []
      }),
    ),
  ]
}

function shape(protocol: string, npm: string) {
  const openai = npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure"
  if (protocol === "responses" && !openai) return "responses"
  if (protocol === "chat-completions" && openai) return "completions"
  return undefined
}

function first(value: number | Record<string, number> | undefined) {
  return typeof value === "object" ? Object.values(value)[0] : value
}

function cost(value: z.infer<typeof Cost> | undefined) {
  const input = value?.text?.input
  const output = value?.text?.output
  if (!input || !output) return undefined
  if ((input.unit ?? "token") !== "token" || (output.unit ?? "token") !== "token") return undefined
  return withoutUndefined({
    input: input.price,
    output: output.price,
    reasoning: output.reasoning,
    cache_read: input.cache?.read,
    cache_write: first(input.cache?.write),
    input_audio: value.audio?.input?.price,
    output_audio: value.audio?.output?.price,
    context_over_200k: over200k(input, output),
  })
}

function over200k(input: z.infer<typeof InputCost>, output: z.infer<typeof OutputCost>) {
  const find = (overrides?: z.infer<typeof Override>[]) =>
    overrides?.find((override) => size(override.when) === 200_000)
  const i = find(input.overrides)
  if (!i) return undefined
  const o = find(output.overrides)
  return withoutUndefined({
    input: i.price ?? input.price,
    output: o?.price ?? output.price,
    cache_read: i.cache?.read,
    cache_write: first(i.cache?.write),
    reasoning: o?.reasoning,
  })
}

function size(when: Record<string, unknown>) {
  const context = when.context
  if (!record(context)) return undefined
  const value = context.gte ?? context.gt
  return typeof value === "number" ? value : undefined
}

function withoutUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
