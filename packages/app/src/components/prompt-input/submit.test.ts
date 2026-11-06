import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { clearReferences, cloneReferences, type Reference } from "@/utils/ask-reference"
import type { FollowupDraft } from "./submit"
import type { ContextItem, Prompt, PromptScope } from "@/context/prompt"
import type { PromptHistoryEntry } from "./history"
import { readFileQuoteMetadata } from "@/utils/comment-note"
import { Worktree } from "@/utils/worktree"
import type { NativeEngine } from "@/utils/native"
import type { NativeDraft } from "@/context/native-run"
import type { E2EWindow } from "@/testing/terminal"
import type { PromptSendState } from "@/testing/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const engines: Array<NativeEngine | undefined> = []
const setModes: Array<{ sessionID: string; directory: string; mode: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []
const prompted: Array<Record<string, unknown>> = []
const commands: Array<{ name: string }> = []
const invoked: Array<Record<string, unknown>> = []
const toasts: Array<{ title?: string }> = []

let params: PromptScope = { dir: "/repo/main" }
let selected = "/repo/worktree-a"
let variant: string | undefined
let failCreate: Error | undefined
let directoryAutoAccept = false
let failPrompt: Error | undefined
let failShell: Error | undefined
let gate: Promise<void> | undefined
let claim: Promise<void> | undefined
let worktree: Promise<void> | undefined
const references = new Map<string, Reference[]>()
const contexts = new Map<string, Array<ContextItem & { key: string }>>()
const scope = (value: PromptScope = params) => JSON.stringify([connection.http.url, value.dir, value.id])
const target = (id?: string, dir = "/repo/main") => scope({ dir, id })
let defaultMode: "off" | "safe" | "full" = "safe"
let engine: NativeEngine | undefined
let ready = true
let resets = 0
let aborted = 0

const drafts = new Map<string, Prompt>()
const value = (input?: PromptScope) => {
  const key = scope(input)
  const found = drafts.get(key)
  if (found) return found
  const fresh: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
  drafts.set(key, fresh)
  return fresh
}
const navigations: Array<{ path: string; replace?: boolean }> = []
let connection = { http: { url: "http://localhost:4096", username: "old-user", password: "old-password" } }
let url = connection.http.url
let reading: Promise<void> | undefined
const fetcher = globalThis.fetch
const accesses: string[] = []

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async (input: { id?: string; engine?: NativeEngine }) => {
        createdSessions.push(directory)
        engines.push(input.engine)
        if (claim) await claim
        if (failCreate) throw failCreate
        return {
          data: {
            id: input?.id ?? `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
            engine: input.engine,
          },
        }
      },
      get: async () => {
        if (reading) await reading
        return { data: { readingMode: { pdfStorePath: "/papers/source.pdf" } } }
      },
      shell: async () => {
        sentShell.push(directory)
        if (gate) await gate
        if (failShell) throw failShell
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: Record<string, unknown>) => {
        prompted.push(input)
        if (gate) await gate
        if (failPrompt) throw failPrompt
        return { data: undefined }
      },
      command: async (input: Record<string, unknown>) => {
        invoked.push(input)
        return { data: undefined }
      },
      abort: async () => {
        aborted++
        return { data: undefined }
      },
    },
    worktree: {
      create: async () => {
        if (worktree) await worktree
        return { data: { directory: `${directory}/new` } }
      },
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (path: string, options?: { replace?: boolean }) => {
      navigations.push({ path, replace: options?.replace })
      const index = path.lastIndexOf("/session")
      params = { dir: path.slice(1, index), id: path.slice(index + "/session/".length) || undefined }
    },
    useParams: () => ({
      get dir() {
        return params.dir
      },
      get id() {
        return params.id
      },
    }),
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string }) => toasts.push(input),
  }))

  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      native: { engine: () => engine },
      selection: () =>
        ready
          ? {
              engine,
              agent: engine ? "codex" : "agent",
              model: engine
                ? { providerID: "codex-native", modelID: engine.model! }
                : { providerID: "provider", modelID: "model" },
              variant: engine?.effort ?? variant,
            }
          : undefined,
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      effectiveMode: (_sessionID: string | undefined, directory?: string) =>
        directoryAutoAccept && directory === "/repo/main" ? "full" : defaultMode,
      setMode(sessionID: string, directory: string, mode: string) {
        setModes.push({ sessionID, directory, mode })
      },
    }),
  }))

  mock.module("@/context/settings", () => ({
    useSettings: () => ({
      permissions: {
        defaultPermissionMode: () => defaultMode,
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
    usePrompt: () => ({
      current: (input?: PromptScope) => {
        accesses.push("current")
        return value(input)
      },
      reset: (input?: PromptScope) => {
        resets++
        accesses.push("reset")
        return drafts.set(scope(input), [{ type: "text", content: "", start: 0, end: 0 }])
      },
      set: (parts: Prompt, _cursor?: number, input?: PromptScope) => {
        accesses.push("set")
        return drafts.set(scope(input), structuredClone(parts))
      },
      references: {
        items: (value?: PromptScope) => {
          accesses.push("references.items")
          return cloneReferences(references.get(scope(value)) ?? [])
        },
        clear: (snapshot: Reference[], value?: PromptScope) => {
          accesses.push("references.clear")
          return references.set(scope(value), clearReferences(references.get(scope(value)) ?? [], snapshot))
        },
      },
      context: {
        add: () => undefined,
        remove: (key: string, input?: PromptScope) => {
          contexts.set(
            scope(input),
            (contexts.get(scope(input)) ?? []).filter((item) => item.key !== key),
          )
        },
        items: (input?: PromptScope) => {
          accesses.push("context.items")
          return contexts.get(scope(input)) ?? []
        },
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({}),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        directory: "/repo/main",
        client: rootClient,
        get url() {
          return url
        },
        createClient(opts: { directory: string }) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string }; variant?: string }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      todo: { set: () => undefined },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/knowledge", () => ({
    NEW_SESSION_KEY: "__new__",
    useKnowledge: () => ({
      enabled: () => false,
      activeKnowledgeBases: () => [],
      rekey: () => {},
      data: {
        selected: () => undefined,
      },
    }),
  }))

  mock.module("@/context/file", () => ({
    useFile: () => ({
      selectedText: () => undefined,
    }),
  }))

  mock.module("@/context/server", () => ({
    useServer: () => ({
      get current() {
        return connection
      },
      healthy: () => true,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  engines.length = 0
  setModes.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  prompted.length = 0
  commands.length = 0
  invoked.length = 0
  toasts.length = 0
  params = { dir: "/repo/main" }
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  failCreate = undefined
  failPrompt = undefined
  failShell = undefined
  gate = undefined
  claim = undefined
  worktree = undefined
  references.clear()
  contexts.clear()
  drafts.clear()
  connection = { http: { url: "http://localhost:4096", username: "old-user", password: "old-password" } }
  url = connection.http.url
  drafts.set(target(), [{ type: "text", content: "ls", start: 0, end: 2 }])
  drafts.set(target("session-1"), [{ type: "text", content: "ls", start: 0, end: 2 }])
  drafts.set(target("existing"), [{ type: "text", content: "ls", start: 0, end: 2 }])
  drafts.set(target("native-session"), [{ type: "text", content: "ls", start: 0, end: 2 }])
  navigations.length = 0
  accesses.length = 0
  reading = undefined
  directoryAutoAccept = false
  defaultMode = "safe"
  engine = undefined
  ready = true
  resets = 0
  aborted = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

afterEach(() => {
  globalThis.fetch = fetcher
  delete (window as E2EWindow).__opencode_e2e
})

function nativeSubmit(overrides: Partial<Parameters<typeof createPromptSubmit>[0]> = {}) {
  return createPromptSubmit({
    info: () =>
      params.id
        ? {
            id: params.id,
            slug: "",
            projectID: "project",
            directory: "/repo/main",
            title: "Native",
            version: "",
            time: { created: 0, updated: 0 },
            engine,
          }
        : undefined,
    imageAttachments: () => [],
    commentCount: () => 0,
    autoAccept: () => true,
    mode: () => "normal",
    working: () => false,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: () => 2,
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    ...overrides,
  })
}

describe("accepted submission notifications", () => {
  test.each(["shell", "command", "normal", "native", "active", "queue"])(
    "publishes exactly once for dispatched %s input while supplementary and queued drafts keep their own flow",
    async (kind) => {
      const probe = { enabled: true, sent: undefined as PromptSendState | undefined }
      ;(window as E2EWindow).__opencode_e2e = { prompt: probe }
      params.id = "existing"
      if (kind === "native" || kind === "active") engine = { type: "codex", model: "native-model" }
      if (kind === "command") {
        commands.push({ name: "custom" })
        value()[0] = { type: "text", content: "/custom example", start: 0, end: 15 }
      }
      const notice = mock(() => undefined)
      const submit = nativeSubmit({
        mode: () => (kind === "shell" ? "shell" : "normal"),
        working: () => kind === "active",
        shouldQueue: () => kind === "queue",
        onQueue: () => undefined,
        nativeSubmit: async () => true,
        onSubmit: notice,
      })
      await submit.handleSubmit({ preventDefault() {} } as Event)
      await flush()
      const count = kind === "active" || kind === "queue" ? 0 : 1
      expect(notice).toHaveBeenCalledTimes(count)
      expect(probe.sent?.count ?? 0).toBe(count)
      if (count) expect(probe.sent).toMatchObject({ sessionID: "existing", directory: "/repo/main" })
      expect(sentShell).toHaveLength(kind === "shell" ? 1 : 0)
      expect(invoked).toHaveLength(kind === "command" ? 1 : 0)
      expect(prompted).toHaveLength(kind === "normal" || kind === "native" ? 1 : 0)
    },
  )

  test.each(["shell", "command"])("waits for session creation before publishing %s dispatch", async (kind) => {
    const probe = { enabled: true, sent: undefined as PromptSendState | undefined }
    ;(window as E2EWindow).__opencode_e2e = { prompt: probe }
    const pending = Promise.withResolvers<void>()
    claim = pending.promise
    if (kind === "command") {
      commands.push({ name: "custom" })
      value()[0] = { type: "text", content: "/custom example", start: 0, end: 15 }
    }
    const notice = mock(() => undefined)
    const submit = nativeSubmit({ mode: () => (kind === "shell" ? "shell" : "normal"), onSubmit: notice })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    await flush()
    expect(notice).not.toHaveBeenCalled()
    expect(probe.sent?.count ?? 0).toBe(0)
    expect(sentShell).toHaveLength(0)
    expect(invoked).toHaveLength(0)
    pending.resolve()
    await sending
    expect(notice).toHaveBeenCalledTimes(1)
    expect(probe.sent?.count).toBe(1)
  })

  test.each(["shell", "command"])("does not publish %s dispatch when session creation fails", async (kind) => {
    const probe = { enabled: true, sent: undefined as PromptSendState | undefined }
    ;(window as E2EWindow).__opencode_e2e = { prompt: probe }
    failCreate = new Error("create failed")
    if (kind === "command") {
      commands.push({ name: "custom" })
      value()[0] = { type: "text", content: "/custom example", start: 0, end: 15 }
    }
    const notice = mock(() => undefined)
    await nativeSubmit({ mode: () => (kind === "shell" ? "shell" : "normal"), onSubmit: notice }).handleSubmit({
      preventDefault() {},
    } as Event)
    expect(notice).not.toHaveBeenCalled()
    expect(probe.sent?.count ?? 0).toBe(0)
    expect(sentShell).toHaveLength(0)
    expect(invoked).toHaveLength(0)
  })
})

describe("native prompt submission", () => {
  test("preserves the draft without sending, enqueuing or aborting while a native revert is unresolved", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => true,
      blocked: () => true,
      nativeSubmit: async (draft) => {
        sent.push(draft)
        return true
      },
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    expect(sent).toHaveLength(0)
    expect(prompted).toHaveLength(0)
    expect(aborted).toBe(0)
    expect(resets).toBe(0)
    expect(value()).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
  })
  test("submits text during native execution without stopping or starting a second prompt", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => true,
      nativeSubmit: async (text) => {
        sent.push(text)
        return true
      },
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    expect(sent).toMatchObject([{ text: "ls", parts: [{ type: "text", text: "ls" }] }])
    expect(aborted).toBe(0)
    expect(prompted).toHaveLength(0)
    expect(resets).toBe(1)
  })

  test("queues file attachments and references with the original message", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    value().push({ type: "file", path: "/paper.pdf", content: "@paper", start: 2, end: 8 })
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => true,
      nativeSubmit: async (draft) => {
        sent.push(draft)
        return true
      },
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    expect(sent).toHaveLength(1)
    expect(sent[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          url: "file:///paper.pdf",
          source: expect.objectContaining({ path: "/paper.pdf" }),
        }),
      ]),
    )
    expect(resets).toBe(1)
    expect(prompted).toHaveLength(0)
    expect(optimistic).toHaveLength(0)
  })

  test("queues a PDF screenshot and its research prompt while preserving the pending draft on failure", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    value().push({ type: "file", path: "notes.txt", content: "@notes", start: 2, end: 8 })
    references.set(scope(), [
      {
        id: "screenshot",
        version: 1,
        kind: "pdf",
        path: "/paper.pdf",
        filename: "paper.pdf",
        mode: "quick",
        startPage: 3,
        endPage: 3,
        selection: "region",
        content: "image",
        question: "Explain",
        image: "data:image/png;base64,aGVsbG8=",
        text: "",
        summary: "Screenshot",
        settings: { questionPrompt: "{selected_content}\n{user_question}" },
      },
    ])
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => true,
      nativeSubmit: async (draft) => {
        sent.push(draft)
        return false
      },
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ text: "ls@notes" })
    expect(sent[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file", mime: "image/png", filename: "reference-1-page-3.png" }),
        expect.objectContaining({ type: "file", url: "file:///repo/main/notes.txt" }),
        expect.objectContaining({
          type: "text",
          synthetic: true,
          text: expect.stringContaining("Source: paper.pdf, pages 3"),
        }),
      ]),
    )
    expect(resets).toBe(0)
    expect(references.get(scope())).toHaveLength(1)
    expect(prompted).toHaveLength(0)
  })

  test("preserves a normal quoted draft and handles a rejected send without an unhandled promise", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    failPrompt = new Error("send failed")
    const submit = nativeSubmit({
      fileQuoteQuestion: () => ({ sessionID: "existing", path: "paper.md", text: "quoted passage", summary: "quoted" }),
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    await flush()
    expect(value()).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
    expect(toasts.at(-1)?.title).toBe("prompt.toast.promptSendFailed.title")
  })

  test("resolves queued relative file references in the session directory", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    value().push({ type: "file", path: "paper.pdf", content: "@paper", start: 2, end: 8 })
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => true,
      info: () => ({
        id: "existing",
        slug: "",
        projectID: "project",
        directory: "/repo/worktree-b",
        title: "Native",
        version: "",
        time: { created: 0, updated: 0 },
        engine,
      }),
      nativeSubmit: async (draft) => {
        sent.push(draft)
        return true
      },
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    expect(sent[0].parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "file", url: "file:///repo/worktree-b/paper.pdf" })]),
    )
  })

  test("does not clear another session or send twice while the same queue submission is pending", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const receipt = Promise.withResolvers<boolean>()
    let count = 0
    const submit = nativeSubmit({
      working: () => true,
      nativeSubmit: () => {
        count++
        return receipt.promise
      },
    })
    const first = submit.handleSubmit({ preventDefault: () => undefined } as Event)
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    await flush()
    expect(count).toBe(1)
    params.id = "another"
    value().splice(0, value().length, { type: "text", content: "Another draft", start: 0, end: 13 })
    receipt.resolve(true)
    await first
    expect(value()[0]).toMatchObject({ content: "Another draft" })
    expect(value({ dir: "/repo/main", id: "existing" })[0]).toMatchObject({ content: "" })
    expect(prompted).toHaveLength(0)
  })

  test("preserves typing entered while an active-turn request is awaiting acknowledgement", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const pending = Promise.withResolvers<boolean>()
    const submit = nativeSubmit({ working: () => true, nativeSubmit: () => pending.promise })
    const sending = submit.handleSubmit({ preventDefault: () => undefined } as Event)
    value().splice(0, 1, { type: "text", content: "New instructions", start: 0, end: 16 })
    pending.resolve(true)
    await sending
    expect(resets).toBe(0)
    expect(value()[0]).toMatchObject({ content: "New instructions" })
  })

  test("keeps stop available while a supplementary message awaits acknowledgement", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const pending = Promise.withResolvers<boolean>()
    const submit = nativeSubmit({ working: () => true, nativeSubmit: () => pending.promise })
    const sending = submit.handleSubmit({ preventDefault: () => undefined } as Event)
    await submit.abort()
    expect(aborted).toBe(1)
    expect(resets).toBe(0)
    pending.resolve(false)
    await sending
    expect(resets).toBe(0)
  })

  test("keeps a rejected supplementary message and still stops the original Aether backend", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const submit = nativeSubmit({ working: () => true, nativeSubmit: async () => false })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    expect(resets).toBe(0)
    expect(aborted).toBe(0)
    engine = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    await flush()
    expect(aborted).toBe(1)
  })

  test("pins the engine at creation and sends native model settings without Aether auto approvals", async () => {
    engine = { type: "codex", model: "native-model", effort: "high" }
    const submit = nativeSubmit()
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    await flush()
    expect(engines).toEqual([engine])
    expect(prompted).toHaveLength(1)
    expect(prompted[0]).toMatchObject({
      agent: "codex",
      model: { providerID: "codex-native", modelID: "native-model" },
      variant: "high",
    })
    expect(setModes).toEqual([])
  })

  test("does not run legacy slash commands in native conversations", async () => {
    engine = { type: "codex", model: "native-model" }
    commands.push({ name: "legacy" })
    value().splice(0, value().length, { type: "text", content: "/legacy task", start: 0, end: 12 })
    await nativeSubmit().handleSubmit({ preventDefault: () => undefined } as Event)
    await flush()
    expect(invoked).toHaveLength(0)
    expect(prompted).toHaveLength(1)
    expect(prompted[0].parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "/legacy task" })]))
  })

  test("does not create a session when native discovery has not completed", async () => {
    engine = { type: "codex" }
    ready = false
    await nativeSubmit().handleSubmit({ preventDefault: () => undefined } as Event)
    expect(createdSessions).toEqual([])
    expect(prompted).toEqual([])
    expect(toasts).toHaveLength(1)
  })

  test("blocks a restored shell mode for native conversations", async () => {
    engine = { type: "codex", model: "native-model" }
    await nativeSubmit({ mode: () => "shell" }).handleSubmit({ preventDefault: () => undefined } as Event)
    expect(createdSessions).toEqual([])
    expect(sentShell).toEqual([])
  })

  test("captures the native engine and model in queued followups", async () => {
    params = { dir: "/repo/main", id: "native-session" }
    engine = { type: "codex", model: "native-model", effort: "high" }
    const queue: import("./submit").FollowupDraft[] = []
    const submit = nativeSubmit({
      info: () => ({
        id: "native-session",
        slug: "",
        projectID: "project",
        directory: "/repo/main",
        title: "Native",
        version: "",
        time: { created: 0, updated: 0 },
        engine,
      }),
      shouldQueue: () => true,
      onQueue: (draft) => queue.push(draft),
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    engine = undefined
    expect(queue).toHaveLength(1)
    expect(queue[0].engine).toEqual({ type: "codex", model: "native-model", effort: "high" })
    expect(queue[0].model).toEqual({ providerID: "codex-native", modelID: "native-model" })
    expect(prompted).toEqual([])
  })

  test.each([false, true])(
    "sends mixed references with only per-item questions in native execution: %s",
    async (active) => {
      engine = { type: "codex", model: "native-model" }
      params.id = "existing"
      value().splice(0, value().length, { type: "text", content: "", start: 0, end: 0 })
      references.set(scope(), [
        reference("conversation"),
        {
          id: "image",
          version: 1,
          kind: "pdf",
          path: "/paper.pdf",
          filename: "paper.pdf",
          mode: "quick",
          startPage: 3,
          endPage: 3,
          selection: "region",
          content: "image",
          question: "Describe this image",
          image: "data:image/png;base64,aGVsbG8=",
          text: "",
          summary: "Screenshot",
          settings: { questionPrompt: "{selected_content}\n{user_question}" },
        },
      ])
      const sent: NativeDraft[] = []
      const submit = nativeSubmit({
        working: () => active,
        nativeSubmit: async (draft) => {
          sent.push(draft)
          return true
        },
      })
      await submit.handleSubmit({ preventDefault() {} } as Event)
      const parts = (active ? sent[0]?.parts : prompted[0]?.parts) as Array<{
        type: string
        text?: string
        filename?: string
      }>
      expect(parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("[Question 1]\nWhy?") }),
          expect.objectContaining({ type: "text", text: expect.stringContaining("[Question 2]\nDescribe this image") }),
          expect.objectContaining({ type: "file", filename: "reference-2-page-3.png" }),
        ]),
      )
      expect(references.get(scope())).toEqual([])
      expect(aborted).toBe(0)
      expect(prompted).toHaveLength(active ? 0 : 1)
      expect(sent).toHaveLength(active ? 1 : 0)
    },
  )

  test("keeps native reference edits and additions while the queued snapshot awaits acknowledgement", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    references.set(scope(), [reference("a", "Original question")])
    const receipt = Promise.withResolvers<boolean>()
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => true,
      nativeSubmit: (draft) => {
        sent.push(draft)
        return receipt.promise
      },
    })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    await flush()
    expect(sent).toHaveLength(1)
    references.set(scope(), [{ ...reference("a", "Edited question"), version: 2 }, reference("b")])
    value().splice(0, value().length, { type: "text", content: "New draft", start: 0, end: 9 })
    receipt.resolve(true)
    await sending
    expect(references.get(scope())?.map((ref) => ref.question)).toEqual(["Edited question", "Why?"])
    expect(value()[0]).toMatchObject({ content: "New draft" })
    expect(sent[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Original question") }),
      ]),
    )
  })

  test("records the submitted native history snapshot while references change during acknowledgement", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    references.set(scope(), [reference("a", "Original question")])
    const receipt = Promise.withResolvers<boolean>()
    const entries: PromptHistoryEntry[] = []
    let reads = 0
    const submit = nativeSubmit({
      working: () => true,
      nativeSubmit: () => receipt.promise,
      history: () => {
        reads++
        return { references: cloneReferences(references.get(scope()) ?? []), comments: [], scope: { ...params } }
      },
      addToHistory: (prompt, _mode, history) => {
        if (history) entries.push({ prompt, ...history })
      },
    })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    await flush()
    references.set(scope(), [{ ...reference("a", "Edited question"), version: 2 }, reference("b")])
    value().splice(0, value().length, { type: "text", content: "New draft", start: 0, end: 9 })
    expect(entries).toEqual([])
    receipt.resolve(true)
    await sending
    expect(reads).toBe(1)
    expect(entries).toEqual([
      {
        prompt: [{ type: "text", content: "ls", start: 0, end: 2 }],
        references: [reference("a", "Original question")],
        comments: [],
        scope: { dir: "/repo/main", id: "existing" },
      },
    ])
    expect(references.get(scope())?.map((ref) => ref.question)).toEqual(["Edited question", "Why?"])
    expect(value()[0]).toMatchObject({ content: "New draft" })
  })

  test.each([false, true])("sends file-only and context-only native drafts while active: %s", async (active) => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => active,
      nativeSubmit: async (draft) => {
        sent.push(draft)
        return true
      },
    })
    for (const kind of ["file", "context"]) {
      value().splice(0, value().length, { type: "text", content: "", start: 0, end: 0 })
      if (kind === "file") value().push({ type: "file", path: "notes.txt", content: "", start: 0, end: 0 })
      if (kind === "context") contexts.set(scope(), [{ type: "file", path: "notes.txt", key: "context" }])
      await submit.handleSubmit({ preventDefault() {} } as Event)
      const parts = (active ? sent.at(-1)?.parts : prompted.at(-1)?.parts) as Array<{ type: string; url?: string }>
      expect(parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "file", url: "file:///repo/main/notes.txt" })]),
      )
      expect(contexts.get(scope()) ?? []).toEqual([])
      expect(value()[0]).toMatchObject({ content: "" })
    }
    expect(prompted).toHaveLength(active ? 0 : 2)
    expect(sent).toHaveLength(active ? 2 : 0)
    expect(aborted).toBe(0)
  })
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()
    selected = "/repo/worktree-b"
    params = { dir: "/repo/main" }
    value()[0] = { type: "text", content: "ls", start: 0, end: 2 }
    await submit.handleSubmit(event)
    await flush()

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual([
      "/repo/worktree-a",
      "/repo/worktree-a",
      "/repo/worktree-a",
      "/repo/worktree-a",
      "/repo/worktree-b",
      "/repo/worktree-b",
      "/repo/worktree-b",
      "/repo/worktree-b",
    ])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: storedSessions["/repo/worktree-a"][0]?.id },
      { directory: "/repo/worktree-b", sessionID: storedSessions["/repo/worktree-b"][0]?.id },
    ])
  })

  test("applies the effective pre-submit mode to newly created sessions", async () => {
    directoryAutoAccept = true

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(setModes).toEqual([
      { sessionID: storedSessions["/repo/worktree-a"][0]?.id, directory: "/repo/worktree-a", mode: "full" },
    ])
  })

  test("applies the settings default mode to newly created sessions", async () => {
    defaultMode = "safe"

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(setModes).toEqual([
      { sessionID: storedSessions["/repo/worktree-a"][0]?.id, directory: "/repo/worktree-a", mode: "safe" },
    ])
  })

  test("pins the initial mode to off when the settings default is off", async () => {
    defaultMode = "off"

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(setModes).toEqual([
      { sessionID: storedSessions["/repo/worktree-a"][0]?.id, directory: "/repo/worktree-a", mode: "off" },
    ])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { dir: "/repo/main", id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({
        id: "session-1",
        slug: "",
        projectID: "proj",
        directory: "/repo",
        title: "t",
        version: "",
        time: { created: 0, updated: 0 },
      }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]?.title).toBe("New session 1")
    expect(optimisticSeeded).toEqual([true])
  })

  test("shows the optimistic session before the server create resolves", async () => {
    let finish!: () => void
    claim = new Promise<void>((resolve) => {
      finish = resolve
    })
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    const pending = submit.handleSubmit(event)
    await flush()

    const seeded = storedSessions["/repo/worktree-a"]
    expect(seeded).toHaveLength(1)
    expect(seeded?.[0]?.id).toBeTruthy()
    expect(prompted).toHaveLength(0)

    finish()
    await pending

    expect(prompted).toHaveLength(1)
    expect(prompted[0].sessionID).toBe(seeded?.[0]?.id)
  })

  test("rolls back the optimistic session when the server create fails", async () => {
    failCreate = new Error("create failed")

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(storedSessions["/repo/worktree-a"]).toEqual([])
    expect(prompted).toHaveLength(0)
    expect(toasts.some((toast) => toast.title === "prompt.toast.sessionCreateFailed.title")).toBe(true)
  })

  test("builds a file quote ask prompt and clears the pending quote", async () => {
    params = { dir: "/repo/main", id: "session-1" }
    let question: {
      sessionID: string
      path: string
      startLine?: number
      endLine?: number
      text: string
      summary: string
    } | null = {
      sessionID: "session-1",
      path: "src/agent.ts",
      startLine: 3,
      endLine: 9,
      text: "const x = 1",
      summary: "const x = 1",
    }

    const submit = createPromptSubmit({
      info: () => ({
        id: "session-1",
        slug: "",
        projectID: "proj",
        directory: "/repo",
        title: "t",
        version: "",
        time: { created: 0, updated: 0 },
      }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      fileQuoteQuestion: () => question,
      onFileQuoteClear: () => (question = null),
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(prompted).toHaveLength(1)
    const parts = prompted[0].parts as Array<{
      type: string
      text?: string
      synthetic?: boolean
      ignored?: boolean
      metadata?: Record<string, unknown>
    }>
    expect(parts[0]).toMatchObject({ type: "text", text: "ls", ignored: true })
    expect(parts[1]?.synthetic).toBe(true)
    expect(parts[1]?.text).toContain("[Selected content from src/agent.ts:3-9]")
    expect(parts[1]?.text).toContain("[User question]")
    expect(parts[1]?.text).toContain("ls")
    expect(parts[1]?.text).toContain("const x = 1")
    expect(parts[2]?.ignored).toBe(true)
    expect(readFileQuoteMetadata(parts[2]?.metadata)).toEqual({
      path: "src/agent.ts",
      startLine: 3,
      endLine: 9,
      summary: "const x = 1",
      fullText: "const x = 1",
    })
    expect(question).toBeNull()
  })

  test("ignores file quotes from other sessions", async () => {
    params = { dir: "/repo/main", id: "session-1" }

    const submit = createPromptSubmit({
      info: () => ({
        id: "session-1",
        slug: "",
        projectID: "proj",
        directory: "/repo",
        title: "t",
        version: "",
        time: { created: 0, updated: 0 },
      }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      fileQuoteQuestion: () => ({
        sessionID: "session-2",
        path: "src/other.ts",
        text: "other",
        summary: "other",
      }),
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(prompted).toHaveLength(1)
    const parts = prompted[0].parts as Array<{ type: string; text?: string; synthetic?: boolean }>
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "text", text: "ls" })
  })
})

const reference = (id: string, question = "Why?"): Reference => ({
  id,
  version: 1,
  kind: "conversation",
  messageID: `message-${id}`,
  start: 0,
  end: 6,
  text: `quote-${id}`,
  summary: `quote-${id}`,
  question,
})
const setup = (queue?: (draft: FollowupDraft) => void) => {
  params = { dir: "/repo/main", id: "session-1" }
  return createPromptSubmit({
    info: () => ({
      id: "session-1",
      slug: "",
      projectID: "proj",
      directory: "/repo/main",
      title: "t",
      version: "",
      time: { created: 0, updated: 0 },
    }),
    imageAttachments: () => [],
    commentCount: () => 0,
    autoAccept: () => false,
    mode: () => "normal",
    working: () => false,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: (value) => value.reduce((n, part) => n + ("content" in part ? part.content.length : 0), 0),
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    shouldQueue: () => !!queue,
    onQueue: queue,
  })
}
const submitEvent = () => ({ preventDefault() {} }) as Event
const workspace = (worktree = "main", mode: "normal" | "shell" = "normal") =>
  createPromptSubmit({
    info: () => undefined,
    imageAttachments: () => [],
    commentCount: () => 0,
    autoAccept: () => false,
    mode: () => mode,
    working: () => false,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: (parts) => parts.reduce((n, part) => n + ("content" in part ? part.content.length : 0), 0),
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    newSessionWorktree: () => worktree,
  })
const pdf = (): Reference => ({
  id: "pdf",
  version: 1,
  kind: "pdf",
  question: "Explain",
  text: "Selected text",
  summary: "Selected text",
  path: "/papers/source.pdf",
  filename: "source.pdf",
  mode: "classic",
  sourceSession: "source",
  startPage: 1,
  endPage: 1,
  selection: "page:1",
  content: "text",
  settings: { questionPrompt: "{selected_content}" },
})

describe("Ask batch submission", () => {
  test.each([false, true])("keeps custom commands on the requested queue path: %s", async (queued) => {
    commands.push({ name: "custom" })
    const queue: FollowupDraft[] = []
    const submit = setup(queued ? (draft) => queue.push(draft) : undefined)
    value()[0] = { type: "text", content: "/custom one two", start: 0, end: 15 }
    await submit.handleSubmit(submitEvent())
    expect(prompted).toHaveLength(0)
    expect(queue).toHaveLength(queued ? 1 : 0)
    expect(invoked).toEqual(
      queued
        ? []
        : [
            {
              sessionID: "session-1",
              command: "custom",
              arguments: "one two",
              agent: "agent",
              model: "provider/model",
              variant: undefined,
              parts: [],
            },
          ],
    )
    if (queued) {
      expect(queue[0].sessionID).toBe("session-1")
      expect(queue[0].prompt).toEqual([{ type: "text", content: "/custom one two", start: 0, end: 15 }])
    }
    expect(value()[0]).toMatchObject({ content: "" })
  })

  test("sends a per-reference question with an empty composer", async () => {
    const submit = setup()
    value()[0] = { type: "text", content: "", start: 0, end: 0 }
    references.set(target("session-1"), [reference("a")])
    await submit.handleSubmit(submitEvent())
    expect(prompted).toHaveLength(1)
    expect((prompted[0].parts as Array<{ text?: string }>)[1].text).toContain("[Question 1]\nWhy?")
    expect(references.get(target("session-1"))).toEqual([])
  })

  test("requires a question and refuses a missing persisted screenshot", async () => {
    const submit = setup()
    value()[0] = { type: "text", content: "", start: 0, end: 0 }
    references.set(target("session-1"), [reference("a", "")])
    await submit.handleSubmit(submitEvent())
    expect(prompted).toHaveLength(0)
    references.set(target("session-1"), [
      {
        id: "image",
        version: 1,
        kind: "pdf",
        path: "a.pdf",
        filename: "a.pdf",
        mode: "quick",
        startPage: 1,
        endPage: 1,
        selection: "rect",
        content: "image",
        question: "What is this?",
        text: "",
        summary: "",
        settings: { questionPrompt: "{selected_content}" },
      },
    ])
    await submit.handleSubmit(submitEvent())
    expect(prompted).toHaveLength(0)
    expect(toasts).toHaveLength(2)
    expect(references.get(target("session-1"))).toHaveLength(1)
  })

  test("keeps an immutable reference snapshot in the queue", async () => {
    const queue: FollowupDraft[] = []
    const submit = setup((draft) => queue.push(draft))
    const source = reference("a")
    const file = {
      type: "file" as const,
      path: "paper.md",
      content: "@paper.md",
      start: 2,
      end: 11,
      selection: { startLine: 1, startChar: 0, endLine: 3, endChar: 2 },
    }
    value().push(file)
    references.set(target("session-1"), [source])
    await submit.handleSubmit(submitEvent())
    expect(prompted).toHaveLength(0)
    expect(queue).toHaveLength(1)
    expect(references.get(target("session-1"))).toEqual([])
    source.question = "Changed later"
    file.selection.startLine = 8
    expect(queue[0].references?.[0].question).toBe("Why?")
    expect(queue[0].prompt[1]).toMatchObject({ selection: { startLine: 1 } })
  })

  test("preserves references after failure and consumes them after retry", async () => {
    const submit = setup()
    references.set(target("session-1"), [reference("a")])
    failPrompt = new Error("offline")
    await submit.handleSubmit(submitEvent())
    expect(references.get(target("session-1"))).toHaveLength(1)
    expect(value()[0]).toMatchObject({ content: "ls" })
    failPrompt = undefined
    await submit.handleSubmit(submitEvent())
    expect(prompted).toHaveLength(2)
    expect(references.get(target("session-1"))).toEqual([])
  })

  test("does not clear newly added or edited references while sending", async () => {
    const submit = setup()
    references.set(target("session-1"), [reference("a")])
    let finish!: () => void
    gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = submit.handleSubmit(submitEvent())
    await flush()
    references.set(target("session-1"), [{ ...reference("a", "Edited question"), version: 2 }, reference("b")])
    finish()
    await pending
    expect(references.get(target("session-1"))?.map((ref) => ref.question)).toEqual(["Edited question", "Why?"])
  })

  test("clears only the submitted session after navigation", async () => {
    const submit = setup()
    references.set(target("session-1"), [reference("a")])
    let finish!: () => void
    gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = submit.handleSubmit(submitEvent())
    await flush()
    params = { dir: "/repo/main", id: "session-2" }
    references.set(target("session-2"), [reference("b")])
    value()[0] = { type: "text", content: "New draft", start: 0, end: 9 }
    finish()
    await pending
    expect(references.get(target("session-1"))).toEqual([])
    expect(references.get(target("session-2"))).toHaveLength(1)
    expect(value()[0]).toMatchObject({ content: "New draft" })
  })

  test("returns a failed first message to its complete workspace draft", async () => {
    const submit = workspace()
    references.set(target(), [reference("original")])
    failPrompt = new Error("offline")
    await submit.handleSubmit(submitEvent())
    expect(navigations).toHaveLength(2)
    expect(navigations.at(-1)).toEqual({ path: "//repo/main/session", replace: true })
    expect(params).toEqual({ dir: "/repo/main", id: undefined })
    expect(value()[0]).toMatchObject({ content: "ls" })
    expect(references.get(target())).toEqual([reference("original")])
    const id = promoted[0]?.sessionID
    expect(id).toBeTruthy()
    expect(value({ dir: "/repo/main", id })).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("keeps the workspace draft visible when reading context preparation fails", async () => {
    const submit = workspace()
    references.set(target(), [pdf()])
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response("Missing source", { status: 404 }), { preconnect: fetcher.preconnect }),
    )
    await submit.handleSubmit(submitEvent())
    expect(navigations.at(-1)).toEqual({ path: "//repo/main/session", replace: true })
    expect(value()[0]).toMatchObject({ content: "ls" })
    expect(references.get(target())).toEqual([pdf()])
    expect(prompted).toHaveLength(0)
  })

  test("awaits creation failure before fetching PDF context and removes the optimistic session", async () => {
    const submit = workspace()
    references.set(target(), [pdf()])
    failCreate = new Error("Cannot create")
    const request = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response("Unexpected"), { preconnect: fetcher.preconnect }),
    )
    await submit.handleSubmit(submitEvent())
    expect(request).not.toHaveBeenCalled()
    expect(storedSessions["/repo/main"]).toEqual([])
    expect(params.id).toBeUndefined()
    expect(value()[0]).toMatchObject({ content: "ls" })
    expect(references.get(target())).toEqual([pdf()])
    expect(toasts.some((toast) => toast.title === "prompt.toast.sessionCreateFailed.title")).toBe(true)
  })

  test.each(["text", "reference", "navigation"])(
    "does not replace a new session's %s after a failed first send",
    async (kind) => {
      const submit = workspace()
      references.set(target(), [reference("original")])
      failPrompt = new Error("offline")
      const release = { resolve: () => {} }
      gate = new Promise<void>((resolve) => {
        release.resolve = resolve
      })
      const sending = submit.handleSubmit(submitEvent())
      await flush()
      expect(params.id).toBeTruthy()
      if (kind === "text") value()[0] = { type: "text", content: "New draft", start: 0, end: 9 }
      if (kind === "reference") references.set(scope(), [reference("new")])
      if (kind === "navigation") params = { dir: "/repo/other", id: "other-session" }
      const current = { ...params }
      release.resolve()
      await sending
      expect(params).toEqual(current)
      expect(navigations).toHaveLength(1)
      expect(references.get(target())).toEqual([reference("original")])
      if (kind === "text") expect(value()[0]).toMatchObject({ content: "New draft" })
      if (kind === "reference") expect(references.get(scope())).toEqual([reference("new")])
    },
  )

  test("returns to the original draft after cancelling worktree preparation", async () => {
    const submit = workspace("create")
    references.set(target(), [reference("original")])
    const sending = submit.handleSubmit(submitEvent())
    await flush()
    expect(params.dir).toBe("/repo/main/new")
    expect(params.id).toBeTruthy()
    await submit.abort()
    await sending
    Worktree.ready("/repo/main/new")
    expect(prompted).toHaveLength(0)
    expect(params).toEqual({ dir: "/repo/main", id: undefined })
    expect(value()[0]).toMatchObject({ content: "ls" })
    expect(references.get(target())).toEqual([reference("original")])
  })

  test("freezes the PDF request URL and authentication before awaiting source checks", async () => {
    const submit = setup()
    const original = target("session-1")
    references.set(original, [pdf()])
    const release = { resolve: () => {} }
    reading = new Promise<void>((resolve) => {
      release.resolve = resolve
    })
    const request = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response("Source unavailable", { status: 404 }), {
        preconnect: fetcher.preconnect,
      }),
    )
    const sending = submit.handleSubmit(submitEvent())
    await flush()
    connection = { http: { url: "https://other.example", username: "new-user", password: "new-password" } }
    url = connection.http.url
    release.resolve()
    await sending
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://localhost:4096/reading-mode/page-text",
      "http://localhost:4096/reading-mode/page-pdf",
    ])
    expect(request.mock.calls.map((call) => new Headers(call[1]?.headers).get("Authorization"))).toEqual([
      `Basic ${btoa("old-user:old-password")}`,
      `Basic ${btoa("old-user:old-password")}`,
    ])
    expect(references.get(original)).toHaveLength(1)
  })

  test("never reloads a disposed prompt scope on the new server when an old send succeeds", async () => {
    const submit = setup()
    const original = target("session-1")
    references.set(original, [reference("original")])
    const release = { resolve: () => {} }
    gate = new Promise<void>((resolve) => {
      release.resolve = resolve
    })
    const sending = submit.handleSubmit(submitEvent())
    await flush()
    expect(prompted).toHaveLength(1)
    connection = { http: { url: "https://other.example", username: "new-user", password: "new-password" } }
    value()[0] = { type: "text", content: "New server draft", start: 0, end: 16 }
    references.set(target("session-1"), [reference("new")])
    accesses.length = 0
    release.resolve()
    await sending
    expect(accesses).toEqual([])
    expect(drafts.get(original)?.[0]).toMatchObject({ content: "ls" })
    expect(references.get(original)).toEqual([reference("original")])
    expect(value()[0]).toMatchObject({ content: "New server draft" })
    expect(references.get(target("session-1"))).toEqual([reference("new")])
  })

  test("does not restore a failed old shell command into a new server's draft", async () => {
    const submit = workspace("main", "shell")
    failShell = new Error("offline")
    const release = { resolve: () => {} }
    gate = new Promise<void>((resolve) => {
      release.resolve = resolve
    })
    await submit.handleSubmit(submitEvent())
    connection = { http: { url: "https://other.example", username: "new-user", password: "new-password" } }
    params = { dir: "/repo/main" }
    value()[0] = { type: "text", content: "", start: 0, end: 0 }
    accesses.length = 0
    release.resolve()
    await flush()
    expect(accesses).toEqual([])
    expect(value()[0]).toMatchObject({ content: "" })
  })

  test("does not replace an attachment pasted while a shell command is pending", async () => {
    const submit = workspace("main", "shell")
    failShell = new Error("offline")
    const release = { resolve: () => {} }
    gate = new Promise<void>((resolve) => {
      release.resolve = resolve
    })
    await submit.handleSubmit(submitEvent())
    params = { dir: "/repo/main" }
    const image = {
      type: "image" as const,
      id: "new",
      filename: "new.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,new",
    }
    value().splice(0, value().length, image)
    release.resolve()
    await flush()
    expect(value()).toEqual([image])
  })

  test("stops after worktree creation if the server changed during the await", async () => {
    const submit = workspace("create")
    const release = { resolve: () => {} }
    worktree = new Promise<void>((resolve) => {
      release.resolve = resolve
    })
    const pending = spyOn(Worktree, "pending")
    const sending = submit.handleSubmit(submitEvent())
    await flush()
    connection = { http: { url: "https://other.example", username: "new-user", password: "new-password" } }
    const snapshot = syncedDirectories.length
    release.resolve()
    await sending
    expect(pending).not.toHaveBeenCalled()
    pending.mockRestore()
    expect(createdClients).toEqual([])
    expect(createdSessions).toEqual([])
    expect(promoted).toEqual([])
    expect(navigations).toEqual([])
    expect(syncedDirectories).toHaveLength(snapshot)
  })

  test("does not seed or apply permissions after session creation completes on an old server", async () => {
    const submit = workspace()
    const release = { resolve: () => {} }
    claim = new Promise<void>((resolve) => {
      release.resolve = resolve
    })
    const sending = submit.handleSubmit(submitEvent())
    await flush()
    expect(promoted).toHaveLength(1)
    connection = { http: { url: "https://other.example", username: "new-user", password: "new-password" } }
    const snapshot = syncedDirectories.length
    accesses.length = 0
    release.resolve()
    await sending
    expect(syncedDirectories).toHaveLength(snapshot)
    expect(setModes).toEqual([])
    expect(prompted).toEqual([])
    expect(accesses).toEqual([])
    expect(navigations).toHaveLength(1)
  })
})
