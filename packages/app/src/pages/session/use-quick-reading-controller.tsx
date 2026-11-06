import type { PdfTextSelection, PdfImageSelection } from "@/components/pdf-viewer-shell-official"
import { createEffect, createMemo, createSignal } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogQuickReadingSettings } from "@/components/quick-reading/dialog-quick-reading-settings"
import { DEFAULT_PROMPT, usePrompt } from "@/context/prompt"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useQuickReadingMode } from "@/context/quick-reading-mode"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { useSessionLayout } from "@/pages/session/session-layout"
import { Identifier } from "@/utils/id"
import { createReadingQuoteMetadata, summarizeReadingQuoteText } from "@/utils/comment-note"
import { formatServerError } from "@/utils/server-errors"
import { useLatexReading } from "./use-latex-reading"
import { useLatexNavigation } from "./use-latex-navigation"
import { source } from "@/utils/pdf-source"
import { usePlatform } from "@/context/platform"

type Options = Record<string, never>

const isPdfPath = (path?: string) => !!path && path.split(".").pop()?.toLowerCase() === "pdf"

export function useQuickReadingController(_options: Options) {
  const prompt = usePrompt()
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const local = useLocal()
  const quickReading = useQuickReadingMode()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()
  const navigate = useNavigate()
  const platform = usePlatform()
  const latex = useLatexReading()
  const navigation = useLatexNavigation(latex)
  const { params, view, reading } = useSessionLayout()
  const [firstReadOpen, setFirstReadOpen] = createSignal(false)

  const quickReadingPdfPath = createMemo(() => reading().pdfPath())
  const compiled = createMemo(() => !!latex.document())
  const creating = new Map<string, Promise<string | undefined>>()
  const capture = async (version: string | undefined, document: string | undefined, current: () => boolean) => {
    if (!compiled()) return { source: undefined }
    const quote = document === latex.key() ? latex.capture(version) : undefined
    if (!quote) return
    const result = await latex.reference(quote).then(
      () => true,
      (cause: unknown) => {
        if (current())
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: formatServerError(cause, language.t),
          })
        return false
      },
    )
    return result ? { source: quote } : undefined
  }

  const prepare = async (input: { version?: string; document?: string }) => {
    const bound = quickReading.store.binding
    if (!bound) return
    const binding = { ...bound }
    const settings = { ...quickReading.store.snapshot.settings }
    const totalPages = quickReading.store.snapshot.totalPages
    const scope = { dir: params.dir!, id: params.id }
    const directory = sdk.directory
    const url = sdk.url
    const client = sdk.client
    const document = latex.key()
    const selected = local.selection()
    const selection = selected && {
      ...selected,
      model: { ...selected.model },
      ...(selected.engine ? { engine: { ...selected.engine } } : {}),
    }
    const current = (id = scope.id) =>
      sdk.url === url &&
      sdk.directory === directory &&
      params.dir === scope.dir &&
      params.id === id &&
      quickReadingPdfPath() === binding.pdfPath &&
      latex.key() === document
    const captured = await capture(input.version, input.document, current)
    if (!captured || !current()) return
    const key = JSON.stringify([url, directory, scope])
    const sessionID =
      scope.id ??
      (await (() => {
        const cached = creating.get(key)
        if (cached) return cached
        const pending = client.session
          .create({ engine: selection?.engine }, { throwOnError: true })
          .then((result) => {
            if (!result.data || !current()) return
            navigate(`/${base64Encode(directory)}/session/${result.data.id}`)
            return result.data.id
          })
          .catch((cause) => {
            if (current())
              showToast({
                variant: "error",
                title: language.t("common.requestFailed"),
                description: formatServerError(cause, language.t),
              })
            return undefined
          })
          .finally(() => creating.delete(key))
        creating.set(key, pending)
        return pending
      })())
    if (!sessionID || (!current() && !current(sessionID))) return
    return {
      binding,
      settings,
      totalPages,
      source: captured.source,
      sessionID,
      scope: { dir: scope.dir, id: sessionID },
      directory,
      client,
      selection,
      current: () => current(sessionID) || (!scope.id && current()),
    }
  }

  const closeQuickReading = () => {
    setFirstReadOpen(false)
    quickReading.unbind()
    reading().close()
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const sendQuickReadingTranslate = async (input: {
    context: NonNullable<Awaited<ReturnType<typeof prepare>>>
    page: number
    extraTextParts: FollowupDraft["extraTextParts"]
    attachments?: FollowupDraft["attachments"]
  }) => {
    const selection = input.context.selection
    if (!selection) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t(
          local.native.engine() ? "native.notReady" : "prompt.toast.modelAgentRequired.description",
        ),
      })
      return
    }

    const draft: FollowupDraft = {
      sessionID: input.context.sessionID,
      sessionDirectory: input.context.directory,
      prompt: DEFAULT_PROMPT,
      attachments: input.attachments,
      context: [],
      ...selection,
      extraTextParts: input.extraTextParts,
    }

    await sendFollowupDraft({
      client: input.context.client,
      sync,
      globalSync,
      draft,
      messageID: Identifier.ascending("message"),
      optimisticBusy: true,
    }).catch((cause) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(cause, language.t),
      })
    })
  }

  const handleTextSelectionAction = async (input: PdfTextSelection) => {
    const text = input.text.trim()
    if (!text) return
    if (input.action === "copy") return
    const context = await prepare(input)
    if (!context?.current()) return
    const binding = context.binding
    if (input.action === "ask") {
      if (input.question === undefined || !input.selection) return
      prompt.references.add(
        {
          id: crypto.randomUUID(),
          version: 1,
          kind: "pdf",
          question: input.question,
          path: binding.pdfPath,
          filename: binding.pdfFileName,
          mode: "quick",
          source: context.source,
          startPage: input.startPage,
          endPage: input.endPage,
          selection: input.selection,
          fingerprint: input.fingerprint,
          content: "text",
          text,
          summary: summarizeReadingQuoteText(text),
          settings: { questionPrompt: context.settings.questionPrompt },
          totalPages: context.totalPages,
        },
        context.scope,
      )
      return
    }

    if (input.action !== "translate") return

    const settings = context.settings
    const label =
      input.endPage > input.startPage ? `pages ${input.startPage}-${input.endPage}` : `page ${input.startPage}`
    await sendQuickReadingTranslate({
      context,
      page: input.startPage,
      extraTextParts: [
        {
          text: `Translate selected text on ${label} from ${binding.pdfFileName}`,
          ignored: true,
        },
        {
          text: `${settings.translatePrompt}\n\n[Selected text]\n${text}`,
          synthetic: true,
        },
        {
          text: "",
          synthetic: true,
          ignored: true,
          metadata: createReadingQuoteMetadata({
            mode: "quick",
            action: "translate",
            contentType: "text",
            pdfFileName: binding.pdfFileName,
            startPage: input.startPage,
            endPage: input.endPage,
            summary: summarizeReadingQuoteText(text),
            fullText: text,
            source: context.source,
          }),
        },
      ],
    })
  }

  const handleImageSelectionAction = async (input: PdfImageSelection) => {
    if (!input.imageDataUrl) return
    if (input.action === "copy") return
    const context = await prepare(input)
    if (!context?.current()) return
    const binding = context.binding
    if (input.action === "ask") {
      if (input.question === undefined || !input.selection) return
      prompt.references.add(
        {
          id: crypto.randomUUID(),
          version: 1,
          kind: "pdf",
          question: input.question,
          path: binding.pdfPath,
          filename: binding.pdfFileName,
          mode: "quick",
          source: context.source,
          startPage: input.page,
          endPage: input.page,
          selection: input.selection,
          fingerprint: input.fingerprint,
          content: "image",
          image: input.imageDataUrl,
          text: "",
          summary: `${binding.pdfFileName} · ${input.page}`,
          settings: { questionPrompt: context.settings.questionPrompt },
          totalPages: context.totalPages,
        },
        context.scope,
      )
      return
    }

    if (input.action !== "translate") return

    const settings = context.settings
    await sendQuickReadingTranslate({
      context,
      page: input.page,
      attachments: [
        {
          filename: `pdf-region-page-${input.page}.png`,
          mime: "image/png",
          dataUrl: input.imageDataUrl,
        },
      ],
      extraTextParts: [
        {
          text: `Translate captured region on page ${input.page} from ${binding.pdfFileName}`,
          ignored: true,
        },
        {
          text: `${settings.translatePrompt}\n\n[Selected image]\nPlease translate the content shown in the attached image.`,
          synthetic: true,
        },
        {
          text: "",
          synthetic: true,
          ignored: true,
          metadata: createReadingQuoteMetadata({
            mode: "quick",
            action: "translate",
            contentType: "image",
            pdfFileName: binding.pdfFileName,
            startPage: input.page,
            summary: `Page ${input.page}`,
            source: context.source,
          }),
        },
      ],
    })
  }

  createEffect(() => {
    const sessionID = params.id ?? ""
    const active = reading().active()
    const pdfPath = reading().pdfPath()
    const pdfFileName = reading().pdfFileName()
    if (!active || !pdfPath || !pdfFileName) {
      if (quickReading.store.binding) quickReading.unbind()
      return
    }
    const binding = quickReading.store.binding
    if (
      binding &&
      binding.sessionID === sessionID &&
      binding.pdfPath === pdfPath &&
      binding.pdfFileName === pdfFileName
    ) {
      return
    }
    quickReading.bind(sessionID, pdfPath, pdfFileName)
  })

  const active = createMemo(() => {
    const boundPath = quickReadingPdfPath()
    return reading().active() && !!boundPath && isPdfPath(boundPath)
  })
  const layoutSwapped = createMemo(() => quickReading.store.snapshot.layoutSwapped)
  const page = createMemo(() => quickReading.store.view.page)
  const location = createMemo(() => quickReading.store.view.location)
  const pdfUrl = createMemo(() => {
    const boundPath = quickReadingPdfPath()
    if (!boundPath) return ""
    if (source(boundPath)?.kind === "latex") return latex.url()
    return `${sdk.url}/file/raw?path=${encodeURIComponent(boundPath)}&directory=${encodeURIComponent(sdk.directory)}`
  })
  const authHeader = createMemo(() => {
    const http = server.current?.http
    if (!http?.password) return undefined
    return `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
  })

  const handlePageChange = (page: number) => {
    quickReading.setPage(page)
  }

  const handleLocationChange = (location: string) => {
    quickReading.setLocation(location)
  }

  const handleDocumentInfo = ({ totalPages }: { totalPages: number }) => {
    quickReading.setTotalPages(totalPages)
  }

  const toggleLayoutSwapped = () => {
    quickReading.setLayoutSwapped(!layoutSwapped())
  }

  const pdfFileName = createMemo(() => quickReading.store.binding?.pdfFileName)
  const totalPages = createMemo(() => quickReading.store.snapshot.totalPages)

  return {
    latex,
    navigation,
    compiled,
    document: () => (compiled() ? latex.key() : undefined),
    version: () => (compiled() ? latex.state.ready : undefined),
    annotationPath: () => (compiled() ? undefined : quickReadingPdfPath()),
    download: async () => {
      const quote = latex.capture()
      if (!quote) return
      const response = await fetch(
        `${sdk.url}/latex/build/${encodeURIComponent(quote.build)}/pdf?directory=${encodeURIComponent(sdk.directory)}`,
        {
          headers: authHeader() ? { Authorization: authHeader()! } : {},
        },
      )
      if (!response.ok) throw new Error(`PDF download failed (${response.status})`)
      const blob = await response.blob()
      const name = quote.main
        .split(/[\\/]/)
        .pop()!
        .replace(/\.tex$/i, ".pdf")
      if (platform.saveFileDialog) {
        await platform.saveFileDialog({ name, data: await blob.arrayBuffer() })
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    quickReading,
    pdfPath: quickReadingPdfPath,
    active,
    page,
    location,
    layoutSwapped,
    pdfUrl,
    authHeader,
    firstReadOpen,
    setFirstReadOpen,
    closeQuickReading,
    handleTextSelectionAction,
    handleImageSelectionAction,
    handleDocumentInfo,
    handlePageChange,
    handleLocationChange,
    toggleLayoutSwapped,
    pdfFileName,
    totalPages,
    openSettings() {
      dialog.show(() => <DialogQuickReadingSettings pdfFileName={pdfFileName()} />)
    },
    openFirstRead() {
      if (totalPages() <= 0) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: "The PDF is still loading. Try pre-read again in a moment.",
        })
        return
      }
      setFirstReadOpen(true)
    },
  }
}
