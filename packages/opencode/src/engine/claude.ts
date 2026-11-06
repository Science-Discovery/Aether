import { StringDecoder } from "node:string_decoder"
import launch from "cross-spawn"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Shell } from "@/shell/shell"
import { Engine } from "./schema"
import { EngineEvents } from "./events"
import { discover, get } from "./discover"
import { env } from "./env"

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }

type Event = Record<string, unknown>

function option(permission: Engine.Permission) {
  switch (permission) {
    case "full":
      return ["--permission-mode", "bypassPermissions"]
    case "auto":
      return ["--permission-mode", "auto"]
    default:
      // Headless mode has no interactive prompt; deny anything that would ask.
      return ["--permission-mode", "manual", "--permission-prompts", "none"]
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

function reason(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String(error.message)
  return typeof error === "string" ? error : "The agent turn failed."
}

function friendly(message: string) {
  return /not logged in|please run \/login|authentication/i.test(message)
    ? "Claude Code is not signed in on this machine. Run `claude` and complete `/login`, then retry."
    : message
}

function result(block: Event) {
  if (block.type !== "tool_result") return undefined
  const value = Array.isArray(block.content)
    ? block.content.flatMap((item) => (item && typeof item === "object" && text((item as Event).text) ? [text((item as Event).text)] : [])).join("\n")
    : text(block.content)
  return { value, failed: block.is_error === true }
}

export namespace Claude {
  export async function probe(): Promise<Engine.Status> {
    const def = get("claude")!
    const file = await discover("claude")
    if (!file) return { id: "claude", name: def.name, installed: false, protocol: def.protocol, error: "Executable not found" }
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
      id: "claude",
      name: def.name,
      installed: true,
      path: file,
      version: output.trim().split(/\s+/)[0] || undefined,
      protocol: def.protocol,
    }
  }

  export async function inspect() {
    return {
      models: [
        { id: "default", name: "Default" },
        { id: "fable", name: "Claude Fable" },
        { id: "opus", name: "Claude Opus" },
        { id: "sonnet", name: "Claude Sonnet" },
        { id: "haiku", name: "Claude Haiku" },
      ],
      config: [
        {
          id: "effort",
          name: "Reasoning Effort",
          category: "thought_level",
          type: "select",
          value: undefined,
          options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
            value,
            name: value[0].toUpperCase() + value.slice(1),
          })),
        },
      ],
    }
  }

  export async function run(input: {
    model?: string
    effort?: string
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
    const file = await discover("claude")
    if (!file) throw new Error("Claude Code executable was not found")
    const events = EngineEvents.create(input.assistant)
    const blocks = await content(input.parts, input.signal, input.system)
    if (!blocks.length) throw new Error("The message has no supported content to send to the agent.")
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      ...(input.remote ? ["--resume", input.remote] : []),
      ...(input.model && input.model !== "default" ? ["--model", input.model] : []),
      ...(input.effort ? ["--effort", input.effort] : []),
      ...option(input.permission),
    ]
    const child = launch(file, args, {
      cwd: input.directory,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
      env: env(),
    })
    const done = Promise.withResolvers<void>()
    let ended = false
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    let session = input.remote
    let completed = false
    let failure: string | undefined
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (!ended) {
          await Shell.killTree(child, { exited: () => ended }).catch(() => undefined)
          if (!ended) child.kill("SIGKILL")
        }
        await Promise.race([done.promise, Bun.sleep(2_000)])
      })())
    const abort = () => void close()
    input.signal.addEventListener("abort", abort, { once: true })

    const handle = async (event: Event) => {
      if (event.type === "system" && text(event.subtype) === "init") {
        const value = text(event.session_id)
        if (value) {
          session = value
          await input.save(value, {
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          })
        }
        return
      }
      if (event.type === "stream_event") {
        const delta = event.event as Event | undefined
        const kind = text(delta?.type)
        if (kind === "content_block_delta") {
          const inner = delta?.delta as Event | undefined
          if (text(inner?.type) === "text_delta") await events.text(text(inner?.text))
          if (text(inner?.type) === "thinking_delta") await events.reasoning(text(inner?.thinking))
        }
        return
      }
      if (event.type === "assistant") {
        const message = event.message as Event | undefined
        const items = Array.isArray(message?.content) ? (message.content as Event[]) : []
        for (const item of items) {
          if (item.type !== "tool_use") continue
          await events.tool({
            id: text(item.id),
            title: text(item.name) || "Claude tool",
            kind: "tool",
            status: "in_progress",
            input: item.input,
          })
        }
        return
      }
      if (event.type === "user") {
        const message = event.message as Event | undefined
        const items = Array.isArray(message?.content) ? (message.content as Event[]) : []
        for (const item of items) {
          const value = result(item)
          if (!value) continue
          await events.tool({
            id: text(item.tool_use_id),
            status: value.failed ? "failed" : "completed",
            output: value.value,
            error: value.failed ? value.value : undefined,
          })
        }
        return
      }
      if (event.type === "result") {
        completed = event.is_error !== true && text(event.subtype) !== "error"
        if (!completed) failure = friendly(text(event.result) || "Claude Code reported an error.")
        const value = text(event.session_id)
        if (value) {
          session = value
          await input.save(value, {
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          })
        }
        const usage = event.usage as Event | undefined
        if (usage) {
          input.assistant.tokens = {
            input: Number(usage.input_tokens ?? 0),
            output: Number(usage.output_tokens ?? 0),
            reasoning: Number(usage.reasoning_tokens ?? 0),
            cache: {
              read: Number(usage.cache_read_input_tokens ?? 0),
              write: Number(usage.cache_creation_input_tokens ?? 0),
            },
          }
        }
        if (event.total_cost_usd !== undefined) input.assistant.cost = Number(event.total_cost_usd)
        if (!events.settled) events.settle(completed ? { status: "completed" } : { status: "failed", error: failure })
        return
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      let end = buffer.indexOf("\n")
      while (end !== -1) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line) {
          try {
            const parsed = JSON.parse(line)
            if (parsed && typeof parsed === "object") void handle(parsed as Event)
          } catch {
            failure = "Claude Code sent an invalid protocol message."
          }
        }
        end = buffer.indexOf("\n")
      }
    })
    child.stderr?.resume()
    child.once("error", () => {
      ended = true
      failure ??= "Unable to start Claude Code."
      events.settle({ status: "failed", error: failure })
      done.resolve()
    })
    child.once("close", (code) => {
      ended = true
      if (!completed && !input.signal.aborted) {
        events.settle({ status: "failed", error: failure ?? `Claude Code exited${code === null ? "" : ` (${code})`}.` })
      }
      done.resolve()
    })

    try {
      child.stdin?.write(
        JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n",
      )
      child.stdin?.end()
      const outcome = await Promise.race([
        events.done,
        done.promise.then(() =>
          input.signal.aborted
            ? ({ status: "interrupted" } as const)
            : ({ status: "failed", error: failure ?? "Claude Code ended without a result." } as const),
        ),
      ])
      return await events.finish(input.signal.aborted ? { status: "interrupted" } : outcome)
    } catch (error) {
      return await events.finish({
        status: input.signal.aborted ? "interrupted" : "failed",
        error: friendly(reason(error)),
      })
    } finally {
      input.signal.removeEventListener("abort", abort)
      await close()
    }
  }

  async function content(parts: MessageV2.Part[], signal: AbortSignal, system?: string) {
    const result: Block[] = []
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
      const name = part.filename ?? part.url
      if (part.mime.startsWith("image/")) {
        const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(part.url)
        if (match) {
          result.push({
            type: "image",
            source: {
              type: "base64",
              media_type: match[1] || part.mime,
              data: match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3])).toString("base64"),
            },
          })
          continue
        }
      }
      if (part.url.startsWith("file:")) {
        result.push({ type: "text", text: `Attached file ${JSON.stringify(name)}: ${decodeURIComponent(part.url.slice(5))}` })
        continue
      }
      result.push({ type: "text", text: `Attached file ${JSON.stringify(name)}: ${part.url.slice(0, 200)}` })
    }
    return result
  }
}
