import { StringDecoder } from "node:string_decoder"
import { createHash, randomUUID } from "node:crypto"
import launch from "cross-spawn"
import { Question } from "@/question"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Shell } from "@/shell/shell"
import { Engine } from "./schema"
import { EngineEvents } from "./events"
import { discover, get } from "./discover"
import { env } from "./env"

type Envelope = {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

type Handlers = {
  request: (method: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  notification: (method: string, params: unknown) => void | Promise<void>
}

type Connection = {
  request: <T = unknown>(method: string, params?: unknown, opts?: { timeout?: number }) => Promise<T>
  close: () => Promise<void>
  readonly closed: boolean
}

const preferences = { nativeSearchEnhancementsEnabled: false }
const modes = ["plan", "build", "edit", "guarded", "yolo", "auto"]

function reason(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String(error.message)
  return typeof error === "string" ? error : "ZCode request failed."
}

function connect(file: string, args: string[], cwd: string, handlers: Handlers, lifetime?: AbortSignal): Connection {
  const child = launch(file, args, {
    cwd,
    stdio: "pipe",
    windowsHide: true,
    detached: process.platform !== "win32",
    env: env(),
  })
  const decoder = new StringDecoder("utf8")
  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const incoming = new Set<string | number>()
  let buffer = ""
  let sequence = 0
  let failure: Error | undefined
  let ended = false
  let closing: Promise<void> | undefined
  const controller = new AbortController()
  const completion = Promise.withResolvers<void>()

  const send = (value: Envelope) => {
    if (failure) throw failure
    if (!child.stdin || child.stdin.destroyed) throw new Error("ZCode input is unavailable")
    child.stdin.write(JSON.stringify(value) + "\n")
  }

  const terminate = (error: Error) => {
    if (failure) return
    failure = error
    controller.abort(error)
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }

  const close = () =>
    (closing ??= (async () => {
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (!ended) {
        await Shell.killTree(child, { exited: () => ended }).catch(() => undefined)
        if (!ended) child.kill("SIGKILL")
      }
      await Promise.race([completion.promise, Bun.sleep(2_000)])
    })())

  const fail = (error: Error) => {
    terminate(error)
    void close().catch(() => undefined)
  }

  const respond = (id: string | number, result: unknown) => {
    if (failure) return
    try {
      send({ id, result: result ?? null })
    } catch {
      fail(new Error("ZCode input closed"))
    }
  }

  const respondError = (id: string | number, error: unknown) => {
    if (failure) return
    try {
      send({
        id,
        error: { code: error instanceof ProtocolError ? error.code : -32603, message: reason(error) },
      })
    } catch {
      fail(new Error("ZCode input closed"))
    }
  }

  const receive = (line: string) => {
    const message = JSON.parse(line) as Envelope
    if (!message || typeof message !== "object") throw new Error("ZCode sent an invalid protocol message")
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        if (incoming.has(message.id)) throw new Error("ZCode repeated an active request id")
        incoming.add(message.id)
        const id = message.id
        const params =
          message.params && typeof message.params === "object"
            ? (message.params as Record<string, unknown>)
            : {}
        void handlers
          .request(message.method, params, controller.signal)
          .then((value) => respond(id, value), (error) => respondError(id, error))
          .finally(() => incoming.delete(id))
        return
      }
      void Promise.resolve()
        .then(() => handlers.notification(message.method!, message.params))
        .catch(() => fail(new Error("Unable to process a ZCode notification")))
      return
    }
    if (message.id === undefined) return
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    if (message.error) item.reject(new ProtocolError(message.error.code ?? -32603, message.error.message ?? "ZCode request failed"))
    else item.resolve(message.result)
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    if (failure) return
    buffer += decoder.write(chunk)
    try {
      let end = buffer.indexOf("\n")
      while (end !== -1) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line) receive(line)
        end = buffer.indexOf("\n")
      }
    } catch (error) {
      fail(new Error(reason(error)))
    }
  })
  child.stderr?.resume()
  child.once("error", () => fail(new Error("Unable to start ZCode app-server")))
  child.once("close", (code) => {
    ended = true
    terminate(new Error(`ZCode app-server exited${code === null ? "" : ` (${code})`}`))
    completion.resolve()
  })

  return {
    get closed() {
      return Boolean(failure)
    },
    request<T = unknown>(method: string, params?: unknown, opts?: { timeout?: number }) {
      if (failure) return Promise.reject<T>(failure)
      if (pending.size >= 64) return Promise.reject<T>(new Error("Too many pending ZCode requests"))
      const id = `c-${++sequence}`
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`ZCode request timed out: ${method}`))
        }, opts?.timeout ?? 30_000)
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        })
        try {
          send({ id, method, ...(params === undefined ? {} : { params }) })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error instanceof Error ? error : new Error("Unable to send ZCode request"))
        }
      })
    },
    close,
  }
}

class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

function workspace(directory: string) {
  return {
    workspacePath: directory,
    workspaceKey: createHash("sha256").update(directory).digest("hex").slice(0, 32),
  }
}

function parseModel(value?: string) {
  if (!value) return
  try {
    const parsed = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.providerId === "string" &&
      typeof parsed.modelId === "string"
    )
      return { providerId: parsed.providerId, modelId: parsed.modelId }
  } catch {
    return
  }
}

function encodeModel(value: unknown) {
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.providerId !== "string" || typeof item.modelId !== "string") return
  return JSON.stringify({ providerId: item.providerId, modelId: item.modelId })
}

function config(value: unknown): Engine.Config[] {
  const snapshot = value as Record<string, unknown> | undefined
  const settings = snapshot?.settings as Record<string, unknown> | undefined
  const state = settings?.model as Record<string, unknown> | undefined
  const available = Array.isArray(state?.available) ? (state.available as Array<Record<string, unknown>>) : []
  const models = available.flatMap((item) => {
    const ref = item.ref as Record<string, unknown> | undefined
    const value = encodeModel(ref)
    if (!value) return []
    const name = typeof item.label === "string" ? item.label : value
    const provider = typeof item.providerLabel === "string" ? item.providerLabel : undefined
    return [{ value, name: provider ? `${provider} / ${name}` : name }]
  })
  const current = encodeModel(state?.current) ?? encodeModel(state?.lastUsed)
  if (current && !models.some((item) => item.value === current)) models.push({ value: current, name: current })

  const thought = settings?.thoughtLevel as Record<string, unknown> | undefined
  const levels = Array.isArray(thought?.available)
    ? (thought.available as unknown[]).flatMap((item) => (typeof item === "string" ? [item] : []))
    : []
  const level = typeof thought?.current === "string" ? thought.current : undefined
  if (level && !levels.includes(level)) levels.push(level)

  const mode = settings?.mode as Record<string, unknown> | undefined
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      value: current,
      options: models,
    },
    {
      id: "thoughtLevel",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      value: level,
      options: levels.map((item) => ({ value: item, name: item[0]!.toUpperCase() + item.slice(1) })),
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      value: typeof mode?.current === "string" ? mode.current : undefined,
      options: modes.map((item) => ({ value: item, name: item[0]!.toUpperCase() + item.slice(1) })),
    },
  ].filter((item) => item.options.length > 0 || item.value !== undefined)
}

function content(parts: MessageV2.Part[]) {
  const text = parts.flatMap((part) => {
    if (part.type === "text") return part.ignored || !part.text ? [] : [part.text]
    if (part.type === "file") return [`Attached file ${JSON.stringify(part.filename ?? part.url)}: ${part.url}`]
    if (part.type === "agent" || part.type === "subtask")
      throw new Error("Aether agent mentions and subtasks are not supported by this backend.")
    return []
  })
  const value = text.join("\n\n")
  if (!value.trim()) throw new Error("The message has no supported content to send to ZCode.")
  return value
}

function tool(value: Record<string, unknown>): EngineEvents.ToolUpdate {
  const state = (value.state ?? {}) as Record<string, unknown>
  const status = typeof state.status === "string" ? state.status : "running"
  return {
    id: String(value.callId ?? value.toolCallId ?? ""),
    title: typeof state.title === "string" ? state.title : typeof value.tool === "string" ? value.tool : "ZCode tool",
    kind: typeof value.tool === "string" ? value.tool : "tool",
    input: state.input,
    output: typeof state.output === "string" ? state.output : undefined,
    error: typeof state.error === "string" ? state.error : undefined,
    status:
      status === "completed"
        ? "completed"
        : status === "error" || status === "failed"
          ? "failed"
          : status === "pending"
            ? "pending"
            : "in_progress",
  }
}

function render(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

export namespace ZCode {
  export async function probe(): Promise<Engine.Status> {
    const def = get("zcode")!
    const file = await discover("zcode")
    if (!file) return { id: "zcode", name: def.name, installed: false, protocol: def.protocol, error: "Executable not found" }
    const child = launch(file, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    const output = await new Promise<string>((resolve) => {
      let value = ""
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve(value)
      }, 10_000)
      child.stdout?.on("data", (chunk: Buffer) => (value += chunk.toString()))
      child.once("error", () => {
        clearTimeout(timer)
        resolve("")
      })
      child.once("close", () => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    return {
      id: "zcode",
      name: def.name,
      installed: true,
      path: file,
      version: output.trim().split(/\s+/)[0] || undefined,
      protocol: def.protocol,
    }
  }

  export async function inspect() {
    const def = get("zcode")!
    const file = await discover("zcode")
    if (!file) return { error: "Executable not found" }
    let conn: Connection | undefined
    try {
      conn = connect(
        file,
        def.args,
        process.cwd(),
        {
          request: async (method, params) => {
            if (method === "session/requestRuntimePreferences") return preferences
            throw new ProtocolError(-32601, `Unsupported ZCode request ${method}`)
          },
          notification: () => undefined,
        },
      )
      const created = await conn.request<Record<string, unknown>>("session/create", {
        workspace: workspace(process.cwd()),
        persistence: "deferred",
      })
      const sessionId = (created.session as Record<string, unknown> | undefined)?.sessionId
      const configs = config(created)
      if (typeof sessionId === "string")
        await conn.request("session/close", { sessionId }, { timeout: 10_000 }).catch(() => undefined)
      const models = configs
        .find((item) => item.id === "model")
        ?.options.map((item) => ({ id: item.value, name: item.name }))
      return { models, config: configs }
    } catch (error) {
      return { error: reason(error) }
    } finally {
      await conn?.close()
    }
  }

  export async function run(input: {
    model?: string
    effort?: string
    mode?: string
    permission: Engine.Permission
    session: SessionID
    directory: string
    remote?: string
    parts: MessageV2.Part[]
    assistant: MessageV2.Assistant
    signal: AbortSignal
    system?: string
    save: (session: string, patch?: Partial<Engine.Info>) => Promise<void>
  }): Promise<MessageV2.WithParts> {
    const def = get("zcode")!
    const file = await discover("zcode")
    if (!file) throw new Error("ZCode executable was not found")
    const events = EngineEvents.create(input.assistant)
    const text = content(input.parts)
    let remote = input.remote
    let streamed = false
    let thought = false
    let conn: Connection | undefined
    const abort = () => {
      if (remote) void conn?.request("session/stop", { sessionId: remote }, { timeout: 2_000 }).catch(() => undefined)
      events.settle({ status: "interrupted" })
    }
    input.signal.addEventListener("abort", abort, { once: true })

    const notification = async (method: string, params: unknown) => {
      if (method !== "session/event") return
      const event = params as Record<string, unknown> | undefined
      if (!event || typeof event.type !== "string") return
      const payload = (event.payload ?? {}) as Record<string, unknown>
      switch (event.type) {
        case "model.streaming": {
          const kind = typeof payload.kind === "string" ? payload.kind : ""
          const delta = typeof payload.delta === "string" ? payload.delta : ""
          if (kind === "text_delta" && delta) {
            streamed = true
            await events.text(delta)
          }
          if (kind === "reasoning_delta" && delta) {
            thought = true
            await events.reasoning(delta)
          }
          if (kind === "tool_call")
            await events.tool({
              id: String(payload.toolCallId ?? ""),
              title: typeof payload.toolName === "string" ? payload.toolName : "ZCode tool",
              kind: "tool",
              status: "in_progress",
              input: payload.input,
            })
          return
        }
        case "part.started":
        case "part.upserted": {
          const part = payload.part as Record<string, unknown> | undefined
          if (!part) return
          if (part.type === "text" && !streamed && typeof part.text === "string" && part.text) {
            streamed = true
            await events.text(part.text)
            return
          }
          if (part.type === "reasoning" && !thought && typeof part.text === "string" && part.text) {
            thought = true
            await events.reasoning(part.text)
            return
          }
          if (part.type === "tool") await events.tool(tool(part))
          return
        }
        case "tool.updated":
          await events.tool({
            id: String(payload.toolCallId ?? ""),
            title: typeof payload.toolName === "string" ? payload.toolName : undefined,
            kind: "tool",
            input: payload.input,
            output: render(payload.output ?? payload.result),
            error: render(payload.error),
            status:
              payload.status === "completed"
                ? "completed"
                : payload.status === "failed"
                  ? "failed"
                  : payload.status === "pending"
                    ? "pending"
                    : "in_progress",
          })
          return
        case "turn.completed": {
          if (!streamed && typeof payload.response === "string" && payload.response) {
            streamed = true
            await events.text(payload.response)
          }
          events.settle({ status: "completed" })
          return
        }
        case "turn.failed": {
          const error = payload.error as Record<string, unknown> | undefined
          events.settle({
            status: "failed",
            error: typeof error?.message === "string" ? error.message : "ZCode turn failed.",
          })
          return
        }
        case "session.closed":
          events.settle({ status: "interrupted", error: "The ZCode session closed." })
          return
        default:
          return
      }
    }

    const request = async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
      if (method === "session/requestRuntimePreferences") return preferences
      if (method !== "interaction/requestPermission")
        throw new ProtocolError(-32601, `Unsupported ZCode request ${method}`)
      const options = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : []
      const allow = options.find((item) => {
        const response = item.response as Record<string, unknown> | undefined
        return response?.decision === "allow"
      })
      if (input.permission === "auto" || input.permission === "full") return allow?.response ?? { decision: "deny" }
      const answers = await Question.runPromise(
        (service) =>
          service.ask({
            sessionID: input.session,
            questions: [
              {
                header: typeof params.toolName === "string" ? params.toolName : "ZCode permission",
                question:
                  typeof params.reason === "string" && params.reason
                    ? params.reason
                    : "ZCode requests permission to continue.",
                options: options.map((item) => ({
                  label: typeof item.name === "string" ? item.name : "Option",
                  description: typeof item.description === "string" ? item.description : "",
                })),
                custom: false,
              },
            ],
            tool: {
              messageID: input.assistant.id,
              callID: typeof params.toolCallId === "string" ? params.toolCallId : randomUUID(),
            },
          }),
        { signal },
      ).catch(() => [])
      const selected = options.find((item) => item.name === answers[0]?.[0])
      return (selected?.response as Record<string, unknown> | undefined) ?? { decision: "deny" }
    }

    try {
      conn = connect(file, def.args, input.directory, { request, notification }, input.signal)
      input.signal.throwIfAborted()
      const params = {
        workspace: workspace(input.directory),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.effort ? { thoughtLevel: input.effort } : {}),
        ...(parseModel(input.model) ? { model: parseModel(input.model) } : {}),
      }
      let created: Record<string, unknown> | undefined
      if (remote)
        created = await conn.request<Record<string, unknown>>("session/resume", {
          sessionId: remote,
          workspace: workspace(input.directory),
        }).catch(() => undefined)
      if (!created) {
        created = await conn.request<Record<string, unknown>>("session/create", {
          ...params,
          persistence: "immediate",
        })
        const id = (created.session as Record<string, unknown> | undefined)?.sessionId
        if (typeof id !== "string") throw new Error("ZCode did not return a session identifier.")
        remote = id
      } else {
        const id = (created.session as Record<string, unknown> | undefined)?.sessionId
        if (typeof id === "string") remote = id
      }
      if (!remote) throw new Error("ZCode did not return a session identifier.")
      const configs = config(created)
      await input.save(remote, {
        config: configs,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      })
      if (input.model) {
        const model = parseModel(input.model)
        if (model) await conn.request("session/setModel", { sessionId: remote, model }).catch(() => undefined)
      }
      if (input.effort)
        await conn.request("session/setThoughtLevel", { sessionId: remote, thoughtLevel: input.effort }).catch(() => undefined)
      if (input.mode) await conn.request("session/setMode", { sessionId: remote, mode: input.mode }).catch(() => undefined)
      await conn.request("session/subscribe", {
        sessionId: remote,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      })
      input.signal.throwIfAborted()
      await conn.request("session/send", { sessionId: remote, content: text, inputId: randomUUID() })
      const outcome = await events.done
      return await events.finish(input.signal.aborted ? { status: "interrupted" } : outcome)
    } catch (error) {
      return await events.finish({
        status: input.signal.aborted ? "interrupted" : "failed",
        error: reason(error),
      })
    } finally {
      input.signal.removeEventListener("abort", abort)
      await conn?.close()
    }
  }
}
