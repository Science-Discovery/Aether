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
type MemorySettings = {
  enabled: boolean
  memory_reflection_model?: {
    providerID: string
    modelID: string
  }
}
type MemoryStore = {
  store: "user" | "memory"
  file: string
  limit: number
  used: number
  usage: number
  entries: string[]
}
type ActiveMemory = {
  session_id: string
  prompt: string
  entries: Array<{
    source: "user" | "daily" | "session"
    store?: "user" | "memory"
    index: number
    text: string
  }>
}
type DailyMemory = {
  root: string
  days: Array<{
    date: string
    file: string
    entries: string[]
    invalid_entries: number
  }>
}
type CronMode = "direct" | "isolated_agent" | "session_agent" | "agent_message"
type CronScheduleType = "cron" | "interval" | "once"
type CronLastStatus = "success" | "failed" | "skipped" | "expired" | null
type CronRunStatus = "success" | "failed" | "skipped"
type CronTriggerReason = "scheduled" | "manual"
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
  memory: {
    get(input?: { sessionID?: string }): Req<{
      settings: MemorySettings
      user: MemoryStore
      memory: MemoryStore
      daily: DailyMemory
      active?: ActiveMemory
    }>
  }
  cron: {
    jobs: {
      list(): Req<CronJobView[]>
      get(input: { id: string }): Req<CronJobView>
      run(input: { id: string }): Req<CronRun>
      runs(input: { id: string; count?: number }): Req<CronRun[]>
      delete(input: { id: string }): Req<{ ok: true; job_id: string; definition: CronDefinition }>
    }
    runs: {
      get(input: { runID: string }): Req<CronRun | null>
    }
  }
  config: Base["config"] & {
    skills: {
      list(): Req<Skill[]>
      listManaged(): Req<Skill[]>
      listEvolution(input?: { directory?: string }): Req<Skill[]>
      getManagedDir(): Req<{ path: string }>
      toggle(input: { name: string; enabled: boolean }): Req<{ ok: boolean }>
      toggleEvolution(input: { file: string; evolutionEnabled: boolean }): Req<{ ok: boolean }>
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
    steer(input: { sessionID: string; text: string }): Req<unknown>
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
    headers: {
      ...(auth ?? {}),
      ...(config.headers ?? {}),
    },
  }) as unknown as AppClient
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

export function addPreferenceMethods(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  options?: RequestHelperOptions,
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  const preferenceMethods = {
    async get(input: { sessionID: string }) {
      return requestJSON(`${baseUrl}/session/${input.sessionID}/preference`, { headers }, options)
    },
    async update(input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      variant?: string
      autoAccept?: boolean
    }) {
      const { sessionID, ...body } = input
      return requestJSON(
        `${baseUrl}/session/${sessionID}/preference`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        },
        options,
      )
    },
  }
  safeAssign(client.session, "preference", preferenceMethods)

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

export function addMemoryMethods(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  opts?: { directory?: string; experimental_workspaceID?: string },
  options?: RequestHelperOptions,
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  if (opts?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(opts.directory)
    headers["x-opencode-directory"] = isNonASCII ? encodeURIComponent(opts.directory) : opts.directory
  }
  if (opts?.experimental_workspaceID) {
    headers["x-opencode-workspace"] = opts.experimental_workspaceID
  }
  const memoryMethods = {
    async get(input?: { sessionID?: string }) {
      const params = new URLSearchParams()
      if (input?.sessionID) params.set("session_id", input.sessionID)
      const suffix = params.size ? `?${params.toString()}` : ""
      return requestJSON(`${baseUrl}/memory${suffix}`, { headers }, options)
    },
  }
  safeAssign(client, "memory", memoryMethods)
  return client
}

export function addSkillsExtraMethods(
  client: AppClient,
  baseUrl: string,
  auth?: Record<string, string>,
  options?: RequestHelperOptions,
): AppClient {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth }
  const skills = client.config.skills as unknown as Record<string, unknown>
  skills.getManagedDir = async () => {
    return requestJSON(`${baseUrl}/config/skills/managed/dir`, { headers }, options)
  }
  skills.listEvolution = async (input?: { directory?: string }) => {
    const params = new URLSearchParams()
    if (input?.directory) params.set("directory", input.directory)
    const suffix = params.toString() ? `?${params}` : ""
    return requestJSON(`${baseUrl}/config/skills/evolution${suffix}`, { headers }, options)
  }
  skills.toggleEvolution = async (input: { file: string; evolutionEnabled: boolean }) => {
    return requestJSON(`${baseUrl}/config/skills/toggle-evolution`, { method: "POST", headers, body: JSON.stringify(input) }, options)
  }
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
