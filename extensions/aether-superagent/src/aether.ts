export type Model = { providerID: string; modelID: string }
export type Message = {
  info: { id: string; role: string; parentID?: string; finish?: string; error?: unknown; structured?: unknown
    sessionID?: string; summary?: boolean; agent?: string; mode?: string; sourceParentID?: string }
  parts: { type: string; text?: string; synthetic?: boolean; auto?: boolean; overflow?: boolean; callID?: string; tool?: string }[]
}

const continuation = "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
const terminal = (entry: Message) => entry.info.role === "assistant" && entry.info.summary !== true &&
  (entry.info.finish === "stop" || entry.info.structured !== undefined || entry.info.error !== undefined)

function correlated(messages: Message[], session: string, root: string): Message | undefined {
  const start = messages.findIndex((entry) => entry.info.id === root && entry.info.role === "user")
  // Partial histories can only establish the original, explicit parent relation.
  if (start < 0) return messages.findLast((entry) => terminal(entry) && entry.info.parentID === root &&
    (!entry.info.sessionID || entry.info.sessionID === session))
  let parent = root
  let marker = ""
  let phase: "work" | "summary" | "continue" = "work"
  const strict = messages[start]!.info.sessionID === session
  if (messages[start]!.info.sessionID && !strict) return
  // Aether's history order is authoritative. Do not sort it or cross another
  // user turn. Only its known auto-compaction triple extends this request.
  for (const entry of messages.slice(start + 1)) {
    if ((strict && entry.info.sessionID !== session) || (entry.info.sessionID && entry.info.sessionID !== session)) return
    if (entry.info.role === "user") {
      const part = entry.parts.length === 1 ? entry.parts[0] : undefined
      if (strict && phase === "work" && part?.type === "compaction" && part.auto === true &&
        (part.overflow === undefined || part.overflow === false)) {
        marker = entry.info.id; phase = "summary"; continue
      }
      if (phase === "continue" && part?.type === "text" && part.synthetic === true && part.text === continuation) {
        parent = entry.info.id; phase = "work"; continue
      }
      return
    }
    if (entry.info.role !== "assistant") return
    if (phase === "summary") {
      if (entry.info.parentID !== marker || entry.info.summary !== true || entry.info.agent !== "compaction" ||
        entry.info.mode !== "compaction" || entry.info.finish !== "stop" || entry.info.error) return
      phase = "continue"; continue
    }
    if (phase !== "work" || entry.info.parentID !== parent || entry.info.summary === true) return
    if (terminal(entry)) return parent === root ? entry : {
      ...entry, info: { ...entry.info, sourceParentID: parent, parentID: root },
    }
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, text: string) {
    super(`Aether HTTP ${status}: ${text}`)
  }
}

export class Aether {
  constructor(readonly url: string, readonly authorization?: string, readonly timeout = 600_000) {}

  async request<T>(directory: string, path: string, body?: unknown, method?: "PATCH"): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ""), `${this.url.replace(/\/+$/, "")}/`)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(this.authorization ? { Authorization: this.authorization } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    })
    const text = await response.text()
    if (!response.ok) throw new HttpError(response.status, text.slice(0, 1000))
    return (text ? JSON.parse(text) : undefined) as T
  }

  async ensure(directory: string, session: string, title: string, router: boolean) {
    // Unknown directories are deliberately not booted by arbitrary session URLs.
    await this.request(directory, "/project/open", { directory })
    const permission = [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "StructuredOutput", pattern: "*", action: "allow" },
    ]
    try {
      const found = await this.request<{ id: string; engine?: unknown; directory: string; permission?: typeof permission }>(directory, `/session/${session}`)
      if (found.engine || found.directory !== directory) throw new Error("Session engine or directory does not match this coordinator.")
      if (router && (found.permission?.length !== 2 || permission.some((rule, i) =>
        Object.entries(rule).some(([key, value]) => found.permission?.[i]?.[key as keyof typeof rule] !== value))))
        throw new Error("Router permissions changed. Restore deny-all plus allow StructuredOutput before routing.")
      return
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error
    }
    await this.request(directory, "/session", {
      id: session, title,
      ...(router ? { permission } : {}),
    })
  }

  async prompt(directory: string, session: string, message: string, text: string, model?: Model, schema?: object,
    options?: { agent?: string; synthetic?: boolean; metadata?: Record<string, unknown> }) {
    const response = await this.request<Message>(directory, `/session/${session}/message`, {
      messageID: message, parts: [{ type: "text", text, ...(options?.synthetic ? { synthetic: true } : {}),
        ...(options?.metadata ? { metadata: options.metadata } : {}) }],
      ...(options?.agent ? { agent: options.agent } : {}),
      ...(model ? { model } : {}),
      ...(schema ? { format: { type: "json_schema", schema, retryCount: 2 } } : {}),
    })
    if (response.info.parentID === message && response.info.summary !== true) return response
    const result = await this.result(directory, session, message)
    if (!result) throw new Error("Cannot bind Aether continuation to the original request; inspect its history.")
    return result
  }

  async status(directory: string, session: string) {
    const statuses = await this.request<Record<string, { type: string }>>(directory, "/session/status")
    return statuses[session]?.type ?? "idle"
  }

  async result(directory: string, session: string, message: string) {
    const messages = await this.request<Message[]>(directory, `/session/${session}/message`)
    return correlated(messages, session, message)
  }

  message(directory: string, session: string, message: string) {
    return this.request<Message>(directory, `/session/${session}/message/${message}`)
  }

  abort(directory: string, session: string) {
    return this.request(directory, `/session/${session}/abort`, {})
  }
}

export function text(message: Message) {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
}
