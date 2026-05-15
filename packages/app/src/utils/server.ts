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
type CronMode = "direct" | "isolated_agent" | "session_agent" | "agent_message"
type CronScheduleType = "cron" | "interval" | "once"
type CronLastStatus = "success" | "failed" | "skipped" | "expired" | null
type CronRunStatus = "success" | "failed" | "skipped"
type CronTriggerReason = "scheduled" | "manual"
type MemoryType = "preference" | "fact" | "task"
type CronDefinition = {
  id: string
  name: string
  enabled: boolean
  mode: CronMode
  project_id?: string | null
  session_id?: string | null
  schedule_type: CronScheduleType
  schedule_value: string | number
  timezone?: string | null
  payload: Record<string, unknown>
  [key: string]: unknown
}
type CronState = {
  job_id: string
  enabled: boolean
  next_run_at: number | null
  last_run_at: number | null
  last_status: CronLastStatus
  running: boolean
  start_at: number | null
  updated_at: number
}
type CronRun = {
  run_id: string
  job_id: string
  started_at: number
  finished_at: number
  status: CronRunStatus
  output_summary: string | null
  mode: CronMode
  project_id: string | null
  session_id: string | null
  created_session_id: string | null
  payload_snapshot: Record<string, unknown>
  trigger_reason: CronTriggerReason
}
type CronJobView = {
  definition: CronDefinition
  state: CronState | null
}

type RequestHelperOptions = {
  throwOnError?: boolean
}

function errorMessage(input: unknown) {
  if (typeof input === "string" && input.trim()) return input
  if (input && typeof input === "object") {
    const source = input as Record<string, unknown>
    if (typeof source.message === "string" && source.message.trim()) return source.message
    if (typeof source.error === "string" && source.error.trim()) return source.error
    if (source.error && typeof source.error === "object") {
      const nested = source.error as Record<string, unknown>
      if (typeof nested.message === "string" && nested.message.trim()) return nested.message
    }
  }
  return
}

async function requestJSON<T>(url: string, init: RequestInit, options?: RequestHelperOptions): Req<T> {
  let resp: Response
  try {
    resp = await fetch(url, init)
  } catch (error) {
    if (options?.throwOnError) throw error
    return {}
  }

  const text = await resp.text()
  let payload: unknown
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  } else {
    payload = {}
  }

  if (!resp.ok) {
    if (options?.throwOnError) {
      throw new Error(errorMessage(payload) ?? `HTTP ${resp.status}`)
    }
    return {}
  }

  return { data: payload as T }
}
export type AppClient = Base & {
  project: Base["project"] & {
    delete(input: { projectID: string }): Req<{ status: string; projectID: string; sessionCount?: number }>
    sessionCount(input: { projectID: string }): Req<{ count: number }>
  }
  cron: {
    jobs: {
      list(): Req<CronJobView[]>
      assistant(input: { instruction: string; selectedID?: string; projectID?: string; sessionID?: string }): Req<{
        action: "create" | "update" | "reject"
        summary: string
        job: CronJobView | null
      }>
      get(input: { id: string }): Req<CronJobView>
      run(input: { id: string }): Req<CronRun>
      runs(input: { id: string; count?: number }): Req<CronRun[]>
      delete(input: { id: string }): Req<{ ok: true; job_id: string; definition: CronDefinition }>
    }
    runs: {
      get(input: { runID: string }): Req<CronRun | null>
    }
  }
  memory: {
    status(): Req<Record<string, unknown>>
    search(input: { query: string; types?: MemoryType[]; limit?: number; currentProjectID?: string }): Req<{
      results: Array<{
        id: string
        type: MemoryType
        scope: string
        memory: string
        confidence: number
        weight: number
        score: number
        markdown: string
        ranking_note: string
      }>
      ranking_note: string
    }>
    reflect(input?: { mode?: "quick" | "daily" | "manual"; reason?: string }): Req<Record<string, unknown>>
    dailyReflect: {
      sync(): Req<Record<string, unknown>>
    }
    initialize: {
      start(): Req<Record<string, unknown>>
      cancel(): Req<{ ok: boolean }>
    }
  }
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
    steer(input: { sessionID: string; text: string }): Req<unknown>
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

export function addProjectDeleteMethod(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  options?: RequestHelperOptions,
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  const methods = {
    async delete(input: { projectID: string }) {
      return requestJSON<{ status: string; projectID: string; sessionCount?: number }>(
        `${baseUrl}/project/${input.projectID}`,
        {
          method: "DELETE",
          headers,
        },
        options,
      )
    },
    async sessionCount(input: { projectID: string }) {
      return requestJSON<{ count: number }>(`${baseUrl}/project/${input.projectID}/session-count`, { headers }, options)
    },
  }
  safeAssign(client.project, "delete", methods.delete)
  safeAssign(client.project, "sessionCount", methods.sessionCount)
  return client
}

function deepMerge(target: object, source: object) {
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const srcVal = (source as Record<string, unknown>)[key]
    const proto = Object.getPrototypeOf(target)
    const descriptor =
      Object.getOwnPropertyDescriptor(target, key) ?? (proto ? Object.getOwnPropertyDescriptor(proto, key) : undefined)
    if (descriptor?.get && !descriptor.set) {
      const existing = (target as Record<string, unknown>)[key]
      if (existing && typeof existing === "object" && srcVal && typeof srcVal === "object") {
        deepMerge(existing as object, srcVal as object)
      }
      continue
    }
    ;(target as Record<string, unknown>)[key] = srcVal
  }
}

function safeAssign(target: object, key: string, value: unknown) {
  try {
    const existing = (target as Record<string, unknown>)[key]
    if (existing && typeof existing === "object" && value && typeof value === "object") {
      try {
        ;(target as Record<string, unknown>)[key] = value
        return
      } catch {
        deepMerge(existing as object, value as object)
        return
      }
    }
    ;(target as Record<string, unknown>)[key] = value
  } catch {
    const existing = (target as Record<string, unknown>)[key]
    if (existing && typeof existing === "object" && value && typeof value === "object")
      deepMerge(existing as object, value as object)
  }
}

export function addSteerMethods(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  options?: RequestHelperOptions,
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  const steerMethods = {
    async steer(input: { sessionID: string; text: string }) {
      return requestJSON(
        `${baseUrl}/session/${input.sessionID}/steer`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ text: input.text }),
        },
        options,
      )
    },
  }
  safeAssign(client.session, "steer", steerMethods.steer)

  return client
}

export function addCronMethods(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  options?: RequestHelperOptions,
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  const cronMethods = {
    jobs: {
      async list() {
        return requestJSON(`${baseUrl}/cron/jobs`, { headers }, options)
      },
      async assistant(input: { instruction: string; selectedID?: string; projectID?: string; sessionID?: string }) {
        return requestJSON<{
          action: "create" | "update" | "reject"
          summary: string
          job: CronJobView | null
        }>(
          `${baseUrl}/cron/assistant`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              instruction: input.instruction,
              ...(input.selectedID ? { selected_id: input.selectedID } : {}),
              ...(input.projectID ? { project_id: input.projectID } : {}),
              ...(input.sessionID ? { session_id: input.sessionID } : {}),
            }),
          },
          options,
        )
      },
      async get(input: { id: string }) {
        return requestJSON(`${baseUrl}/cron/jobs/${input.id}`, { headers }, options)
      },
      async run(input: { id: string }) {
        return requestJSON(
          `${baseUrl}/cron/jobs/${input.id}/run`,
          {
            method: "POST",
            headers,
          },
          options,
        )
      },
      async runs(input: { id: string; count?: number }) {
        const search = new URLSearchParams()
        if (input.count !== undefined) search.set("count", String(input.count))
        const suffix = search.toString() ? `?${search}` : ""
        return requestJSON(`${baseUrl}/cron/jobs/${input.id}/runs${suffix}`, { headers }, options)
      },
      async delete(input: { id: string }) {
        return requestJSON(
          `${baseUrl}/cron/jobs/${input.id}`,
          {
            method: "DELETE",
            headers,
          },
          options,
        )
      },
    },
    runs: {
      async get(input: { runID: string }) {
        return requestJSON(`${baseUrl}/cron/runs/${input.runID}`, { headers }, options)
      },
    },
  }
  safeAssign(client, "cron", cronMethods)
  return client
}

export function addMemoryMethods(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  options?: RequestHelperOptions,
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  const memoryMethods = {
    async status() {
      return requestJSON<Record<string, unknown>>(`${baseUrl}/memory/status`, { headers }, options)
    },
    async search(input: { query: string; types?: MemoryType[]; limit?: number; currentProjectID?: string }) {
      return requestJSON(
        `${baseUrl}/memory/search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        },
        options,
      )
    },
    async reflect(input?: { mode?: "quick" | "daily" | "manual"; reason?: string }) {
      return requestJSON<Record<string, unknown>>(
        `${baseUrl}/memory/reflect`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(input ?? {}),
        },
        options,
      )
    },
    dailyReflect: {
      async sync() {
        return requestJSON<Record<string, unknown>>(
          `${baseUrl}/memory/daily-reflect/sync`,
          {
            method: "POST",
            headers,
          },
          options,
        )
      },
    },
    initialize: {
      async start() {
        return requestJSON<Record<string, unknown>>(
          `${baseUrl}/memory/initialize/start`,
          {
            method: "POST",
            headers,
          },
          options,
        )
      },
      async cancel() {
        return requestJSON<{ ok: boolean }>(
          `${baseUrl}/memory/initialize/cancel`,
          {
            method: "POST",
            headers,
          },
          options,
        )
      },
    },
  }
  safeAssign(client, "memory", memoryMethods)
  return client
}
