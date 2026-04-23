import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import type { EmbeddingModel, KnowledgeConfig } from "@/context/knowledge"

type Provider = ProviderListResponse["all"][number]
type Model = {
  id: string
  name: string
  family?: string
}

export type ResolvedEmbeddingModel = {
  id: string
  name: string
  dimensions?: number
  provider?: string
  source: "runtime" | "config" | "remote" | "whitelist"
}

export type ProviderConnection = {
  providerID: string
  name: string
  embeddingProvider: "openai" | "custom"
  apiKey: string
  baseURL: string
  embeddingModels: ResolvedEmbeddingModel[]
}

function trim(url?: string) {
  return (url ?? "").trim().replace(/\/+$/, "")
}

export function toEmbeddingProvider(id: string): "openai" | "local" | "custom" {
  if (id === "local") return "local"
  if (id === "openai") return "openai"
  return "custom"
}

export function labelProvider(id: string, list: Provider[]) {
  if (id === "local") return "Local (offline)"
  return list.find((item) => item.id === id)?.name ?? id
}

export function isEmbeddingModel(model: Model) {
  const text = `${model.id} ${model.name} ${model.family ?? ""}`.toLowerCase()
  return text.includes("embed")
}

export function listEmbeddingModels(id: string, list: Provider[], local: EmbeddingModel[]) {
  if (id === "local") {
    return local.filter((item) => item.provider === "local").map((item) => item.id)
  }

  const provider = list.find((item) => item.id === id)
  if (!provider) return []

  return Array.from(
    new Set(
      Object.values(provider.models)
        .filter(isEmbeddingModel)
        .map((item) => item.id),
    ),
  )
}

export function labelEmbeddingModel(id: string, providerID: string, list: Provider[], local: EmbeddingModel[]) {
  if (providerID === "local") {
    return local.find((item) => item.provider === "local" && item.id === id)?.name ?? id
  }

  const provider = list.find((item) => item.id === providerID)
  return provider?.models[id]?.name ?? id
}

export function labelResolvedEmbeddingModel(
  id: string,
  resolved: ResolvedEmbeddingModel[],
  providerID: string,
  list: Provider[],
  local: EmbeddingModel[],
) {
  const match = resolved.find((item) => item.id === id)
  if (match?.provider) return `${match.provider}/${match.id}`
  return match?.name ?? labelEmbeddingModel(id, providerID, list, local)
}

export function hasEmbeddingModels(id: string, list: Provider[], local: EmbeddingModel[]) {
  return listEmbeddingModels(id, list, local).length > 0
}

export function inferKnowledgeProviderID(
  kb: Pick<KnowledgeConfig, "providerID" | "embeddingProvider" | "embeddingModel" | "baseURL">,
  list: Provider[],
  local: EmbeddingModel[],
) {
  const ids = new Set(["local", ...list.map((item) => item.id)])

  if (kb.providerID && ids.has(kb.providerID)) {
    return kb.providerID
  }

  if (kb.embeddingProvider === "local") {
    return "local"
  }

  if (kb.embeddingProvider === "openai" && ids.has("openai")) {
    return "openai"
  }

  const byURL = trim(kb.baseURL)
  if (byURL) {
    const match = list.filter((item) => trim(item.api) === byURL)
    if (match.length === 1) {
      return match[0]!.id
    }
  }

  const model = kb.embeddingModel.trim()
  if (model) {
    if (local.some((item) => item.provider === "local" && item.id === model)) {
      return "local"
    }

    const match = list.filter((item) => listEmbeddingModels(item.id, list, local).includes(model))
    if (match.length === 1) {
      return match[0]!.id
    }
  }

  if (kb.embeddingProvider === "custom") {
    const match = list.filter((item) => hasEmbeddingModels(item.id, list, local))
    if (match.length === 1) {
      return match[0]!.id
    }
  }

  return ""
}
