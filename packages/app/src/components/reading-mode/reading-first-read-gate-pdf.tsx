import { type Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { type Component, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { DialogPreReadLimit } from "@/components/dialog-pre-read-limit"
import { sendFollowupDraft, type FollowupDraft } from "@/components/prompt-input/submit"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useReadingMode } from "@/context/reading-mode"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { upsertSessionList } from "@/utils/session-store"
import { formatServerError } from "@/utils/server-errors"

const promptedSessions = new Set<string>()
const PRE_READ_LIMIT = 50

function mergeSession(sync: ReturnType<typeof useSync>, sessionID: string, next: Session | undefined) {
  if (!next) return
  sync.set("session", (items: Session[]) => upsertSessionList(items, next))
}

function buildAuthHeaders(input: {
  username?: string
  password?: string
  json?: boolean
}) {
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

function buildFirstReadPrompt(input: {
  prompt: string
  startPage: number
  endPage: number
}) {
  return [
    input.prompt,
    "",
    "You are performing the reading mode initial pre-read for the user.",
    `The attached PDF contains pages ${input.startPage}-${input.endPage} from the user's reading document.`,
    "Only use the attached PDF in this message as your source.",
    "Do not call any tools. Do not search the workspace. Do not look for the original PDF. Do not guess from filenames or paths.",
    "If you cannot read the attached PDF, say clearly that you cannot read the current PDF attachment and stop. Do not try any fallback behavior.",
    "Please read this excerpt first and summarize its main content, overall structure, and core viewpoints.",
    "Prepare to answer the user's follow-up questions based on your understanding of this excerpt.",
  ].join("\n")
}

function firstReadLabel(
  language: ReturnType<typeof useLanguage>,
  key: string,
  params?: Record<string, string | number>,
) {
  const zh = language.locale() === "zh" || language.locale() === "zht"
  switch (key) {
    case "reading.firstRead.title":
      return zh ? "AI \u9884\u8bfb" : "AI Pre-read"
    case "reading.firstRead.message.small":
    case "reading.firstRead.message.large":
      return zh
        ? `\u8fd9\u4efd PDF \u5171 ${params?.total ?? ""} \u9875\u3002\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u8fde\u7eed\u9875\u8303\u56f4\uff0c\u518d\u53d1\u9001\u7ed9 AI \u8fdb\u884c\u9884\u8bfb\u3002\u9ed8\u8ba4\u5efa\u8bae\u5355\u6b21\u4e0d\u8d85\u8fc7 ${params?.limit ?? PRE_READ_LIMIT} \u9875\u3002`
        : `This PDF has ${params?.total ?? ""} pages. Choose a continuous page range before sending it for AI pre-reading. The recommended limit is ${params?.limit ?? PRE_READ_LIMIT} pages per run.`
    case "reading.firstRead.range.start":
      return zh ? "\u8d77\u59cb\u9875" : "Start page"
    case "reading.firstRead.range.end":
      return zh ? "\u7ed3\u675f\u9875" : "End page"
    case "reading.firstRead.range.invalid":
      return zh ? "\u8bf7\u8f93\u5165\u6709\u6548\u7684\u9875\u7801\u8303\u56f4\u3002" : "Enter a valid page range."
    case "reading.firstRead.range.order":
      return zh ? "\u8d77\u59cb\u9875\u4e0d\u80fd\u5927\u4e8e\u7ed3\u675f\u9875\u3002" : "Start page cannot be greater than end page."
    case "reading.firstRead.range.bounds":
      return zh
        ? `\u9875\u7801\u8303\u56f4\u5fc5\u987b\u5728 1-${params?.total ?? ""} \u4e4b\u95f4\u3002`
        : `Page range must stay within 1-${params?.total ?? ""}.`
    case "reading.firstRead.confirm":
      return zh
        ? `\u5f53\u524d\u9009\u62e9\u5171 ${params?.count ?? ""} \u9875\uff0c\u8d85\u8fc7\u5efa\u8bae\u7684 ${params?.limit ?? PRE_READ_LIMIT} \u9875\uff0c\u9884\u8bfb\u53ef\u80fd\u66f4\u6162\u4e14\u6548\u679c\u4e0d\u7a33\u5b9a\u3002\u662f\u5426\u7ee7\u7eed\uff1f`
        : `You selected ${params?.count ?? ""} pages, which exceeds the recommended ${params?.limit ?? PRE_READ_LIMIT}-page limit. Pre-read may be slower and less reliable. Continue?`
    case "reading.firstRead.confirmTitle":
      return zh ? "\u786e\u8ba4\u9884\u8bfb\u8303\u56f4" : "Confirm pre-read range"
    case "reading.firstRead.start":
      return zh ? "\u5f00\u59cb\u9884\u8bfb" : "Start pre-read"
    case "reading.firstRead.starting":
      return zh ? "\u51c6\u5907\u4e2d..." : "Preparing..."
    case "reading.firstRead.timeline":
      return zh
        ? `\u5f00\u59cb\u9884\u8bfb\u7b2c ${params?.start ?? ""}-${params?.end ?? ""} \u9875`
        : `Start pre-reading pages ${params?.start ?? ""}-${params?.end ?? ""}`
    case "reading.firstRead.unsupportedPdf":
      return zh
        ? "\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301 PDF \u8f93\u5165\uff0c\u8bf7\u5207\u6362\u5230\u652f\u6301 PDF \u7684\u6a21\u578b\u3002"
        : "The current model does not support PDF input. Switch to a PDF-capable model."
    case "reading.firstRead.preparing":
      return zh ? "\u6b63\u5728\u51c6\u5907\u9884\u8bfb..." : "Preparing pre-read..."
    case "reading.firstRead.continue":
      return zh ? "\u7ee7\u7eed\u9884\u8bfb" : "Continue"
  }
  return language.t(key as never, params as never)
}

const ReadingFirstReadDialog: Component<{
  sessionID: string
  totalPages: number
  onQueued: (messageID: string) => void
  onDismiss: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const server = useServer()
  const rm = useReadingMode()

  const meta = createMemo(() => sync.session.get(props.sessionID)?.readingMode ?? rm.store.sessionMeta ?? null)
  const defaultEndPage = createMemo(() => Math.min(props.totalPages, PRE_READ_LIMIT))

  const [startPage, setStartPage] = createSignal(1)
  const [endPage, setEndPage] = createSignal(defaultEndPage())
  const [error, setError] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  let resolved = false

  createEffect(() => {
    setStartPage(1)
    setEndPage(defaultEndPage())
    setError(null)
  })

  const rangeError = createMemo(() => {
    const start = startPage()
    const end = endPage()
    if (!Number.isInteger(start) || !Number.isInteger(end)) return firstReadLabel(language, "reading.firstRead.range.invalid")
    if (start < 1 || end < 1) return firstReadLabel(language, "reading.firstRead.range.invalid")
    if (start > end) return firstReadLabel(language, "reading.firstRead.range.order")
    if (end > props.totalPages) {
      return firstReadLabel(language, "reading.firstRead.range.bounds", { total: props.totalPages })
    }
    return undefined
  })

  const fetchPagePdf = async (start: number, end: number) => {
    const http = server.current?.http
    const response = await fetch(`${sdk.url}/reading-mode/page-pdf`, {
      method: "POST",
      headers: buildAuthHeaders({ username: http?.username, password: http?.password, json: true }),
      body: JSON.stringify({
        sessionID: props.sessionID,
        startPage: start,
        endPage: end,
      }),
    })
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `HTTP ${response.status}`)
    }
    return response.blob()
  }

  const queue = async (start: number, end: number) => {
    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    const sessionMeta = meta()
    if (!currentModel || !currentAgent || !sessionMeta) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    setSending(true)
    setError(null)
    resolved = true
    dialog.close()
    showToast({ title: firstReadLabel(language, "reading.firstRead.preparing") })

    try {
      const pdfBlob = await fetchPagePdf(start, end)
      const pdfDataUrl = await blobToDataUrl(pdfBlob)
      const messageID = Identifier.ascending("message")
      const baseName = sessionMeta.pdfFileName.replace(/\.pdf$/i, "") || "document"
      const draft: FollowupDraft = {
        sessionID: props.sessionID,
        sessionDirectory: sdk.directory,
        prompt: [{ type: "text", content: "", start: 0, end: 0 }],
        attachments: [
          {
            filename: `${baseName}-pages-${start}-${end}.pdf`,
            mime: "application/pdf",
            dataUrl: pdfDataUrl,
          },
        ],
        extraTextParts: [
          {
            text: firstReadLabel(language, "reading.firstRead.timeline", { start, end }),
            ignored: true,
          },
          {
            text: buildFirstReadPrompt({
              prompt: sessionMeta.settings.firstReadPrompt,
              startPage: start,
              endPage: end,
            }),
            synthetic: true,
          },
        ],
        context: [],
        agent: currentAgent.name,
        model: {
          providerID: currentModel.provider.id,
          modelID: currentModel.id,
        },
        variant,
      }

      const ok = await sendFollowupDraft({
        client: sdk.client,
        sync,
        globalSync,
        draft,
        messageID,
        optimisticBusy: true,
      })
      if (!ok) return

      props.onQueued(messageID)
    } catch (cause) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(cause, language.t),
      })
    }
  }

  const handleStart = async () => {
    if (sending()) return
    const start = startPage()
    const end = endPage()
    const validation = rangeError()
    if (validation) {
      setError(validation)
      return
    }
    const count = end - start + 1
    if (count > PRE_READ_LIMIT) {
      dialog.show(() => (
        <DialogPreReadLimit
          title={firstReadLabel(language, "reading.firstRead.confirmTitle")}
          description={firstReadLabel(language, "reading.firstRead.confirm", { count, limit: PRE_READ_LIMIT })}
          cancel={language.t("common.cancel")}
          confirm={firstReadLabel(language, "reading.firstRead.continue")}
          onConfirm={() => void queue(start, end)}
        />
      ))
      return
    }
    await queue(start, end)
  }

  const handleDismiss = () => {
    if (sending()) return
    resolved = true
    props.onDismiss()
    dialog.close()
  }

  onCleanup(() => {
    if (!resolved) {
      props.onDismiss()
    }
  })

  return (
    <Dialog
      title={firstReadLabel(language, "reading.firstRead.title")}
      size="large"
      fit={false}
      class="w-full max-w-[560px] mx-auto"
    >
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          {firstReadLabel(language, "reading.firstRead.message.large", { total: props.totalPages, limit: PRE_READ_LIMIT })}
        </p>

        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-text-muted">{firstReadLabel(language, "reading.firstRead.range.start")}</span>
            <input
              type="number"
              min={1}
              max={props.totalPages}
              value={startPage()}
              onInput={(event) => setStartPage(event.currentTarget.valueAsNumber || 0)}
              class="rounded border border-border-base bg-surface-raised-base px-3 py-2 text-sm text-text-base focus:outline-none"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-text-muted">{firstReadLabel(language, "reading.firstRead.range.end")}</span>
            <input
              type="number"
              min={1}
              max={props.totalPages}
              value={endPage()}
              onInput={(event) => setEndPage(event.currentTarget.valueAsNumber || 0)}
              class="rounded border border-border-base bg-surface-raised-base px-3 py-2 text-sm text-text-base focus:outline-none"
            />
          </label>
        </div>

        {(error() || rangeError()) && (
          <div class="rounded bg-surface-raised-base p-2 text-sm text-red-400">{error() || rangeError()}</div>
        )}

        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleDismiss} disabled={sending()}>
            {language.t("common.cancel")}
          </Button>
          <Button onClick={handleStart} disabled={sending()}>
            {sending()
              ? firstReadLabel(language, "reading.firstRead.starting")
              : firstReadLabel(language, "reading.firstRead.start")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const ReadingFirstReadGate: Component<{ sessionID: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const server = useServer()
  const rm = useReadingMode()

  const [pendingMessageID, setPendingMessageID] = createSignal<string>()
  const [patching, setPatching] = createSignal(false)

  const session = createMemo(() => sync.session.get(props.sessionID))
  const meta = createMemo(() => session()?.readingMode ?? rm.store.sessionMeta ?? null)
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const status = createMemo(() => sync.data.session_status[props.sessionID] ?? { type: "idle" as const })
  const busy = createMemo(() => {
    if (status().type !== "idle") return true
    return messages().some((item) => item.role === "assistant" && typeof item.time.completed !== "number")
  })

  const markCompleted = async () => {
    const http = server.current?.http
    const response = await fetch(`${sdk.url}/reading-mode/session/${encodeURIComponent(props.sessionID)}`, {
      method: "PATCH",
      headers: buildAuthHeaders({ username: http?.username, password: http?.password, json: true }),
      body: JSON.stringify({ firstReadCompleted: true }),
    })
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `HTTP ${response.status}`)
    }
    return (await response.json()) as Session
  }

  const markDismissed = async () => {
    const http = server.current?.http
    const response = await fetch(`${sdk.url}/reading-mode/session/${encodeURIComponent(props.sessionID)}`, {
      method: "PATCH",
      headers: buildAuthHeaders({ username: http?.username, password: http?.password, json: true }),
      body: JSON.stringify({ firstReadDismissed: true }),
    })
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `HTTP ${response.status}`)
    }
    return (await response.json()) as Session
  }

  const handleDismiss = () => {
    promptedSessions.add(props.sessionID)
    void markDismissed()
      .then((next) => {
        mergeSession(sync, props.sessionID, next)
      })
      .catch((cause) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(cause, language.t),
        })
      })
  }

  createEffect(() => {
    const sessionMeta = meta()
    if (!sessionMeta) return
    if (promptedSessions.has(props.sessionID)) return
    if (pendingMessageID()) return
    if (rm.store.totalPages <= 0) return
    if (busy()) return
    if (sessionMeta.firstReadCompleted) return
    if (sessionMeta.firstReadDismissed) return
    if (!sessionMeta.settings.autoFirstRead) return

    promptedSessions.add(props.sessionID)
    dialog.show(() => (
      <ReadingFirstReadDialog
        sessionID={props.sessionID}
        totalPages={rm.store.totalPages}
        onQueued={(messageID) => setPendingMessageID(messageID)}
        onDismiss={handleDismiss}
      />
    ))
  })

  createEffect(() => {
    const triggerID = pendingMessageID()
    if (!triggerID || patching()) return

    const assistantDone = messages().some(
      (item) => item.role === "assistant" && item.id > triggerID && typeof item.time.completed === "number",
    )
    if (!assistantDone) return

    setPatching(true)
    void markCompleted()
      .then((next) => {
        mergeSession(sync, props.sessionID, next)
        setPendingMessageID(undefined)
      })
      .catch((cause) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(cause, language.t),
        })
      })
      .finally(() => {
        setPatching(false)
      })
  })

  return null
}
