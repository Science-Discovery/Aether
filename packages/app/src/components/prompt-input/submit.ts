import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { Binary } from "@opencode-ai/util/binary"
import { useNavigate, useParams } from "@solidjs/router"
import type { Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { useFile } from "@/context/file"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { DEFAULT_PROMPT, type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useKnowledge } from "@/context/knowledge"
import { promptProbe } from "@/testing/prompt"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts, type DataAttachment } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { createReadingQuoteMetadata, formatReadingPageRange, summarizeReadingQuoteText } from "@/utils/comment-note"
import { createConversationQuoteMetadata } from "@/utils/conversation-quote-metadata"
import { formatServerError } from "@/utils/server-errors"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  attachments?: DataAttachment[]
  extraTextParts?: Array<{
    text: string
    synthetic?: boolean
    ignored?: boolean
    metadata?: Record<string, unknown>
  }>
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  selectedPaths?: string[]
  pdfSelectedText?: string
}

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  globalSync: ReturnType<typeof useGlobalSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  knowledgeBase?: { path?: string; paths?: string[]; apiKey?: string; baseURL?: string }
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

function buildAuthHeaders(input: { username?: string; password?: string; json?: boolean }) {
  const headers: Record<string, string> = {}
  if (input.password) {
    headers.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  }
  if (input.json) {
    headers["Content-Type"] = "application/json"
  }
  return headers
}

function fillReadingQuestionPrompt(
  template: string,
  input: {
    selectedContent: string
    userQuestion: string
    contextPages: string
  },
) {
  return template
    .replaceAll("{selected_content}", input.selectedContent)
    .replaceAll("{user_question}", input.userQuestion)
    .replaceAll("{context_pages}", input.contextPages)
}

function describeReadingSelection(input: {
  startPage: number
  endPage?: number
  kind: "text-question" | "image-question"
  text?: string
}) {
  if (input.kind === "image-question") {
    return `用户选中的是一张来自 PDF 第 ${formatReadingPageRange(input)} 页的截图区域，请结合截图与上下文回答。`
  }
  return input.text ?? ""
}

function fillConversationQuotePrompt(input: { selectedContent: string[]; userQuestion: string }) {
  return [
    "The user selected one or more passages from previous assistant replies and wants to ask a follow-up question about them.",
    "",
    ...input.selectedContent.flatMap((text, idx) => [`[Quoted assistant content ${idx + 1}]`, text, ""]),
    "",
    "[User question]",
    input.userQuestion,
    "",
    "Answer the user's question based on the quoted assistant content. If the quoted content is incomplete or ambiguous, say so clearly.",
  ].join("\n")
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => reject(reader.error ?? new Error("failed to read blob")))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      resolve(value)
    })
    reader.readAsDataURL(blob)
  })
}

function resolveReadingContextRange(input: {
  startPage: number
  endPage?: number
  range: 0 | 1 | 2
  totalPages?: number
}) {
  const totalPages =
    typeof input.totalPages === "number" && Number.isFinite(input.totalPages) && input.totalPages > 0
      ? Math.floor(input.totalPages)
      : undefined
  const safeStart = totalPages ? Math.min(totalPages, Math.max(1, input.startPage)) : Math.max(1, input.startPage)
  const safeEnd = totalPages
    ? Math.min(totalPages, Math.max(safeStart, input.endPage ?? input.startPage))
    : Math.max(safeStart, input.endPage ?? input.startPage)
  return {
    startPage: Math.max(1, safeStart - input.range),
    endPage: totalPages ? Math.min(totalPages, safeEnd + input.range) : safeEnd + input.range,
  }
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const [, setStore] = input.globalSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        variant: input.draft.variant,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    attachments: input.draft.attachments,
    text,
    extraTextParts: input.draft.extraTextParts,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
    selectedPaths: input.draft.selectedPaths,
    pdfSelectedText: input.draft.pdfSelectedText,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: input.draft.model,
    variant: input.draft.variant,
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  setBusy()
  add()

  try {
    if (!(await wait())) {
      setIdle()
      remove()
      return false
    }

    await input.client.session.promptAsync({
      sessionID: input.draft.sessionID,
      agent: input.draft.agent,
      model: input.draft.model,
      messageID,
      parts: requestParts,
      variant: input.draft.variant,
      knowledgeBase: input.knowledgeBase,
    })
    return true
  } catch (err) {
    setIdle()
    remove()
    throw err
  }
}

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  openTabPaths?: Accessor<string[]>
  conversationQuoteQuestions?: Accessor<QuoteQuestion[]>
  onConversationQuoteClear?: (sessionID?: string) => void
  quickReadingQuestion?: Accessor<QuickQuestion>
  quickReadingSettings?: Accessor<QuestionSettings | undefined>
  onQuickReadingQuestionClear?: () => void
  readingQuestion?: Accessor<ReadingQuestion>
  readingSessionMeta?: Accessor<ReadingMeta | null | undefined>
  readingTotalPages?: Accessor<number | undefined>
  onReadingQuestionClear?: () => void
}

type QuoteQuestion = {
  sessionID: string
  sourceMessageID: string
  text: string
  summary: string
}

type QuestionSettings = {
  questionPrompt: string
}

type ReadingSettings = QuestionSettings & {
  contextPageRange: 0 | 1 | 2
}

type ReadingMeta = {
  pdfFileName: string
  settings: ReadingSettings
}

type TextQuestion = {
  kind: "text-question"
  startPage: number
  endPage: number
  text: string
}

type ImageQuestion = {
  kind: "image-question"
  page: number
  text: string
  imageDataUrl: string
}

type ReadingQuestion = TextQuestion | ImageQuestion | null

type QuickQuestion =
  | ((TextQuestion | ImageQuestion) & {
      sessionID: string
      pdfFileName: string
    })
  | null

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const knowledge = useKnowledge()
  const fileCtx = useFile()
  const server = useServer()

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    globalSync.todo.set(sessionID, [])
    const [, setStore] = globalSync.child(sdk.directory)
    setStore("todo", sessionID, [])

    input.onAbort?.()

    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = globalSync.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const fetchReadingContextPages = async (input: {
    sessionID: string
    startPage: number
    endPage?: number
    range: 0 | 1 | 2
    totalPages?: number
  }) => {
    const { startPage, endPage } = resolveReadingContextRange(input)
    const http = server.current?.http
    const response = await fetch(`${sdk.url}/reading-mode/page-text`, {
      method: "POST",
      headers: buildAuthHeaders({ username: http?.username, password: http?.password, json: true }),
      body: JSON.stringify({
        sessionID: input.sessionID,
        startPage,
        endPage,
      }),
    })
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `HTTP ${response.status}`)
    }
    return (await response.json()) as {
      pageCount: number
      pages: Array<{ pageNumber: number; text: string }>
      combinedText: string
    }
  }

  const fetchReadingContextPdf = async (input: {
    sessionID: string
    startPage: number
    endPage?: number
    range: 0 | 1 | 2
    totalPages?: number
  }) => {
    const { startPage, endPage } = resolveReadingContextRange(input)
    const http = server.current?.http
    const response = await fetch(`${sdk.url}/reading-mode/page-pdf`, {
      method: "POST",
      headers: buildAuthHeaders({ username: http?.username, password: http?.password, json: true }),
      body: JSON.stringify({
        sessionID: input.sessionID,
        startPage,
        endPage,
      }),
    })
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `HTTP ${response.status}`)
    }
    return {
      range: { startPage, endPage },
      blob: await response.blob(),
    }
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    if (input.working()) {
      abort()
      return
    }

    if (server.healthy() === false) {
      showToast({
        title: language.t("prompt.toast.serverUnavailable.title"),
        description: language.t("prompt.toast.serverUnavailable.description"),
      })
      return
    }

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()
    promptProbe.start()

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const context = prompt.context.items().slice()
    const openPaths = input.openTabPaths?.() ?? []
    const selText = fileCtx.selectedText()
    const quoteQuestions = input.conversationQuoteQuestions?.().filter((item) => item.sessionID === params.id) ?? []
    const readingQuestion = input.readingQuestion?.() ?? null
    const quickReadingPendingQuestion = input.quickReadingQuestion?.() ?? null
    const quickReadingQuestion =
      quickReadingPendingQuestion?.sessionID === params.id ? quickReadingPendingQuestion : null
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
      selectedPaths: openPaths.length > 0 ? openPaths : undefined,
      pdfSelectedText: selText || undefined,
    }

    const clearInput = () => {
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, input.promptLength(currentPrompt))
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext()
      clearInput()
      return
    }

    promptProbe.submit({ sessionID: session.id, directory: sessionDirectory })
    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (quoteQuestions.length === 0 && !readingQuestion && !quickReadingQuestion && text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    removeCommentItems(commentItems)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreInput()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    if (mode === "normal" && quoteQuestions.length > 0) {
      const typed = text.trim()
      if (!typed) {
        restoreCommentItems(commentItems)
        restoreInput()
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: language.t("prompt.toast.promptSendFailed.description"),
        })
        return
      }

      const requestDraft: FollowupDraft = {
        sessionID: session.id,
        sessionDirectory,
        prompt: [DEFAULT_PROMPT[0]!, ...images],
        context,
        agent,
        model,
        variant,
        selectedPaths: openPaths.length > 0 ? openPaths : undefined,
        extraTextParts: [
          {
            text: typed,
            ignored: true,
          },
          {
            text: fillConversationQuotePrompt({
              selectedContent: quoteQuestions.map((item) => item.text),
              userQuestion: typed,
            }),
            synthetic: true,
          },
          ...quoteQuestions.map((item) => ({
            text: "",
            synthetic: true,
            ignored: true,
            metadata: createConversationQuoteMetadata({
              kind: "conversation-quote" as const,
              source: "assistant" as const,
              action: "ask" as const,
              sourceMessageID: item.sourceMessageID,
              summary: item.summary,
              fullText: item.text,
            }),
          })),
        ],
      }

      void sendFollowupDraft({
        client,
        sync,
        globalSync,
        draft: requestDraft,
        messageID,
        optimisticBusy: sessionDirectory === projectDirectory,
        before: waitForWorktree,
        knowledgeBase:
          knowledge.enabled() && knowledge.activeKnowledgeBases().length > 0
            ? {
                paths: knowledge.activeKnowledgeBases().map((kb) => kb.path),
                apiKey: knowledge.activeKnowledgeBases()[0]!.apiKey,
                baseURL: knowledge.activeKnowledgeBases()[0]!.baseURL,
              }
            : undefined,
      })
        .then((ok) => {
          if (ok) {
            input.onConversationQuoteClear?.(params.id)
            return
          }
          restoreCommentItems(commentItems)
          restoreInput()
        })
        .catch((err) => {
          pending.delete(session.id)
          if (sessionDirectory === projectDirectory) {
            sync.set("session_status", session.id, { type: "idle" })
          }
          showToast({
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err),
          })
          removeOptimisticMessage()
          restoreCommentItems(commentItems)
          restoreInput()
        })
      return
    }

    if (mode === "normal" && quickReadingQuestion) {
      const typedQuestion = text.trim()
      const settings = input.quickReadingSettings?.()
      if (!typedQuestion || !settings) {
        restoreCommentItems(commentItems)
        restoreInput()
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: language.t("prompt.toast.promptSendFailed.description"),
        })
        return
      }

      const requestDraft: FollowupDraft = {
        sessionID: session.id,
        sessionDirectory,
        prompt: [DEFAULT_PROMPT[0]!, ...images],
        attachments:
          quickReadingQuestion.kind === "image-question"
            ? [
                {
                  filename: `pdf-region-page-${quickReadingQuestion.page}.png`,
                  mime: "image/png",
                  dataUrl: quickReadingQuestion.imageDataUrl,
                },
              ]
            : undefined,
        context,
        agent,
        model,
        variant,
        selectedPaths: openPaths.length > 0 ? openPaths : undefined,
        extraTextParts: [
          {
            text: typedQuestion,
            ignored: true,
          },
          {
            text: fillReadingQuestionPrompt(settings.questionPrompt, {
              selectedContent:
                quickReadingQuestion.kind === "image-question"
                  ? `The user selected a screenshot region from page ${quickReadingQuestion.page} of ${quickReadingQuestion.pdfFileName}.`
                  : `The user selected text from pages ${formatReadingPageRange({ startPage: quickReadingQuestion.startPage, endPage: quickReadingQuestion.endPage })} of ${quickReadingQuestion.pdfFileName}.\n\n${quickReadingQuestion.text}`,
              userQuestion: typedQuestion,
              contextPages: "",
            }),
            synthetic: true,
          },
          ...(quickReadingQuestion.kind === "text-question"
            ? [
                {
                  text: "",
                  synthetic: true,
                  ignored: true,
                  metadata: createReadingQuoteMetadata({
                    mode: "quick",
                    action: "ask",
                    contentType: "text",
                    pdfFileName: quickReadingQuestion.pdfFileName,
                    startPage: quickReadingQuestion.startPage,
                    endPage: quickReadingQuestion.endPage,
                    summary: summarizeReadingQuoteText(quickReadingQuestion.text),
                    fullText: quickReadingQuestion.text,
                  }),
                },
              ]
            : []),
        ],
      }

      void sendFollowupDraft({
        client,
        sync,
        globalSync,
        draft: requestDraft,
        messageID,
        optimisticBusy: sessionDirectory === projectDirectory,
        before: waitForWorktree,
        knowledgeBase:
          knowledge.enabled() && knowledge.activeKnowledgeBases().length > 0
            ? {
                paths: knowledge.activeKnowledgeBases().map((kb) => kb.path),
                apiKey: knowledge.activeKnowledgeBases()[0]!.apiKey,
                baseURL: knowledge.activeKnowledgeBases()[0]!.baseURL,
              }
            : undefined,
      })
        .then((ok) => {
          if (ok) {
            input.onQuickReadingQuestionClear?.()
            return
          }
          restoreCommentItems(commentItems)
          restoreInput()
        })
        .catch((err) => {
          pending.delete(session.id)
          if (sessionDirectory === projectDirectory) {
            sync.set("session_status", session.id, { type: "idle" })
          }
          showToast({
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err),
          })
          removeOptimisticMessage()
          restoreCommentItems(commentItems)
          restoreInput()
        })
      return
    }

    if (mode === "normal" && readingQuestion) {
      const typedQuestion = text.trim()
      const sessionMeta = sync.session.get(session.id)?.readingMode ?? input.readingSessionMeta?.()
      if (!typedQuestion || !sessionMeta) {
        restoreCommentItems(commentItems)
        restoreInput()
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: language.t("prompt.toast.promptSendFailed.description"),
        })
        return
      }

      let requestDraft: FollowupDraft
      try {
        const contextInput = {
          sessionID: session.id,
          startPage: readingQuestion.kind === "text-question" ? readingQuestion.startPage : readingQuestion.page,
          endPage: readingQuestion.kind === "text-question" ? readingQuestion.endPage : readingQuestion.page,
          range: sessionMeta.settings.contextPageRange,
          totalPages: input.readingTotalPages?.(),
        } as const
        const [pageText, pagePdf] = await Promise.all([
          fetchReadingContextPages(contextInput),
          fetchReadingContextPdf(contextInput),
        ])
        const pdfDataUrl = await blobToDataUrl(pagePdf.blob)
        const baseName = sessionMeta.pdfFileName.replace(/\.pdf$/i, "") || "document"
        const imageAttachment =
          readingQuestion.kind === "image-question"
            ? [
                {
                  filename: `pdf-region-page-${readingQuestion.page}.png`,
                  mime: "image/png",
                  dataUrl: readingQuestion.imageDataUrl,
                },
              ]
            : []

        requestDraft = {
          sessionID: session.id,
          sessionDirectory,
          prompt: [DEFAULT_PROMPT[0]!, ...images],
          attachments: [
            ...imageAttachment,
            {
              filename: `${baseName}-pages-${pagePdf.range.startPage}-${pagePdf.range.endPage}.pdf`,
              mime: "application/pdf",
              dataUrl: pdfDataUrl,
            },
          ],
          context,
          agent,
          model,
          variant,
          selectedPaths: openPaths.length > 0 ? openPaths : undefined,
          extraTextParts: [
            {
              text: typedQuestion,
              ignored: true,
            },
            {
              text: fillReadingQuestionPrompt(sessionMeta.settings.questionPrompt, {
                selectedContent: describeReadingSelection({
                  startPage:
                    readingQuestion.kind === "text-question" ? readingQuestion.startPage : readingQuestion.page,
                  endPage: readingQuestion.kind === "text-question" ? readingQuestion.endPage : readingQuestion.page,
                  kind: readingQuestion.kind,
                  text: readingQuestion.kind === "text-question" ? readingQuestion.text : undefined,
                }),
                userQuestion: typedQuestion,
                contextPages: pageText.combinedText,
              }),
              synthetic: true,
            },
            ...(readingQuestion.kind === "text-question"
              ? [
                  {
                    text: "",
                    synthetic: true,
                    ignored: true,
                    metadata: createReadingQuoteMetadata({
                      mode: "classic",
                      action: "ask",
                      contentType: "text",
                      pdfFileName: sessionMeta.pdfFileName,
                      startPage: readingQuestion.startPage,
                      endPage: readingQuestion.endPage,
                      summary: summarizeReadingQuoteText(readingQuestion.text),
                      fullText: readingQuestion.text,
                    }),
                  },
                ]
              : []),
          ],
        }
      } catch (err) {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
        restoreCommentItems(commentItems)
        restoreInput()
        return
      }

      void sendFollowupDraft({
        client,
        sync,
        globalSync,
        draft: requestDraft,
        messageID,
        optimisticBusy: sessionDirectory === projectDirectory,
        before: waitForWorktree,
        knowledgeBase:
          knowledge.enabled() && knowledge.activeKnowledgeBases().length > 0
            ? {
                paths: knowledge.activeKnowledgeBases().map((kb) => kb.path),
                apiKey: knowledge.activeKnowledgeBases()[0]!.apiKey,
                baseURL: knowledge.activeKnowledgeBases()[0]!.baseURL,
              }
            : undefined,
      })
        .then((ok) => {
          if (ok) {
            input.onReadingQuestionClear?.()
            return
          }
          restoreCommentItems(commentItems)
          restoreInput()
        })
        .catch((err) => {
          pending.delete(session.id)
          if (sessionDirectory === projectDirectory) {
            sync.set("session_status", session.id, { type: "idle" })
          }
          showToast({
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err),
          })
          removeOptimisticMessage()
          restoreCommentItems(commentItems)
          restoreInput()
        })
      return
    }

    void sendFollowupDraft({
      client,
      sync,
      globalSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
      knowledgeBase:
        knowledge.enabled() && knowledge.activeKnowledgeBases().length > 0
          ? {
              paths: knowledge.activeKnowledgeBases().map((kb) => kb.path),
              apiKey: knowledge.activeKnowledgeBases()[0]!.apiKey,
              baseURL: knowledge.activeKnowledgeBases()[0]!.baseURL,
            }
          : undefined,
    }).catch((err) => {
      pending.delete(session.id)
      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      restoreCommentItems(commentItems)
      restoreInput()
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
