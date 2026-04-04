import type { Agent, Project, ProjectRecent, ProviderListResponse } from "@opencode-ai/sdk/v2/client"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeDir(directory: string): string {
  if (!directory) return directory
  const normalized = directory.replace(/\\/g, "/")
  const cased = /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
  if (/^[a-z]:\/+$/i.test(cased)) return `${cased[0]}:/`
  if (/^\/+$/.test(cased)) return "/"
  return cased.replace(/\/+$/, "")
}

export function isRoot(directory: string) {
  const dir = normalizeDir(directory)
  if (!dir) return false
  if (dir === "/") return true
  return /^[a-z]:\/$/i.test(dir)
}

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

export function normalizeProviderList(input: ProviderListResponse): ProviderListResponse {
  return {
    ...input,
    all: input.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated")),
    })),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}

export function sanitizeRecent(item: ProjectRecent) {
  if (!item.icon?.url && !item.icon?.override) return item
  return {
    ...item,
    icon: {
      ...item.icon,
      url: undefined,
      override: undefined,
    },
  }
}
