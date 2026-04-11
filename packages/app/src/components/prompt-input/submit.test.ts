import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
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
const promptAsyncCalls: any[] = []
const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let quickReadingPendingQuestion:
  | {
      kind: "text-question" | "image-question"
      sessionID: string
      pdfPath: string
      pdfFileName: string
      page: number
      text: string
      imageDataUrl?: string
      createdAt: number
    }
  | null = null
let readingPendingQuestion:
  | {
      kind: "text-question" | "image-question"
      page: number
      text: string
      imageDataUrl?: string
      createdAt: number
    }
  | null = null
let fetchResponder: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async () => {
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: any) => {
        promptAsyncCalls.push(input)
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
    showToast: () => 0,
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
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
    usePrompt: () => ({
      current: () => promptValue,
      reset: () => undefined,
      set: () => undefined,
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
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
        get: () => undefined,
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
    useKnowledge: () => ({
      enabled: () => false,
      activeKnowledgeBases: () => [],
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
    }),
  }))

  mock.module("@/context/quick-reading-mode", () => ({
    useMaybeQuickReadingMode: () => ({
      store: {
        pendingQuestion: quickReadingPendingQuestion,
        snapshot: {
          settings: {
            translatePrompt: "translate prompt",
            questionPrompt: "Selected:\n{selected_content}\nQuestion:\n{user_question}",
            firstReadPrompt: "first read prompt",
            autoFirstRead: true,
          },
        },
      },
      setPendingQuestion: (question: typeof quickReadingPendingQuestion) => {
        quickReadingPendingQuestion = question
      },
    }),
  }))

  mock.module("@/context/reading-mode", () => ({
    useMaybeReadingMode: () => ({
      store: {
        pendingQuestion: readingPendingQuestion,
        sessionMeta: {
          pdfFileName: "classic-paper.pdf",
          pdfStorePath: "",
          lastReadPage: 1,
          annotationsPath: "",
          source: { kind: "workspace-file" as const },
          settings: {
            translatePrompt: "translate prompt",
            questionPrompt: "Selected:\n{selected_content}\nQuestion:\n{user_question}\nContext:\n{context_pages}",
            firstReadPrompt: "first read prompt",
            contextPageRange: 1,
            autoFirstRead: true,
          },
          firstReadCompleted: false,
          firstReadDismissed: false,
        },
        totalPages: 100,
      },
      setPendingQuestion: (question: typeof readingPendingQuestion) => {
        readingPendingQuestion = question
      },
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  fetchResponder = async () => new Response("{}")

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return fetchResponder(input, init)
  }) as typeof fetch

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  promptAsyncCalls.length = 0
  fetchCalls.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  quickReadingPendingQuestion = null
  readingPendingQuestion = null
  fetchResponder = async () => new Response("{}")
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
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
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
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

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
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

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })

  test("quick-reading text ask does not fetch reading context and clears pending on success", async () => {
    params = { id: "session-1" }
    quickReadingPendingQuestion = {
      kind: "text-question",
      sessionID: "session-1",
      pdfPath: "/repo/paper-a.pdf",
      pdfFileName: "paper-a.pdf",
      page: 12,
      text: "selected text",
      createdAt: Date.now(),
    }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
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
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchCalls).toEqual([])
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          synthetic: true,
          text: expect.stringContaining("selected text"),
        }),
        expect.objectContaining({
          type: "text",
          synthetic: true,
          ignored: true,
          metadata: expect.objectContaining({
            opencodeReadingQuote: expect.objectContaining({
              mode: "quick",
              action: "ask",
              contentType: "text",
              pdfFileName: "paper-a.pdf",
              page: 12,
            }),
          }),
        }),
      ]),
    )
    expect(quickReadingPendingQuestion).toBeNull()
  })

  test("quick-reading image ask sends screenshot attachment without reading context pdf", async () => {
    params = { id: "session-1" }
    quickReadingPendingQuestion = {
      kind: "image-question",
      sessionID: "session-1",
      pdfPath: "/repo/paper-a.pdf",
      pdfFileName: "paper-a.pdf",
      page: 7,
      text: "Captured region from paper-a.pdf, page 7",
      imageDataUrl: "data:image/png;base64,abc",
      createdAt: Date.now(),
    }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
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
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchCalls).toEqual([])
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          mime: "image/png",
          filename: "pdf-region-page-7.png",
        }),
      ]),
    )
    expect(promptAsyncCalls[0].parts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mime: "application/pdf",
        }),
      ]),
    )
    expect(
      promptAsyncCalls[0].parts.some(
        (part: any) => part.type === "text" && part.metadata?.opencodeReadingQuote?.contentType === "image",
      ),
    ).toBe(false)
    expect(quickReadingPendingQuestion).toBeNull()
  })

  test("classic ask includes reading quote metadata and keeps reading context fetches", async () => {
    params = { id: "session-1" }
    readingPendingQuestion = {
      kind: "text-question",
      page: 9,
      text: "classic selected text",
      createdAt: Date.now(),
    }
    fetchResponder = async (input) => {
      const url = String(input)
      if (url.includes("/reading-mode/page-text")) {
        return new Response(
          JSON.stringify({
            pageCount: 1,
            pages: [{ pageNumber: 9, text: "context text" }],
            combinedText: "context text",
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.includes("/reading-mode/page-pdf")) {
        return new Response(new Blob(["pdf"], { type: "application/pdf" }), {
          headers: { "Content-Type": "application/pdf" },
        })
      }
      return new Response("{}")
    }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
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
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchCalls).toHaveLength(2)
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          mime: "application/pdf",
        }),
        expect.objectContaining({
          type: "text",
          synthetic: true,
          ignored: true,
          metadata: expect.objectContaining({
            opencodeReadingQuote: expect.objectContaining({
              mode: "classic",
              action: "ask",
              contentType: "text",
              pdfFileName: "classic-paper.pdf",
              page: 9,
            }),
          }),
        }),
      ]),
    )
    expect(readingPendingQuestion).toBeNull()
  })
})
