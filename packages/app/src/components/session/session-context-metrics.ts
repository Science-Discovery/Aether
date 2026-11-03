import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number | undefined
  output: number | undefined
  reasoning: number | undefined
  cacheRead: number | undefined
  cacheWrite: number | undefined
  total: number | undefined
  usage: number | null
  native: boolean
  used?: number
}

type Metrics = {
  totalCost: number | null
  native: boolean
  providerLabel?: string
  modelLabel?: string
  updated?: number
  context: Context | undefined
}

const tokenTotal = (msg: AssistantMessage) => {
  if (msg.providerID === "codex-native")
    return msg.tokens.total ?? msg.tokens.input + msg.tokens.output + msg.tokens.cache.read + msg.tokens.cache.write
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const measured = (messages: Message[]) =>
  messages.findLast(
    (msg): msg is AssistantMessage =>
      msg.role === "assistant" &&
      (tokenTotal(msg) > 0 ||
        (msg.providerID === "codex-native" &&
          (msg.tokens.total !== undefined ||
            (msg.nativeUsage?.input !== undefined &&
              Number.isFinite(msg.nativeUsage.input) &&
              msg.nativeUsage.input >= 0)))),
  )

const build = (messages: Message[] = [], providers: Provider[] = [], native = false): Metrics => {
  const enabled = native || messages.some((msg) => msg.role === "assistant" && msg.providerID === "codex-native")
  const totalCost = enabled ? null : messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = measured(messages)
  const latest = enabled ? messages.findLast((msg) => msg.role === "assistant") : message
  const provider = enabled ? undefined : providers.find((item) => item.id === latest?.providerID)
  const model = latest ? provider?.models[latest.modelID] : undefined
  const metadata = {
    providerLabel: enabled ? "Codex" : (provider?.name ?? latest?.providerID),
    modelLabel:
      latest?.modelID && (!enabled || latest.modelID !== "unknown") ? (model?.name ?? latest.modelID) : undefined,
    updated: enabled
      ? messages.reduce(
          (time, msg) => Math.max(time, msg.time.created, msg.role === "assistant" ? (msg.time.completed ?? 0) : 0),
          0,
        ) || undefined
      : latest?.time.created,
  }
  if (!message) return { totalCost, native: enabled, ...metadata, context: undefined }

  const evidence = message.nativeUsage
  const capacity = enabled ? evidence?.contextWindow : model?.limit.context
  const limit = capacity !== undefined && Number.isFinite(capacity) && capacity > 0 ? capacity : undefined
  const total = tokenTotal(message)
  const known = !enabled || total > 0 || message.tokens.total !== undefined
  const input = enabled ? evidence?.input : total
  const used = input !== undefined && Number.isFinite(input) && input >= 0 ? input : undefined

  return {
    totalCost,
    native: enabled,
    ...metadata,
    context: {
      message,
      provider,
      model,
      providerLabel: enabled ? "Codex" : (provider?.name ?? message.providerID),
      modelLabel: model?.name ?? message.modelID,
      limit,
      input: known ? message.tokens.input : undefined,
      output: known ? message.tokens.output : undefined,
      reasoning: known ? message.tokens.reasoning : undefined,
      cacheRead: known ? message.tokens.cache.read : undefined,
      cacheWrite: known ? message.tokens.cache.write : undefined,
      total: known ? total : undefined,
      native: enabled,
      used,
      usage: limit && used !== undefined ? Math.round((used / limit) * 100) : null,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = [], native = false) {
  return build(messages, providers, native)
}
