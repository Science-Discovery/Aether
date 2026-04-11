import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

type Base = ReturnType<typeof createOpencodeClient>
type Req<T> = Promise<{ data?: T }>
type PrefGet = { sessionID: string }
type PrefSet = {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  approval?: string
  source?: string
}
type Pref = {
  get(input: PrefGet): Req<{
    sessionID: string
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    approval?: string
  } | null>
  set(input: PrefSet): Req<{
    sessionID: string
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    approval?: string
  } | null>
}
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
  session: Omit<Base["session"], "promptAsync" | "preference"> & {
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
    preference: Pref
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
  const session = client.session as { preference?: Pref }
  if (Reflect.has(session, "preference")) return client
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  session.preference = {
    async get(input: PrefGet) {
      const resp = await fetch(`${baseUrl}/session/${input.sessionID}/preference`, { headers })
      const data = await resp.json()
      return { data }
    },
    async set(input: PrefSet) {
      const { sessionID, ...body } = input
      const resp = await fetch(`${baseUrl}/session/${sessionID}/preference`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      return { data }
    },
  }
  return client
}
