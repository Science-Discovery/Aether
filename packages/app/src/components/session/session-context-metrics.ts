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
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  usage: number | null
  native: boolean
  used?: number
}

type Metrics = {
  totalCost: number | null
  native: boolean
  context: Context | undefined
}

const tokenTotal = (msg: AssistantMessage) => {
  if (msg.providerID === "codex-native")
    return msg.tokens.total ?? msg.tokens.input + msg.tokens.output + msg.tokens.cache.read + msg.tokens.cache.write
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = [], native = false): Metrics => {
  const enabled = native || messages.some((msg) => msg.role === "assistant" && msg.providerID === "codex-native")
  const totalCost = enabled ? null : messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = lastAssistantWithTokens(messages)
  if (!message) return { totalCost, native: enabled, context: undefined }

  const provider = enabled ? undefined : providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const evidence = message.nativeUsage
  const capacity = enabled ? evidence?.contextWindow : model?.limit.context
  const limit = capacity !== undefined && Number.isFinite(capacity) && capacity > 0 ? capacity : undefined
  const total = tokenTotal(message)
  const input = enabled ? evidence?.input : total
  const used = input !== undefined && Number.isFinite(input) && input >= 0 ? input : undefined

  return {
    totalCost,
    native: enabled,
    context: {
      message,
      provider,
      model,
      providerLabel: enabled ? "Codex" : (provider?.name ?? message.providerID),
      modelLabel: model?.name ?? message.modelID,
      limit,
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cacheRead: message.tokens.cache.read,
      cacheWrite: message.tokens.cache.write,
      total,
      native: enabled,
      used,
      usage: limit && used !== undefined ? Math.round((used / limit) * 100) : null,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = [], native = false) {
  return build(messages, providers, native)
}
