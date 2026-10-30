import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { clearReferences, cloneReferences, type Reference } from "@/utils/ask-reference"
import type { FollowupDraft } from "./submit"
import type { Prompt, PromptScope } from "@/context/prompt"
import { readFileQuoteMetadata } from "@/utils/comment-note"
import { Worktree } from "@/utils/worktree"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

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
const scope = (value: PromptScope = params) => JSON.stringify([connection.http.url, value.dir, value.id])
const target = (id?: string, dir = "/repo/main") => scope({ dir, id })
let defaultMode: "off" | "safe" | "full" = "safe"

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
      create: async (input: { id?: string }) => {
        createdSessions.push(directory)
        if (claim) await claim
        if (failCreate) throw failCreate
        return {
          data: {
            id: input?.id ?? `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
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
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
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
        remove: () => undefined,
        items: () => {
          accesses.push("context.items")
          return []
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
  setModes.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  prompted.length = 0
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
  drafts.clear()
  connection = { http: { url: "http://localhost:4096", username: "old-user", password: "old-password" } }
  url = connection.http.url
  drafts.set(target(), [{ type: "text", content: "ls", start: 0, end: 2 }])
  drafts.set(target("session-1"), [{ type: "text", content: "ls", start: 0, end: 2 }])
  navigations.length = 0
  accesses.length = 0
  reading = undefined
  directoryAutoAccept = false
  defaultMode = "safe"
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

afterEach(() => {
  globalThis.fetch = fetcher
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
