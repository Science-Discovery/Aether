import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { type Component, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useQuickReadingMode } from "@/context/quick-reading-mode"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { formatServerError } from "@/utils/server-errors"

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

function blobToDataUrl(blob: Blob, mime: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => reject(reader.error ?? new Error("failed to read blob")))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      if (idx === -1) {
        resolve(value)
        return
      }
      resolve(`data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(blob)
  })
}

async function describeUnexpectedPdfResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "unknown"
  const body = await response.text().catch(() => "")
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 160)
  return {
    contentType,
    snippet,
  }
}

function buildFirstReadPrompt(input: {
  prompt: string
  startPage: number
  endPage: number
}) {
  return [
    input.prompt,
    "",
    "You are performing the quick reading mode pre-read for the user.",
    `The attached PDF contains pages ${input.startPage}-${input.endPage} from the user's current document.`,
    "Only use the attached PDF in this message as your source.",
    "Do not call tools. Do not search the workspace. Do not look for the original PDF file.",
    "Please read this excerpt first and summarize its main content, overall structure, and core viewpoints.",
    "Prepare to answer the user's follow-up questions based on your understanding of this excerpt.",
  ].join("\n")
}

function firstReadLabel(locale: string, key: string, params?: Record<string, string | number>) {
  const zh = locale === "zh" || locale === "zht"
  switch (key) {
    case "title":
      return zh ? "AI 预读" : "AI Pre-read"
    case "small":
      return zh
        ? `这份 PDF 共 ${params?.total ?? ""} 页，是否让 AI 先预读并生成总结？`
        : `This PDF has ${params?.total ?? ""} pages. Start AI pre-reading now?`
    case "large":
      return zh
        ? `这份 PDF 共 ${params?.total ?? ""} 页。请选择一个连续页范围，再发送给 AI 进行预读。单次预读最多支持 30 页。`
        : `This PDF has ${params?.total ?? ""} pages. Choose a continuous page range before sending it for AI pre-reading. A single pre-read supports at most 30 pages.`
    case "start":
      return zh ? "起始页" : "Start page"
    case "end":
      return zh ? "结束页" : "End page"
    case "invalid":
      return zh ? "请输入有效的页码范围。" : "Enter a valid page range."
    case "order":
      return zh ? "起始页不能大于结束页。" : "Start page cannot be greater than end page."
    case "bounds":
      return zh ? `页码范围必须在 1-${params?.total ?? ""} 之间。` : `Page range must stay within 1-${params?.total ?? ""}.`
    case "limit":
      return zh ? "单次预读最多支持 30 页。" : "A single pre-read supports at most 30 pages."
    case "cancel":
      return zh ? "跳过本次" : "Skip this time"
    case "submit":
      return zh ? "开始预读" : "Start pre-read"
    case "submitting":
      return zh ? "准备中..." : "Preparing..."
    case "timeline":
      return zh ? `开始预读第 ${params?.start ?? ""}-${params?.end ?? ""} 页` : `Start pre-reading pages ${params?.start ?? ""}-${params?.end ?? ""}`
    case "preparing":
      return zh ? "正在准备预读..." : "Preparing pre-read..."
  }
  return key
}

const QuickReadingFirstReadDialog: Component<{
  sessionID: string
  pdfPath: string
  pdfFileName: string
  totalPages: number
  onQueued: () => void
  onDismiss: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const quickReading = useQuickReadingMode()

  const largeDocument = createMemo(() => props.totalPages > 30)
  const defaultEndPage = createMemo(() => Math.min(props.totalPages, 30))
  const locale = () => language.locale()

  const [startPage, setStartPage] = createSignal(1)
  const [endPage, setEndPage] = createSignal(defaultEndPage())
  const [error, setError] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  const [largeRangeConfirmOpen, setLargeRangeConfirmOpen] = createSignal(false)
  let resolved = false

  createEffect(() => {
    setStartPage(1)
    setEndPage(defaultEndPage())
    setError(null)
    setLargeRangeConfirmOpen(false)
  })

  createEffect(() => {
    startPage()
    endPage()
    setLargeRangeConfirmOpen(false)
  })

  const rangeError = createMemo(() => {
    const start = largeDocument() ? startPage() : 1
    const end = largeDocument() ? endPage() : props.totalPages
    if (!Number.isInteger(start) || !Number.isInteger(end)) return firstReadLabel(locale(), "invalid")
    if (start < 1 || end < 1) return firstReadLabel(locale(), "invalid")
    if (start > end) return firstReadLabel(locale(), "order")
    if (end > props.totalPages) return firstReadLabel(locale(), "bounds", { total: props.totalPages })
    return undefined
  })

  const selectedRangePages = createMemo(() => {
    const start = largeDocument() ? startPage() : 1
    const end = largeDocument() ? endPage() : props.totalPages
    if (!Number.isInteger(start) || !Number.isInteger(end)) return 0
    return Math.max(0, end - start + 1)
  })

  const requiresLargeRangeConfirm = createMemo(() => selectedRangePages() > 30)

  const fetchPagePdf = async (start: number, end: number) => {
    const http = server.current?.http
    const response = await fetch(
      `${sdk.url}/reading-mode/page-pdf-from-file?directory=${encodeURIComponent(sdk.directory)}`,
      {
      method: "POST",
      headers: buildAuthHeaders({ username: http?.username, password: http?.password, json: true }),
      body: JSON.stringify({
        path: props.pdfPath,
        startPage: start,
        endPage: end,
      }),
      },
    )
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `HTTP ${response.status}`)
    }
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.toLowerCase().includes("application/pdf")) {
      const detail = await describeUnexpectedPdfResponse(response)
      throw new Error(
        `expected application/pdf from /reading-mode/page-pdf-from-file, received ${detail.contentType}${detail.snippet ? `: ${detail.snippet}` : ""}`,
      )
    }
    const blob = await response.blob()
    if (!blob.type.toLowerCase().includes("application/pdf")) {
      throw new Error(`expected PDF blob, received ${blob.type || "unknown"}`)
    }
    return blob
  }

  const queuePreRead = async () => {
    if (sending()) return

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const start = largeDocument() ? startPage() : 1
    const end = largeDocument() ? endPage() : props.totalPages
    const validation = rangeError()
    if (validation) {
      setError(validation)
      return
    }

    setSending(true)
    setError(null)
    resolved = true
    dialog.close()
    showToast({ title: firstReadLabel(locale(), "preparing") })

    try {
      const pdfBlob = await fetchPagePdf(start, end)
      const pdfDataUrl = await blobToDataUrl(pdfBlob, "application/pdf")
      const messageID = Identifier.ascending("message")
      const baseName = props.pdfFileName.replace(/\.pdf$/i, "") || "document"
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
            text: firstReadLabel(locale(), "timeline", { start, end }),
            ignored: true,
          },
          {
            text: buildFirstReadPrompt({
              prompt: quickReading.store.snapshot.settings.firstReadPrompt,
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

      quickReading.setFirstReadCompleted(true)
      quickReading.setFirstReadDismissed(false)
      props.onQueued()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const looksLikeWrongRoute =
        message.includes("expected application/pdf from /reading-mode/page-pdf-from-file") ||
        message.includes("expected PDF blob")
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: looksLikeWrongRoute
          ? language.locale() === "zh" || language.locale() === "zht"
            ? "快速预读没有拿到 PDF 文件，而是拿到了 HTML 响应。通常说明后端还没有重启，或新接口 `/reading-mode/page-pdf-from-file` 还没生效。请先重启后端再试。"
            : "Quick pre-read received an HTML response instead of a PDF. The backend likely needs a restart, or `/reading-mode/page-pdf-from-file` is not active yet."
          : formatServerError(cause, language.t),
      })
      setSending(false)
    }
  }

  const handleStart = async () => {
    const validation = rangeError()
    if (validation) {
      setError(validation)
      return
    }
    if (requiresLargeRangeConfirm() && !largeRangeConfirmOpen()) {
      setError(null)
      setLargeRangeConfirmOpen(true)
      return
    }
    await queuePreRead()
  }

  const handleDismiss = () => {
    if (sending()) return
    quickReading.setFirstReadDismissed(true)
    resolved = true
    props.onDismiss()
    dialog.close()
  }

  onCleanup(() => {
    if (!resolved) {
      quickReading.setFirstReadDismissed(true)
      props.onDismiss()
    }
  })

  return (
    <Dialog
      title={firstReadLabel(locale(), "title")}
      size={largeDocument() ? "large" : undefined}
      fit={!largeDocument()}
      class={largeDocument() ? undefined : "w-full max-w-[560px] mx-auto"}
    >
      <div class="flex flex-col gap-4 p-4">
        {largeRangeConfirmOpen() ? (
          <>
            <p class="text-sm text-text-base">
              {language.locale() === "zh" || language.locale() === "zht"
                ? `当前将预读第 ${startPage()}-${endPage()} 页，共 ${selectedRangePages()} 页。该范围较大，可能耗时更久，是否继续？`
                : `You are about to pre-read pages ${startPage()}-${endPage()} (${selectedRangePages()} pages total). This is a large range and may take longer. Continue?`}
            </p>
            <div class="rounded bg-surface-raised-base p-3 text-sm text-text-muted">
              {language.locale() === "zh" || language.locale() === "zht"
                ? `当前 PDF 共 ${props.totalPages} 页。`
                : `This PDF has ${props.totalPages} pages in total.`}
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setLargeRangeConfirmOpen(false)} disabled={sending()}>
                {language.locale() === "zh" || language.locale() === "zht" ? "返回修改" : "Back to edit"}
              </Button>
              <Button onClick={handleStart} disabled={sending()}>
                {sending()
                  ? firstReadLabel(locale(), "submitting")
                  : language.locale() === "zh" || language.locale() === "zht"
                    ? "继续预读"
                    : "Continue pre-read"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p class="text-sm text-text-base">
              {largeDocument()
                ? firstReadLabel(locale(), "large", { total: props.totalPages })
                : firstReadLabel(locale(), "small", { total: props.totalPages })}
            </p>

            {largeDocument() && (
              <div class="grid grid-cols-2 gap-3">
                <label class="flex flex-col gap-1">
                  <span class="text-xs text-text-muted">{firstReadLabel(locale(), "start")}</span>
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
                  <span class="text-xs text-text-muted">{firstReadLabel(locale(), "end")}</span>
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
            )}

            {(error() || rangeError()) && (
              <div class="rounded bg-surface-raised-base p-2 text-sm text-red-400">{error() || rangeError()}</div>
            )}

            <div class="flex justify-end gap-2">
              <Button variant="ghost" onClick={handleDismiss} disabled={sending()}>
                {firstReadLabel(locale(), "cancel")}
              </Button>
              <Button onClick={handleStart} disabled={sending()}>
                {sending() ? firstReadLabel(locale(), "submitting") : firstReadLabel(locale(), "submit")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}

export const QuickReadingFirstReadGate: Component<{
  open: boolean
  sessionID: string
  pdfPath: string
  pdfFileName: string
  totalPages: number
  onOpenChange: (open: boolean) => void
}> = (props) => {
  const dialog = useDialog()
  const [showing, setShowing] = createSignal(false)

  createEffect(() => {
    if (props.open || !showing()) return
    setShowing(false)
    dialog.close()
  })

  createEffect(() => {
    if (!props.open || showing()) return
    setShowing(true)
    dialog.show(() => (
      <QuickReadingFirstReadDialog
        sessionID={props.sessionID}
        pdfPath={props.pdfPath}
        pdfFileName={props.pdfFileName}
        totalPages={props.totalPages}
        onQueued={() => {
          setShowing(false)
          props.onOpenChange(false)
        }}
        onDismiss={() => {
          setShowing(false)
          props.onOpenChange(false)
        }}
      />
    ))
  })

  onCleanup(() => {
    if (!showing()) return
    dialog.close()
  })

  return null
}
