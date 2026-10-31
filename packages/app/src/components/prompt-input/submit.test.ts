import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import type { FollowupDraft } from "./submit"
import { readFileQuoteMetadata } from "@/utils/comment-note"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let sendFollowupDraft: typeof import("./submit").sendFollowupDraft

const createdClients: string[] = []
const createdSessions: string[] = []
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
const toasts: Array<{ title?: string; description?: string }> = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let failCreate: Error | undefined
let directoryAutoAccept = false
let defaultMode: "off" | "safe" | "full" = "safe"
let configured = true
let unavailable = false
const cleared: string[] = []
const catalogs: Record<string, ReturnType<typeof catalog>> = {}

function catalog(provider = "provider", model = "model") {
  return {
    all: [{ id: provider, name: provider, models: { [model]: { id: model, name: model, disabled: false } } }],
    connected: [provider],
    default: {},
  }
}

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async (input: { id?: string }) => {
        createdSessions.push(directory)
        if (failCreate) throw failCreate
        return {
          data: {
            id: input?.id ?? `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
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
        return { data: undefined }
      },
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
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
    showToast: (input: { title?: string; description?: string }) => toasts.push(input),
  }))

  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => (configured ? { id: "model", provider: { id: "provider" } } : undefined),
        unavailable: () => unavailable,
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
      reset: () => cleared.push("prompt"),
      set: () => cleared.push("set"),
      context: {
        add: () => undefined,
        remove: () => cleared.push("context"),
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
      data: { command: [] },
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
      data: { config: {} },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          {
            session: storedSessions[directory],
            status: "complete",
            config: {},
            provider: catalogs[directory] ?? catalog(),
          },
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
  sendFollowupDraft = mod.sendFollowupDraft
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
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
  directoryAutoAccept = false
  defaultMode = "safe"
  configured = true
  unavailable = false
  cleared.length = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
  for (const key of Object.keys(catalogs)) delete catalogs[key]
})

describe("prompt submit worktree selection", () => {
  test.each(["missing", "disabled"])(
    "retains a queued reference and attachment snapshot when its old model is %s",
    async (state) => {
      const draft: FollowupDraft = {
        sessionID: "queued-session",
        sessionDirectory: "/repo/worktree-a",
        prompt: [{ type: "text", content: "question", start: 0, end: 8 }],
        context: [{ type: "file", key: "quote", path: "notes.md", comment: "keep this question" }],
        attachments: [{ filename: "selection.png", mime: "image/png", dataUrl: "data:image/png;base64,AQ==" }],
        extraTextParts: [{ text: "original selection", metadata: { test: "reference" } }],
        model: { providerID: "opencode", modelID: "big-pickle" },
        agent: "agent",
      }
      const snapshot = structuredClone(draft)
      const folders: string[] = []
      const listed = catalog("opencode", "big-pickle")
      listed.all[0].models["big-pickle"].disabled = true
      const input = {
        draft,
        client: clientFor("/repo/main"),
        sync: {
          data: { command: [] },
          session: { optimistic: { add() {}, remove() {} } },
        },
        globalSync: {
          data: { config: {} },
          child: (directory: string) => {
            folders.push(directory)
            return [
              {
                status: "complete",
                config: {},
                provider: state === "disabled" ? listed : catalog("custom", "available"),
              },
              () => {},
            ]
          },
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]
      await expect(sendFollowupDraft(input)).rejects.toEqual({
        name: "ProviderModelNotFoundError",
        data: draft.model,
      })
      expect(draft).toEqual(snapshot)
      expect(prompted).toEqual([])
      expect(folders.every((directory) => directory === draft.sessionDirectory)).toBe(true)
    },
  )

  test.each([false, true])(
    "preserves the draft and attachments before session creation when no model exists (unavailable: %p)",
    async (stale) => {
      configured = false
      unavailable = stale
      const images = [
        {
          type: "image" as const,
          id: "image",
          filename: "sample.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,AQ==",
        },
      ]
      const submit = createPromptSubmit({
        info: () => undefined,
        imageAttachments: () => images,
        commentCount: () => 1,
        autoAccept: () => false,
        mode: () => "normal",
        working: () => false,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: () => 2,
        addToHistory: () => cleared.push("history"),
        resetHistoryNavigation: () => cleared.push("navigation"),
        setMode: () => cleared.push("mode"),
        setPopover: () => cleared.push("popover"),
        newSessionWorktree: () => "create",
        onSubmit: () => cleared.push("submit"),
      })
      await submit.handleSubmit({ preventDefault() {} } as Event)
      expect(createdSessions).toEqual([])
      expect(prompted).toEqual([])
      expect(optimistic).toEqual([])
      expect(cleared).toEqual([])
      expect(images).toHaveLength(1)
      expect(promptValue[0]).toMatchObject({ content: "ls" })
      expect(toasts).toEqual([
        {
          title: "prompt.toast.modelAgentRequired.title",
          description: "prompt.model.required",
        },
      ])
    },
  )

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
