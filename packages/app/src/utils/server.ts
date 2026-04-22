import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

type Base = ReturnType<typeof createOpencodeClient>
type Skill = {
  name: string
  description: string
  content: string
  enabled?: boolean
}
type Kb = {
  path?: string
  paths?: string[]
  apiKey?: string
  baseURL?: string
}
export type AppClient = Base & {
  config: Base["config"] & {
    skills: {
      list(): Promise<{ data?: Skill[] }>
      toggle(input: { name: string; enabled: boolean }): Promise<{ data?: { ok: boolean } }>
      addDefaults(input?: { directory?: string }): Promise<{ data?: { added: string[] } }>
    }
  }
  file: Base["file"] & {
    create(input: { path: string; type: "file" | "directory" }): Promise<{ data?: { ok: boolean } }>
    delete(input: { path: string }): Promise<{ data?: { ok: boolean } }>
    rename(input: { path: string; name: string }): Promise<{ data?: { ok: boolean; path: string } }>
    write(input: { path: string; content: string }): Promise<{ data?: { ok: boolean } }>
    summarize(input?: { directory?: string; maxDepth?: number; force?: boolean }): Promise<{ data?: { count: number } }>
    open(input: { path: string; app?: string }): Promise<{ data?: { ok: boolean } }>
    openInExplorer(input: { path: string }): Promise<{ data?: { ok: boolean } }>
    pickFolder(): Promise<{ data?: { path: string | null } }>
    addToGitignore(input: { path: string; type: "file" | "directory" }): Promise<{
      data?: {
        ok: boolean
        created: boolean
        alreadyExists: boolean
      }
    }>
  }
  session: Base["session"] & {
    promptAsync(input: {
      sessionID: string
      directory?: string
      workspace?: string
      messageID?: string
      model?: {
        providerID: string
        modelID: string
      }
      agent?: string
      noReply?: boolean
      tools?: {
        [key: string]: boolean
      }
      format?: unknown
      system?: string
      variant?: string
      knowledgeBase?: Kb
      parts: unknown[]
    }): Promise<{ data?: unknown }>
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}): AppClient {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    baseUrl: server.url,
    headers: {
      ...auth,
      ...(config.headers ?? {}),
    },
  }) as unknown as AppClient
}
