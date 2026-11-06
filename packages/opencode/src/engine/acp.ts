import fs from "node:fs/promises"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import launch from "cross-spawn"
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import { Question } from "@/question"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Shell } from "@/shell/shell"
import type { SessionID } from "@/session/schema"
import { Engine } from "./schema"
import { EngineEvents } from "./events"
import { resolve, get, type Definition } from "./discover"
import { env } from "./env"

type Connection = {
  connection: ClientSideConnection
  child: ReturnType<typeof launch>
  close: () => Promise<void>
}

type Handle = {
  events: ReturnType<typeof EngineEvents.create>
  session: SessionID
  directory: string
  signal: AbortSignal
  permission: Engine.Permission
  active: boolean
}

export namespace Acp {
  async function connect(def: Definition, file: string, args: string[], cwd: string, handle: () => Handle | undefined) {
    const child = launch(file, args, {
      cwd,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
      env: env(),
    })
    let ended = false
    let closing: Promise<void> | undefined
    const exited = Promise.withResolvers<void>()
    child.once("close", () => {
      ended = true
      exited.resolve()
    })
    child.stderr?.resume()
    child.once("error", () => {
      ended = true
      exited.resolve()
    })
    const output = Writable.toWeb(child.stdin!)
    const input = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>
    const client: Client = {
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const current = handle()
        if (!current) return { outcome: { outcome: "cancelled" } }
        const options = params.options ?? []
        if (current.permission === "auto" || current.permission === "full") {
          const allow =
            options.find((option) => option.kind === "allow_once") ??
            options.find((option) => option.kind === "allow_always")
          if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } }
          return { outcome: { outcome: "cancelled" } }
        }
        const answers = await Question.runPromise(
          (service) =>
            service.ask({
              sessionID: current.session,
              questions: [
                {
                  header: params.toolCall.title ?? "Agent permission",
                  question:
                    params.toolCall.title ??
                    "The agent requests permission to continue. Choose an option to answer.",
                  options: options.map((option) => ({ label: option.name, description: option.kind })),
                  custom: false,
                },
              ],
              tool: { messageID: current.events.info.id, callID: params.toolCall.toolCallId },
            }),
          { signal: current.signal },
        ).catch(() => [])
        const selected = options.find((option) => option.name === answers[0]?.[0])
        return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } }
      },
      async sessionUpdate(params: SessionNotification) {
        const current = handle()
        if (!current?.active) return
        const update = params.update as Record<string, unknown>
        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined
            if (content?.type === "text" && content.text) await current.events.text(content.text)
            return
          }
          case "agent_thought_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined
            if (content?.type === "text" && content.text) await current.events.reasoning(content.text)
            return
          }
          case "tool_call":
          case "tool_call_update":
            await current.events.tool(tool(update))
            return
          case "plan": {
            const entries = Array.isArray(update.entries)
              ? (update.entries as Array<Record<string, unknown>>).flatMap((entry) =>
                  typeof entry.content === "string"
                    ? [{ content: entry.content, status: text(entry.status), priority: text(entry.priority) }]
                    : [],
                )
              : []
            await current.events.plan(entries)
            return
          }
          default:
            return
        }
      },
      async readTextFile(params) {
        const current = handle()
        if (!current) throw new Error("The agent session is not active.")
        const target = safe(current.directory, params.path)
        const content = await fs.readFile(target, "utf8")
        if (!params.line && !params.limit) return { content }
        const lines = content.split("\n")
        const start = Math.max(0, (params.line ?? 1) - 1)
        const end = params.limit ? start + params.limit : undefined
        return { content: lines.slice(start, end).join("\n") }
      },
      async writeTextFile(params) {
        const current = handle()
        if (!current) throw new Error("The agent session is not active.")
        const target = safe(current.directory, params.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await Bun.write(target, params.content)
        return {}
      },
    }
    const connection = new ClientSideConnection((_agent) => client, ndJsonStream(output, input))
    const close = () =>
      (closing ??= (async () => {
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (!ended) {
          await Shell.killTree(child, { exited: () => ended }).catch(() => undefined)
          if (!ended) child.kill("SIGKILL")
        }
        await Promise.race([exited.promise, Bun.sleep(2_000)])
      })())
    return { connection, child, close } satisfies Connection
  }

  function text(value: unknown) {
    return typeof value === "string" ? value : ""
  }

  function safe(directory: string, target: string) {
    const root = path.resolve(directory)
    if (!path.isAbsolute(target)) throw new Error("The agent requested a relative file path.")
    const resolved = path.resolve(target)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("The agent requested a file outside the working directory.")
    }
    return resolved
  }

  function renderContent(value: unknown) {
    if (!Array.isArray(value)) return ""
    return value
      .flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const entry = item as Record<string, unknown>
        if (entry.type === "content") {
          const inner = entry.content as Record<string, unknown> | undefined
          return inner?.type === "text" && typeof inner.text === "string" ? [inner.text] : []
        }
        if (entry.type === "diff") {
          return [
            `File: ${text(entry.path)}\n\n--- old\n${text(entry.oldText)}\n\n+++ new\n${text(entry.newText)}`,
          ]
        }
        return []
      })
      .join("\n\n")
  }

  function reason(error: unknown) {
    if (error instanceof Error) return error.message
    if (error && typeof error === "object" && "message" in error) return String(error.message)
    return typeof error === "string" ? error : "The agent turn failed."
  }

  function output(value: unknown) {
    if (typeof value === "string") return value
    if (value === undefined || value === null) return ""
    return JSON.stringify(value, null, 2)
  }

  function available(value: unknown): Engine.Model[] | undefined {
    const data = value as Record<string, unknown>
    const state = data.models as Record<string, unknown> | undefined
    const list = state?.availableModels
    if (Array.isArray(list)) {
      const result = list.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const entry = item as Record<string, unknown>
        return typeof entry.modelId === "string" && typeof entry.name === "string"
          ? [{ id: entry.modelId, name: entry.name }]
          : []
      })
      if (result.length) return result
    }
    const configs = Array.isArray(data.configOptions) ? (data.configOptions as Array<Record<string, unknown>>) : []
    const option = configs.find((item) => item.category === "model" || item.id === "model")
    if (!option) return
    const options = option.options
    if (!Array.isArray(options)) return
    const result = options.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const entry = item as Record<string, unknown>
      if (Array.isArray(entry.options)) {
        return (entry.options as Array<Record<string, unknown>>).flatMap((child) =>
          typeof child.value === "string" && typeof child.name === "string"
            ? [{ id: child.value, name: child.name }]
            : [],
        )
      }
      return typeof entry.value === "string" && typeof entry.name === "string"
        ? [{ id: entry.value, name: entry.name }]
        : []
    })
    return result.length ? result : undefined
  }

  function parseConfig(value: unknown): Engine.Config[] | undefined {
    if (!Array.isArray(value)) return
    const result = value.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const entry = item as Record<string, unknown>
      if (typeof entry.id !== "string" || typeof entry.type !== "string") return []
      const raw = Array.isArray(entry.options) ? entry.options : []
      const options = raw.flatMap((option) => {
        if (!option || typeof option !== "object") return []
        const child = option as Record<string, unknown>
        const list = Array.isArray(child.options) ? child.options : [child]
        return (list as Array<Record<string, unknown>>).flatMap((item) =>
          typeof item.value === "string" && typeof item.name === "string"
            ? [
                {
                  value: item.value,
                  name: item.name,
                  description: typeof item.description === "string" ? item.description : undefined,
                },
              ]
            : [],
        )
      })
      if (!options.length) return []
      return [
        {
          id: entry.id,
          name: text(entry.name) || entry.id,
          category: typeof entry.category === "string" ? entry.category : undefined,
          type: entry.type,
          value: typeof entry.currentValue === "string" ? entry.currentValue : undefined,
          options,
        },
      ]
    })
    return result.length ? result : undefined
  }

  function preferAccount(configs: Engine.Config[]) {
    const model = configs.find((item) => item.category === "model" || item.id === "model")
    if (!model) return configs
    const account = model.options.find((item) => item.value.includes("deepseek-account"))
    if (!account || account.value === model.value) return configs
    return configs.map((item) => (item === model ? { ...item, value: account.value } : item))
  }

  function chosen(configs: Engine.Config[]) {
    return configs.find((item) => item.category === "model" || item.id === "model")?.value
  }

  async function apply(
    connection: ClientSideConnection,
    sessionId: string,
    patch: { model?: string; effort?: string; mode?: string },
    models: Engine.Model[] | undefined,
    initial: Engine.Config[],
  ) {
    let configs = initial
    if (patch.model) {
      const option = configs.find((item) => item.category === "model" || item.id === "model")
      if (option) {
        const response = await connection
          .setSessionConfigOption({ sessionId, configId: option.id, value: patch.model })
          .catch((error: unknown) => {
            throw new Error(`Could not select model ${patch.model}: ${reason(error)}`)
          })
        configs = parseConfig(response.configOptions) ?? configs
      } else if (models?.some((item) => item.id === patch.model))
        await connection.unstable_setSessionModel({ sessionId, modelId: patch.model }).catch((error: unknown) => {
          throw new Error(`Could not select model ${patch.model}: ${reason(error)}`)
        })
    }
    if (patch.effort) {
      const option = configs.find(
        (item) => item.category === "thought_level" || item.id === "reasoning_effort" || item.id === "effort",
      )
      if (option) {
        const values = option.options.map((item) => item.value)
        if (values.length && !values.includes(patch.effort))
          throw new Error(
            `Model ${patch.model ?? ""} does not support reasoning effort ${patch.effort}. Choose one of: ${values.join(", ")}.`.trim(),
          )
        const response = await connection
          .setSessionConfigOption({ sessionId, configId: option.id, value: patch.effort })
          .catch((error: unknown) => {
            throw new Error(`Could not set reasoning effort to ${patch.effort}: ${reason(error)}`)
          })
        configs = parseConfig(response.configOptions) ?? configs
      }
    }
    if (patch.mode) {
      const option = configs.find((item) => item.category === "mode" || item.id === "mode")
      if (option) {
        const selected = await connection.setSessionMode({ sessionId, modeId: patch.mode }).then(
          () => true,
          () => false,
        )
        if (!selected) {
          const response = await connection
            .setSessionConfigOption({ sessionId, configId: option.id, value: patch.mode })
            .catch((error: unknown) => {
              throw new Error(`Could not set mode to ${patch.mode}: ${reason(error)}`)
            })
          configs = parseConfig(response.configOptions) ?? configs
        }
      }
    }
    return configs
  }

  export async function inspect(id: Engine.ID, model?: string) {
    const def = get(id)!
    const file = await resolve(id)
    if (!file) return { error: "Executable not found" }
    let conn: Connection | undefined
    try {
      conn = await connect(def, file.path, file.args, process.cwd(), () => undefined)
      await conn.connection.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      })
      const created = await conn.connection.newSession({ cwd: process.cwd(), mcpServers: [] })
      let configs = parseConfig(created.configOptions)
      if (model) {
        const option = configs?.find((item) => item.category === "model" || item.id === "model")
        if (option)
          configs =
            parseConfig(
              (
                await conn.connection.setSessionConfigOption({
                  sessionId: created.sessionId,
                  configId: option.id,
                  value: model,
                })
              ).configOptions,
            ) ?? configs
      } else if (id === "dsh" && configs) configs = preferAccount(configs)
      return {
        models: available(created),
        config: configs,
      }
    } catch (error) {
      return { error: reason(error) }
    } finally {
      await conn?.close()
    }
  }

  function tool(update: Record<string, unknown>): EngineEvents.ToolUpdate {
    const status = text(update.status)
    return {
      id: text(update.toolCallId),
      title: text(update.title) || undefined,
      kind: text(update.kind) || undefined,
      input: update.rawInput,
      output: [renderContent(update.content), output(update.rawOutput)].filter(Boolean).join("\n\n"),
      error: text(update.error) || undefined,
      status:
        status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : status === "in_progress"
              ? "in_progress"
              : status === "pending"
                ? "pending"
                : undefined,
    }
  }

  export async function probe(id: Engine.ID): Promise<Engine.Status> {
    const def = get(id)!
    const file = await resolve(id)
    if (!file) return { id, name: def.name, installed: false, protocol: def.protocol, error: "Executable not found" }
    let handle: Handle | undefined
    let conn: Connection | undefined
    try {
      conn = await connect(def, file.path, file.args, process.cwd(), () => handle)
      const init = await Promise.race([
        conn.connection.initialize({
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
        }),
        Bun.sleep(id === "dsh" ? 30_000 : 6_000).then(() => {
          throw new Error("ACP initialization timed out")
        }),
      ])
      return {
        id,
        name: def.name,
        installed: true,
        path: id === "dsh" ? file.args[0] : file.path,
        version: init.agentInfo?.version,
        protocol: def.protocol,
      }
    } catch (error) {
      return {
        id,
        name: def.name,
        installed: true,
        path: id === "dsh" ? file.args[0] : file.path,
        protocol: def.protocol,
        error: error instanceof Error ? error.message : "ACP initialization failed",
      }
    } finally {
      await conn?.close()
    }
  }

  export async function run(input: {
    id: Engine.ID
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
    const def = get(input.id)!
    const file = await resolve(input.id)
    if (!file) throw new Error(`${def.name} executable was not found`)
    const events = EngineEvents.create(input.assistant)
    const state: { conn?: Connection; handle?: Handle } = {}
    let remote = input.remote
    const handle: Handle = {
      events,
      session: input.session,
      directory: input.directory,
      signal: input.signal,
      permission: input.permission,
      active: false,
    }
    state.handle = handle
    const abort = () => {
      if (remote) void state.conn?.connection.cancel({ sessionId: remote }).catch(() => undefined)
      events.settle({ status: "interrupted" })
    }
    input.signal.addEventListener("abort", abort, { once: true })
    try {
      const conn = await connect(def, file.path, file.args, input.directory, () => handle)
      state.conn = conn
      input.signal.throwIfAborted()
      await conn.connection.initialize({
        protocolVersion: 1,
        // Writes stay with the agent's own tool loop so Aether keeps one approval path.
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      })
      input.signal.throwIfAborted()
      let models: Engine.Model[] | undefined
      let configs: Engine.Config[] = []
      if (remote) {
        const loaded = await conn.connection
          .loadSession({ sessionId: remote, cwd: input.directory, mcpServers: [] })
          .then(
            (value) => value as Record<string, unknown>,
            () => undefined,
          )
        if (loaded) {
          models = available(loaded)
          configs = parseConfig(loaded.configOptions) ?? []
        } else {
          const resumed = await conn.connection
            .unstable_resumeSession({ sessionId: remote, cwd: input.directory, mcpServers: [] })
            .then(
              (value) => value as Record<string, unknown>,
              () => undefined,
            )
          if (resumed) {
            models = available(resumed)
            configs = parseConfig(resumed.configOptions) ?? []
          } else {
            remote = undefined
          }
        }
      }
      if (!remote) {
        const created = await conn.connection.newSession({ cwd: input.directory, mcpServers: [] })
        remote = created.sessionId
        models = available(created)
        configs = parseConfig(created.configOptions) ?? []
      }
      if (input.id === "dsh") configs = preferAccount(configs)
      await input.save(remote, { models, config: configs })
      input.signal.throwIfAborted()
      const model = input.model ?? (input.id === "dsh" ? chosen(configs) : undefined)
      if (model || input.effort || input.mode) {
        const updated = await apply(
          conn.connection,
          remote,
          { model, effort: input.effort, mode: input.mode },
          models,
          configs,
        )
        await input.save(remote, {
          config: updated,
          ...(model ? { model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
        })
      }
      handle.active = true
      const prompt = await blocks(input.parts, input.signal, input.system)
      if (!prompt.length) throw new Error("The message has no supported content to send to the agent.")
      const response = await conn.connection.prompt({
        sessionId: remote,
        prompt: prompt as unknown as Parameters<typeof conn.connection.prompt>[0]["prompt"],
      })
      if (response.usage) {
        input.assistant.tokens = {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
          reasoning: response.usage.thoughtTokens ?? 0,
          cache: { read: response.usage.cachedReadTokens ?? 0, write: response.usage.cachedWriteTokens ?? 0 },
        }
      }
      const outcome =
        response.stopReason === "cancelled" || input.signal.aborted
          ? ({ status: "interrupted" } as const)
          : response.stopReason === "refusal"
            ? ({ status: "failed", error: "The agent refused to continue." } as const)
            : ({ status: "completed" } as const)
      return await events.finish(outcome)
    } catch (error) {
      const message = reason(error)
      const friendly = /MISSING_CREDENTIAL|no api key/i.test(message)
        ? `${def.name} has no model credentials. Configure its API key, then retry.`
        : /authentication required|not logged in|please run \/login|sign in/i.test(message)
          ? `${def.name} is not signed in on this machine. Sign in with ${def.name}, then retry.`
          : message
      return await events.finish({
        status: input.signal.aborted ? "interrupted" : "failed",
        error: friendly,
      })
    } finally {
      input.signal.removeEventListener("abort", abort)
      await state.conn?.close()
    }
  }

  async function blocks(parts: MessageV2.Part[], signal: AbortSignal, system?: string) {
    const result: Array<Record<string, unknown>> = []
    if (system) result.push({ type: "text", text: `Additional context supplied for this turn:\n${system}` })
    for (const part of parts) {
      signal.throwIfAborted()
      if (part.type === "text") {
        if (!part.ignored && part.text) result.push({ type: "text", text: part.text })
        continue
      }
      if (part.type === "agent" || part.type === "subtask") {
        throw new Error("Aether agent mentions and subtasks are not supported by this backend.")
      }
      if (part.type !== "file") continue
      const name = part.filename ?? path.basename(part.url)
      if (part.url.startsWith("file:")) {
        const target = decodeURIComponent(part.url.slice("file:".length))
        if (part.mime.startsWith("image/")) {
          const bytes = await fs.readFile(target).catch(() => undefined)
          if (bytes) {
            result.push({ type: "image", mimeType: part.mime, data: bytes.toString("base64"), uri: part.url })
            continue
          }
        }
        result.push({ type: "resource_link", name, uri: part.url, mimeType: part.mime })
        continue
      }
      if (part.mime.startsWith("image/")) {
        const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(part.url)
        if (match) {
          result.push({
            type: "image",
            mimeType: match[1] || part.mime,
            data: match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3])).toString("base64"),
          })
          continue
        }
        if (/^https?:\/\//i.test(part.url)) {
          result.push({ type: "resource_link", name, uri: part.url, mimeType: part.mime })
          continue
        }
      }
      if (part.mime.startsWith("text/") || part.mime === "application/json" || part.mime === "application/xml") {
        const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(part.url)
        if (match) {
          const value = match[2] ? Buffer.from(match[3], "base64").toString("utf8") : decodeURIComponent(match[3])
          result.push({ type: "text", text: `Attached file ${JSON.stringify(name)}:\n${value}` })
          continue
        }
      }
      const uri = part.url.startsWith("/") ? `file://${part.url}` : part.url
      result.push({ type: "resource_link", name, uri, mimeType: part.mime })
    }
    return result
  }
}
