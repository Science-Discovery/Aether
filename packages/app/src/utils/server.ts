import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

type Base = ReturnType<typeof createOpencodeClient>
type Req<T> = Promise<{ data?: T }>
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
type MemoryScope = "current_project" | "global"
type MemorySettings = {
  cross_session_search_enabled: boolean
  cross_session_search_scope: MemoryScope
  memory_reflection_enabled: boolean
}
type MemoryStore = {
  store: "user" | "memory"
  file: string
  limit: number
  used: number
  usage: number
  entries: string[]
}
export type AppClient = Base & {
  memory: {
    get(): Req<{
      settings: MemorySettings
      user: MemoryStore
      memory: MemoryStore
    }>
  }
  config: Base["config"] & {
    skills: {
      list(): Req<Skill[]>
      toggle(input: { name: string; enabled: boolean }): Req<{ ok: boolean }>
      addDefaults(input?: { directory?: string }): Req<{ added: string[] }>
    }
  }
  file: Base["file"] & {
    create(input: { path: string; type: "file" | "directory" }): Req<{ ok: boolean }>
    delete(input: { path: string }): Req<{ ok: boolean }>
    rename(input: { path: string; name: string }): Req<{ ok: boolean; path: string }>
    write(input: { path: string; content: string }): Req<{ ok: boolean }>
    summarize(input?: { directory?: string; maxDepth?: number; force?: boolean }): Req<{ count: number }>
    open(input: { path: string; app?: string }): Req<{ ok: boolean }>
    openInExplorer(input: { path: string }): Req<{ ok: boolean }>
    pickFolder(): Req<{ path: string | null }>
    addToGitignore(input: { path: string; type: "file" | "directory" }): Req<{
      ok: boolean
      created: boolean
      alreadyExists: boolean
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
    }): Req<unknown>
    preference: {
      get(input: { sessionID: string }): Req<{
        sessionID: string
        agent?: string
        model?: { providerID: string; modelID: string }
        variant?: string
        autoAccept?: boolean
      } | null>
      update(input: {
        sessionID: string
        agent?: string
        model?: { providerID: string; modelID: string }
        variant?: string
        autoAccept?: boolean
      }): Req<{
        sessionID: string
        agent?: string
        model?: { providerID: string; modelID: string }
        variant?: string
        autoAccept?: boolean
      } | null>
    }
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
  }) as unknown as AppClient
}

export function addPreferenceMethods(client: AppClient, baseUrl: string, auth?: Record<string, string>): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  client.session.preference = {
    async get(input) {
      const resp = await fetch(`${baseUrl}/session/${input.sessionID}/preference`, { headers })
      const data = await resp.json()
      return { data }
    },
    async update(input) {
      const { sessionID, ...body } = input
      const resp = await fetch(`${baseUrl}/session/${sessionID}/preference`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      return { data }
    },
  }
  return client
}

export function addMemoryMethods(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  opts?: { directory?: string; experimental_workspaceID?: string },
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  if (opts?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(opts.directory)
    headers["x-opencode-directory"] = isNonASCII ? encodeURIComponent(opts.directory) : opts.directory
  }
  if (opts?.experimental_workspaceID) {
    headers["x-opencode-workspace"] = opts.experimental_workspaceID
  }
  client.memory = {
    async get() {
      const resp = await fetch(`${baseUrl}/memory`, { headers })
      const data = await resp.json()
      return { data }
    },
  }
  return client
}
