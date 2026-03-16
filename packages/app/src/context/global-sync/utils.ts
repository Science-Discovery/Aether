import type { Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeDir(directory: string): string {
  if (!directory) return directory
  const normalized = directory.replace(/\\/g, "/")
  const cased = /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
  if (/^[a-z]:\/+$/i.test(cased)) return `${cased[0]}:/`
  if (/^\/+$/.test(cased)) return "/"
  return cased.replace(/\/+$/, "")
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
