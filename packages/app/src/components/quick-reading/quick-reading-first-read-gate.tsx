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

function auth(input: { username?: string; password?: string; json?: boolean }) {
  const headers: Record<string, string> = {}
  if (input.password) headers.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  if (input.json) headers["Content-Type"] = "application/json"
  return headers
}

function dataurl(blob: Blob, mime: string) {
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

async function describe(response: Response) {
  const contentType = response.headers.get("content-type") || "unknown"
  const body = await response.text().catch(() => "")
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 160)
  return { contentType, snippet }
}

function build(input: { prompt: string; start: number; end: number }) {
  return [
    input.prompt,
    "",
    "You are performing the quick reading mode pre-read for the user.",
    `The attached PDF contains pages ${input.start}-${input.end} from the user's current document.`,
    "Only use the attached PDF in this message as your source.",
    "Do not call tools. Do not search the workspace. Do not look for the original PDF file.",
    "Please read this excerpt first and summarize its main content, overall structure, and core viewpoints.",
    "Prepare to answer the user's follow-up questions based on your understanding of this excerpt.",
  ].join("\n")
}

function text(locale: string, key: string, params?: Record<string, string | number>) {
  const zh = locale === "zh" || locale === "zht"
  switch (key) {
    case "title": return zh ? "AI 预读" : "AI Pre-read"
    case "small": return zh ? `这份 PDF 共 ${params?.total ?? ""} 页，是否让 AI 先预读并生成总结？` : `This PDF has ${params?.total ?? ""} pages. Start AI pre-reading now?`
    case "large": return zh ? `这份 PDF 共 ${params?.total ?? ""} 页。请选择一个连续页范围，再发送给 AI 进行预读。单次预读最多支持 30 页。` : `This PDF has ${params?.total ?? ""} pages. Choose a continuous page range before sending it for AI pre-reading. A single pre-read supports at most 30 pages.`
    case "start": return zh ? "起始页" : "Start page"
    case "end": return zh ? "结束页" : "End page"
    case "invalid": return zh ? "请输入有效的页码范围。" : "Enter a valid page range."
    case "order": return zh ? "起始页不能大于结束页。" : "Start page cannot be greater than end page."
    case "bounds": return zh ? `页码范围必须在 1-${params?.total ?? ""} 之间。` : `Page range must stay within 1-${params?.total ?? ""}.`
    case "limit": return zh ? "单次预读最多支持 30 页。" : "A single pre-read supports at most 30 pages."
    case "cancel": return zh ? "跳过本次" : "Skip this time"
    case "submit": return zh ? "开始预读" : "Start pre-read"
    case "submitting": return zh ? "准备中..." : "Preparing..."
    case "timeline": return zh ? `开始预读第 ${params?.start ?? ""}-${params?.end ?? ""} 页` : `Start pre-reading pages ${params?.start ?? ""}-${params?.end ?? ""}`
    case "preparing": return zh ? "正在准备预读..." : "Preparing pre-read..."
  }
  return key
}

const Gate: Component<{
  sessionID: string
  pdfPath: string
  pdfFileName: string
  totalPages: number
  onQueued: (id: string) => void
  onDismiss: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()
  const global = useGlobalSync()
  const local = useLocal()
  const quick = useQuickReadingMode()
  const big = createMemo(() => props.totalPages > 30)
  const last = createMemo(() => Math.min(props.totalPages, 30))
  const [start, setStart] = createSignal(1)
  const [end, setEnd] = createSignal(last())
  const [error, setError] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  let closed = false

  createEffect(() => {
    setStart(1)
    setEnd(last())
    setError(null)
  })

  const issue = createMemo(() => {
    const from = big() ? start() : 1
    const to = big() ? end() : props.totalPages
    if (!Number.isInteger(from) || !Number.isInteger(to)) return text(language.locale(), "invalid")
    if (from < 1 || to < 1) return text(language.locale(), "invalid")
    if (from > to) return text(language.locale(), "order")
    if (to > props.totalPages) return text(language.locale(), "bounds", { total: props.totalPages })
    if (to - from + 1 > 30) return text(language.locale(), "limit")
    return undefined
  })

  const fetchpdf = async (start: number, end: number) => {
    const http = server.current?.http
    const response = await fetch(`${sdk.url}/reading-mode/page-pdf-from-file?directory=${encodeURIComponent(sdk.directory)}`, {
      method: "POST",
      headers: auth({ username: http?.username, password: http?.password, json: true }),
      body: JSON.stringify({ path: props.pdfPath, startPage: start, endPage: end }),
    })
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `HTTP ${response.status}`)
    }
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.toLowerCase().includes("application/pdf")) {
      const detail = await describe(response)
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

  const submit = async () => {
    if (sending()) return
    const model = local.model.current()
    const agent = local.agent.current()
    if (!model || !agent) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: language.t("prompt.toast.modelAgentRequired.description") })
      return
    }
    const from = big() ? start() : 1
    const to = big() ? end() : props.totalPages
    const err = issue()
    if (err) {
      setError(err)
      return
    }
    setSending(true)
    setError(null)
    closed = true
    dialog.close()
    showToast({ title: text(language.locale(), "preparing") })
    try {
      const blob = await fetchpdf(from, to)
      const url = await dataurl(blob, "application/pdf")
      const id = Identifier.ascending("message")
      const name = props.pdfFileName.replace(/\.pdf$/i, "") || "document"
      const draft: FollowupDraft = {
        sessionID: props.sessionID,
        sessionDirectory: sdk.directory,
        prompt: [{ type: "text", content: "", start: 0, end: 0 }],
        attachments: [{ filename: `${name}-pages-${from}-${to}.pdf`, mime: "application/pdf", dataUrl: url }],
        extraTextParts: [
          { text: text(language.locale(), "timeline", { start: from, end: to }), ignored: true },
          { text: build({ prompt: quick.store.snapshot.settings.firstReadPrompt, start: from, end: to }), synthetic: true },
        ],
        context: [],
        agent: agent.name,
        model: { providerID: model.provider.id, modelID: model.id },
        variant: local.model.variant.current(),
      }
      const ok = await sendFollowupDraft({ client: sdk.client, sync, globalSync: global, draft, messageID: id, optimisticBusy: true })
      if (!ok) return
      quick.setFirstReadDismissed(false)
      props.onQueued(id)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const wrongRoute =
        message.includes("expected application/pdf from /reading-mode/page-pdf-from-file") ||
        message.includes("expected PDF blob")
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: wrongRoute
          ? language.locale() === "zh" || language.locale() === "zht"
            ? "快速预读没有拿到 PDF 文件，而是拿到了 HTML 响应。通常说明后端还没有重启，或新接口 `/reading-mode/page-pdf-from-file` 还没生效。请先重启后端再试。"
            : "Quick pre-read received an HTML response instead of a PDF. The backend likely needs a restart, or `/reading-mode/page-pdf-from-file` is not active yet."
          : formatServerError(cause, language.t),
      })
      setSending(false)
    }
  }

  const dismiss = () => {
    if (sending()) return
    quick.setFirstReadDismissed(true)
    closed = true
    props.onDismiss()
    dialog.close()
  }

  onCleanup(() => {
    if (closed) return
    quick.setFirstReadDismissed(true)
    props.onDismiss()
  })

  return (
    <Dialog title={text(language.locale(), "title")} size={big() ? "large" : undefined} fit={!big()} class={big() ? undefined : "w-full max-w-[560px] mx-auto"}>
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">{big() ? text(language.locale(), "large", { total: props.totalPages }) : text(language.locale(), "small", { total: props.totalPages })}</p>
        {big() && (
          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="text-xs text-text-muted">{text(language.locale(), "start")}</span>
              <input type="number" min={1} max={props.totalPages} value={start()} onInput={(event) => setStart(event.currentTarget.valueAsNumber || 0)} class="rounded border border-border-base bg-surface-raised-base px-3 py-2 text-sm text-text-base focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-xs text-text-muted">{text(language.locale(), "end")}</span>
              <input type="number" min={1} max={props.totalPages} value={end()} onInput={(event) => setEnd(event.currentTarget.valueAsNumber || 0)} class="rounded border border-border-base bg-surface-raised-base px-3 py-2 text-sm text-text-base focus:outline-none" />
            </label>
          </div>
        )}
        {(error() || issue()) && <div class="rounded bg-surface-raised-base p-2 text-sm text-red-400">{error() || issue()}</div>}
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={dismiss} disabled={sending()}>{text(language.locale(), "cancel")}</Button>
          <Button onClick={submit} disabled={sending()}>{sending() ? text(language.locale(), "submitting") : text(language.locale(), "submit")}</Button>
        </div>
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
  const language = useLanguage()
  const quick = useQuickReadingMode()
  const sync = useSync()
  const [showing, setShowing] = createSignal(false)
  const [pending, setPending] = createSignal<string>()
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const status = createMemo(() => sync.data.session_status[props.sessionID] ?? { type: "idle" as const })

  createEffect(() => {
    const id = pending()
    if (!id || status().type !== "idle") return
    const done = messages().some((item) => item.role === "assistant" && item.id > id && typeof item.time.completed === "number")
    if (!done) return
    quick.setFirstReadCompleted(true)
    quick.setFirstReadDismissed(false)
    setPending(undefined)
  })

  createEffect(() => {
    if (props.open || !showing()) return
    setShowing(false)
    dialog.close()
  })

  createEffect(() => {
    if (!props.open || showing()) return
    if (props.totalPages <= 0) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: "The PDF is still loading. Try pre-read again in a moment." })
      props.onOpenChange(false)
      return
    }
    setShowing(true)
    dialog.show(() => (
      <Gate
        sessionID={props.sessionID}
        pdfPath={props.pdfPath}
        pdfFileName={props.pdfFileName}
        totalPages={props.totalPages}
        onQueued={(id) => {
          setPending(id)
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
