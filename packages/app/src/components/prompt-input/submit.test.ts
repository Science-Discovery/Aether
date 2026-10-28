import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { readFileQuoteMetadata } from "@/utils/comment-note"
import type { NativeEngine } from "@/utils/native"
import type { NativeDraft } from "@/context/native-run"

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
const toasts: Array<{ title?: string }> = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let failCreate: Error | undefined
let failPrompt: Error | undefined
let restored = 0
let directoryAutoAccept = false
let defaultMode: "off" | "safe" | "full" = "safe"
let engine: NativeEngine | undefined
let ready = true
const commands: Array<{ name: string }> = []
let invoked = 0
let resets = 0
let aborted = 0

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async (input: { id?: string; engine?: NativeEngine }) => {
        createdSessions.push(directory)
        engines.push(input.engine)
        if (failCreate) throw failCreate
        return {
          data: {
            id: input?.id ?? `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
            engine: input.engine,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: Record<string, unknown>) => {
        prompted.push(input)
        if (failPrompt) throw failPrompt
        return { data: undefined }
      },
      command: async () => {
        invoked++
        return { data: undefined }
      },
      abort: async () => {
        aborted++
        return { data: undefined }
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
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
      current: () => promptValue,
      reset: () => {
        resets++
      },
      set: () => {
        restored++
      },
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
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
        url: "http://localhost:4096",
        createClient(opts: any) {
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
      current: undefined,
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
  toasts.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  failCreate = undefined
  failPrompt = undefined
  restored = 0
  directoryAutoAccept = false
  defaultMode = "safe"
  engine = undefined
  ready = true
  commands.length = 0
  invoked = 0
  resets = 0
  aborted = 0
  promptValue.splice(0, promptValue.length, { type: "text", content: "ls", start: 0, end: 2 })
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
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

describe("native prompt submission", () => {
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
    promptValue.push({ type: "file", path: "/paper.pdf", content: "@paper", start: 2, end: 8 })
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
    promptValue.push({ type: "file", path: "notes.txt", content: "@notes", start: 2, end: 8 })
    let cleared = 0
    const sent: NativeDraft[] = []
    const submit = nativeSubmit({
      working: () => true,
      nativeSubmit: async (draft) => {
        sent.push(draft)
        return false
      },
      quickReadingQuestion: () => ({
        sessionID: "existing",
        kind: "image-question",
        page: 3,
        text: "",
        imageDataUrl: "data:image/png;base64,aGVsbG8=",
        pdfFileName: "paper.pdf",
      }),
      quickReadingSettings: () => ({ questionPrompt: "{selected_content}\n{user_question}" }),
      onQuickReadingQuestionClear: () => {
        cleared++
      },
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ text: "ls@notes" })
    expect(sent[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file", mime: "image/png", filename: "pdf-region-page-3.png" }),
        expect.objectContaining({ type: "file", url: "file:///repo/main/notes.txt" }),
        expect.objectContaining({
          type: "text",
          synthetic: true,
          text: expect.stringContaining("page 3 of paper.pdf"),
        }),
      ]),
    )
    expect(resets).toBe(0)
    expect(cleared).toBe(0)
    expect(prompted).toHaveLength(0)
  })

  test("restores a normal quoted draft and handles a rejected send without an unhandled promise", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    failPrompt = new Error("send failed")
    const submit = nativeSubmit({
      fileQuoteQuestion: () => ({ sessionID: "existing", path: "paper.md", text: "quoted passage", summary: "quoted" }),
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as Event)
    await flush()
    expect(restored).toBe(1)
    expect(toasts.at(-1)?.title).toBe("prompt.toast.promptSendFailed.title")
  })

  test("resolves queued relative file references in the session directory", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    promptValue.push({ type: "file", path: "paper.pdf", content: "@paper", start: 2, end: 8 })
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
    expect(count).toBe(1)
    params.id = "another"
    receipt.resolve(true)
    await first
    expect(resets).toBe(0)
    expect(prompted).toHaveLength(0)
  })

  test("preserves typing entered while an active-turn request is awaiting acknowledgement", async () => {
    engine = { type: "codex", model: "native-model" }
    params.id = "existing"
    const pending = Promise.withResolvers<boolean>()
    const submit = nativeSubmit({ working: () => true, nativeSubmit: () => pending.promise })
    const sending = submit.handleSubmit({ preventDefault: () => undefined } as Event)
    promptValue.splice(0, 1, { type: "text", content: "New instructions", start: 0, end: 16 })
    pending.resolve(true)
    await sending
    expect(resets).toBe(0)
    expect(promptValue[0]).toMatchObject({ content: "New instructions" })
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
    promptValue.splice(0, promptValue.length, { type: "text", content: "/legacy task", start: 0, end: 12 })
    await nativeSubmit().handleSubmit({ preventDefault: () => undefined } as Event)
    await flush()
    expect(invoked).toBe(0)
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
    params = { id: "native-session" }
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
    params = { id: "session-1" }
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

    const seeded = storedSessions["/repo/worktree-a"]
    expect(seeded).toHaveLength(1)
    expect(seeded?.[0]?.id).toBeTruthy()
    expect(prompted).toHaveLength(0)

    await flush()

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
    params = { id: "session-1" }
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
    params = { id: "session-1" }

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
