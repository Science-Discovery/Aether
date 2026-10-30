import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { Binary } from "@opencode-ai/util/binary"
import { useNavigate, useParams } from "@solidjs/router"
import type { Accessor } from "solid-js"
import { useFile } from "@/context/file"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { NEW_SESSION_KEY, useKnowledge } from "@/context/knowledge"
import { promptProbe } from "@/testing/prompt"
import { Identifier } from "@/utils/id"
import { claimSession } from "@/utils/session-pending"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts, type DataAttachment } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { clonePromptParts } from "./history"
import { cloneReferences, canAsk, missingImages, type Reference } from "@/utils/ask-reference"
import { referenceParts, referenceRanges, type FileQuestion, type ReadingContext } from "./ask-request"
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
  references?: Reference[]
  sources?: ReadingContext[]
  fileQuote?: FileQuestion
}

export type FollowupEdit = { id: string } & Pick<FollowupDraft, "prompt" | "context" | "references" | "fileQuote">

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
  if (
    !input.draft.references?.length &&
    !input.draft.fileQuote &&
    cmd &&
    input.sync.data.command.find((item) => item.name === cmd)
  ) {
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

  const quoted = !!input.draft.references?.length || !!input.draft.fileQuote
  const selection = quoted
    ? referenceParts({
        refs: input.draft.references ?? [],
        text,
        contexts: input.draft.sources,
        file: input.draft.fileQuote,
      })
    : undefined
  const messageID = input.messageID ?? Identifier.ascending("message")
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    attachments: [...(input.draft.attachments ?? []), ...(selection?.attachments ?? [])],
    text: quoted ? "" : text,
    extraTextParts: [...(input.draft.extraTextParts ?? []), ...(selection?.parts ?? [])],
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
  info: Accessor<Session | undefined>
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
  fileQuoteQuestion?: Accessor<FileQuestion | null>
  onFileQuoteClear?: (question: FileQuestion) => void
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
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

  let submitting = false
  const flights = new Set<string>()

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

  const unseed = (dir: string, id: string) => {
    const [, setStore] = globalSync.child(dir)
    setStore("session", (list: Session[]) => list.filter((item) => item.id !== id))
  }

  const fetchReadingContextPages = async (
    input: {
      sessionID: string
      startPage: number
      endPage?: number
      range: 0 | 1 | 2
      totalPages?: number
    },
    connection: { url: string; headers: Record<string, string> },
  ) => {
    const { startPage, endPage } = resolveReadingContextRange(input)
    const response = await fetch(`${connection.url}/reading-mode/page-text`, {
      method: "POST",
      headers: connection.headers,
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

  const fetchReadingContextPdf = async (
    input: {
      sessionID: string
      startPage: number
      endPage?: number
      range: 0 | 1 | 2
      totalPages?: number
    },
    connection: { url: string; headers: Record<string, string> },
  ) => {
    const { startPage, endPage } = resolveReadingContextRange(input)
    const response = await fetch(`${connection.url}/reading-mode/page-pdf`, {
      method: "POST",
      headers: connection.headers,
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

    const scope = { dir: params.dir!, id: params.id }
    const connection = {
      url: sdk.url,
      server: server.current?.http.url,
      headers: buildAuthHeaders({ ...server.current?.http, json: true }),
    }
    const refs = cloneReferences(prompt.references.items(scope))
    const context = prompt.context
      .items(scope)
      .map((item) => ({ ...item, selection: item.selection ? { ...item.selection } : undefined }))
    const question = input.fileQuoteQuestion?.()
    const fileQuote = question && question.sessionID === scope.id ? { ...question } : undefined
    const currentPrompt = clonePromptParts(prompt.current(scope))
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()
    const queued = mode === "normal" && !!input.shouldQueue?.()

    if (mode === "normal" && refs.length && (!canAsk(text, refs) || missingImages(refs))) {
      showToast({
        title: language.t("common.requestFailed"),
        description: language.t(missingImages(refs) ? "ask.send.missingImage" : "ask.send.questionRequired"),
      })
      return
    }
    if (
      text.trim().length === 0 &&
      images.length === 0 &&
      input.commentCount() === 0 &&
      (mode !== "normal" || !refs.some((ref) => ref.question.trim()))
    ) {
      return
    }

    const key = JSON.stringify(scope)
    if (flights.has(key)) return
    flights.add(key)
    try {
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
      const isNewSession = !scope.id
      const worktreeSelection = input.newSessionWorktree?.() || "main"
      const existing = input.info()

      let sessionDirectory = projectDirectory
      let client = sdk.client

      if (isNewSession) {
        if (submitting) return
        submitting = true
        try {
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

            if (server.current?.http.url !== connection.server) return
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
        } finally {
          submitting = false
        }
      }

      let session = existing
      let claimed: Promise<Session | undefined> | undefined

      if (!session && isNewSession) {
        const sessionID = Identifier.descending("session")
        const info: Session = {
          id: sessionID,
          slug: "",
          projectID: globalSync.child(sessionDirectory)[0].project,
          directory: sessionDirectory,
          title: `New session - ${new Date().toISOString()}`,
          version: "",
          time: { created: Date.now(), updated: Date.now() },
        }
        seed(sessionDirectory, info)
        session = info
        local.session.promote(sessionDirectory, sessionID)
        if (params.dir === scope.dir && params.id === scope.id && server.current?.http.url === connection.server) {
          navigate(`/${base64Encode(sessionDirectory)}/session/${sessionID}`)
        }

        claimed = claimSession(sessionID, () =>
          client.session.create({ id: sessionID }).then((x) => x.data ?? undefined),
        )
      }

      if (!session) {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: language.t("prompt.toast.promptSendFailed.description"),
        })
        return
      }

      // Existing sessions must be prompted in their own directory's instance, not
      // whichever workspace the user is currently viewing. Otherwise the server
      // binds the run (busy status, tool cwd) to the wrong workspace.
      if (!isNewSession && session.directory !== projectDirectory) {
        client = sdk.createClient({ directory: session.directory, throwOnError: true })
      }

      const recover = () => {
        if (!isNewSession || server.current?.http.url !== connection.server) return
        const target = { dir: base64Encode(sessionDirectory), id: session.id }
        if (params.dir !== target.dir || params.id !== target.id) return
        if (prompt.current(target).some((part) => part.type !== "text" || part.content.length > 0)) return
        if (prompt.references.items(target).length || prompt.context.items(target).length) return
        if (input.fileQuoteQuestion?.()?.sessionID === target.id) return
        navigate(`/${scope.dir}/session`, { replace: true })
      }

      const waitForSession = async () => {
        if (server.current?.http.url !== connection.server) return false
        if (!claimed) return true
        let created: Session | undefined
        try {
          created = await claimed
        } catch (err) {
          if (server.current?.http.url !== connection.server) return false
          unseed(sessionDirectory, session.id)
          recover()
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return false
        }
        if (server.current?.http.url !== connection.server) return false
        if (!created) {
          unseed(sessionDirectory, session.id)
          recover()
          return false
        }
        if (created.id !== session.id) {
          unseed(sessionDirectory, session.id)
          if (
            params.dir === base64Encode(sessionDirectory) &&
            params.id === session.id &&
            server.current?.http.url === connection.server
          ) {
            navigate(`/${base64Encode(sessionDirectory)}/session/${created.id}`, { replace: true })
          }
          Object.assign(session, created)
          draft.sessionID = created.id
        }
        seed(sessionDirectory, created)
        if (isNewSession) knowledge.rekey(NEW_SESSION_KEY, session.id)
        if (isNewSession) {
          permission.setMode(session.id, sessionDirectory, permission.effectiveMode(undefined, projectDirectory))
        }
        return true
      }

      const model = {
        modelID: currentModel.id,
        providerID: currentModel.provider.id,
      }
      const agent = currentAgent.name
      const openPaths = input.openTabPaths?.() ?? []
      const selText = fileCtx.selectedText()
      const draft: FollowupDraft = {
        sessionID: session.id,
        sessionDirectory,
        prompt: currentPrompt,
        context,
        agent,
        model,
        variant,
        selectedPaths: openPaths.length > 0 ? openPaths : undefined,
        pdfSelectedText: refs.length ? undefined : selText || undefined,
        references: refs,
        fileQuote,
      }

      const clearInput = () => {
        if (server.current?.http.url !== connection.server) return
        prompt.reset(scope)
        if (params.dir !== scope.dir || params.id !== scope.id) return
        input.setMode("normal")
        input.setPopover(null)
      }

      const restoreInput = () => {
        if (server.current?.http.url !== connection.server) return
        if (prompt.current(scope).some((part) => part.type !== "text" || part.content.trim())) return
        prompt.set(currentPrompt, input.promptLength(currentPrompt), scope)
        if (params.dir !== scope.dir || params.id !== scope.id) return
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

      if (mode === "shell") {
        if (!(await waitForSession())) return
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
            recover()
          })
        return
      }

      if (!refs.length && !fileQuote && text.startsWith("/")) {
        const [cmdName, ...args] = text.split(" ")
        const commandName = cmdName.slice(1)
        const customCommand = sync.data.command.find((c) => c.name === commandName)
        if (customCommand) {
          if (!(await waitForSession())) return
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
              recover()
            })
          return
        }
      }

      const messageID = Identifier.ascending("message")

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

      const kbKey = isNewSession ? NEW_SESSION_KEY : session.id
      const activeKbs = knowledge.activeKnowledgeBases(kbKey)
      const knowledgeBase =
        activeKbs.length > 0
          ? {
              paths: activeKbs.map((kb) => kb.path),
              apiKey: activeKbs[0]!.apiKey,
              baseURL: activeKbs[0]!.baseURL,
            }
          : undefined

      const consume = () => {
        if (server.current?.http.url !== connection.server) return
        prompt.references.clear(refs, scope)
        for (const item of context) {
          const current = prompt.context.items(scope).find((value) => value.key === item.key)
          if (current && JSON.stringify(current) === JSON.stringify(item)) prompt.context.remove(item.key, scope)
        }
        if (JSON.stringify(prompt.current(scope)) === JSON.stringify(currentPrompt)) clearInput()
        if (fileQuote) input.onFileQuoteClear?.(fileQuote)
      }

      try {
        if (!(await waitForSession())) return
        const ranges = referenceRanges(refs)
        draft.sources = await Promise.all(
          ranges.map(async (range) => {
            const check = async () => {
              const source = (await client.session.get({ sessionID: range.sessionID })).data?.readingMode
              if (!source || source.pdfStorePath !== range.path)
                throw new Error(language.t("ask.send.sourceUnavailable"))
            }
            await check()
            const context = { ...range, range: 0 as const }
            const [pages, pdf] = await Promise.all([
              fetchReadingContextPages(context, connection),
              fetchReadingContextPdf(context, connection),
            ])
            await check()
            return {
              ...range,
              text: pages.combinedText,
              attachment: {
                filename: `${range.filename.replace(/\.pdf$/i, "")}-pages-${range.startPage}-${range.endPage}.pdf`,
                mime: "application/pdf",
                dataUrl: await blobToDataUrl(pdf.blob),
              },
            }
          }),
        )
        if (!isNewSession && queued && input.onQueue) {
          input.onQueue(draft)
          consume()
          return
        }
        promptProbe.submit({ sessionID: session.id, directory: sessionDirectory })
        input.onSubmit?.()
        const ok = await sendFollowupDraft({
          client,
          sync,
          globalSync,
          draft,
          messageID,
          optimisticBusy: sessionDirectory === projectDirectory,
          before: waitForWorktree,
          knowledgeBase,
        })
        if (ok) consume()
        if (!ok) recover()
      } catch (err) {
        pending.delete(session.id)
        recover()
        showToast({ title: language.t("prompt.toast.promptSendFailed.title"), description: errorMessage(err) })
      }
    } finally {
      flights.delete(key)
    }
  }

  return {
    abort,
    handleSubmit,
  }
}
