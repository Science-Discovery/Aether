import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogQuickReadingSettings } from "@/components/quick-reading/dialog-quick-reading-settings"
import { DEFAULT_PROMPT } from "@/context/prompt"
import { useFile } from "@/context/file"
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

type Options = {
  activeFilePath: Accessor<string | undefined>
}

const isPdfPath = (path?: string) => !!path && path.split(".").pop()?.toLowerCase() === "pdf"

export function useQuickReadingController(options: Options) {
  const file = useFile()
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const local = useLocal()
  const quickReading = useQuickReadingMode()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()
  const { params, view } = useSessionLayout()
  const [firstReadOpen, setFirstReadOpen] = createSignal(false)

  const quickReadingPdfPath = createMemo(() => view().quickReading.pdfPath())

  const closeQuickReading = () => {
    setFirstReadOpen(false)
    quickReading.unbind()
    view().quickReading.close()
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const focusPromptInput = () => {
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-component="prompt-input"]')
      if (!(el instanceof HTMLElement)) return
      el.focus()
    })
  }

  const validateSendContext = () => {
    const sessionID = params.id
    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!sessionID || !currentModel || !currentAgent) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    return {
      sessionID,
      model: {
        providerID: currentModel.provider.id,
        modelID: currentModel.id,
      },
      agent: currentAgent.name,
      variant: local.model.variant.current(),
    }
  }

  const sendQuickReadingTranslate = async (input: {
    page: number
    extraTextParts: FollowupDraft["extraTextParts"]
    attachments?: FollowupDraft["attachments"]
  }) => {
    const sendContext = validateSendContext()
    if (!sendContext) return

    const draft: FollowupDraft = {
      sessionID: sendContext.sessionID,
      sessionDirectory: sdk.directory,
      prompt: DEFAULT_PROMPT,
      attachments: input.attachments,
      context: [],
      agent: sendContext.agent,
      model: sendContext.model,
      variant: sendContext.variant,
      extraTextParts: input.extraTextParts,
    }

    await sendFollowupDraft({
      client: sdk.client,
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

  const handleTextSelectionAction = async (input: {
    action: "copy" | "translate" | "ask"
    startPage: number
    endPage: number
    text: string
  }) => {
    const text = input.text.trim()
    if (!text) return
    const binding = quickReading.store.binding
    if (!binding) return
    if (input.action === "ask") {
      const sessionID = params.id
      if (!sessionID) return
      quickReading.setPendingQuestion({
        kind: "text-question",
        sessionID,
        pdfPath: binding.pdfPath,
        pdfFileName: binding.pdfFileName,
        startPage: input.startPage,
        endPage: input.endPage,
        text,
        createdAt: Date.now(),
      })
      focusPromptInput()
      return
    }

    if (input.action !== "translate") return

    const settings = quickReading.store.snapshot.settings
    const label =
      input.endPage > input.startPage
        ? `pages ${input.startPage}-${input.endPage}`
        : `page ${input.startPage}`
    await sendQuickReadingTranslate({
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
          }),
        },
      ],
    })
  }

  const handleImageSelectionAction = async (input: { action: "copy" | "translate" | "ask"; page: number; imageDataUrl: string }) => {
    if (!input.imageDataUrl) return
    const binding = quickReading.store.binding
    if (!binding) return
    if (input.action === "ask") {
      const sessionID = params.id
      if (!sessionID) return
      quickReading.setPendingQuestion({
        kind: "image-question",
        sessionID,
        pdfPath: binding.pdfPath,
        pdfFileName: binding.pdfFileName,
        page: input.page,
        text: `Captured region from ${binding.pdfFileName}, page ${input.page}`,
        imageDataUrl: input.imageDataUrl,
        createdAt: Date.now(),
      })
      focusPromptInput()
      return
    }

    if (input.action !== "translate") return

    const settings = quickReading.store.snapshot.settings
    await sendQuickReadingTranslate({
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
      ],
    })
  }

  createEffect(() => {
    const sessionID = params.id
    const active = view().quickReading.active()
    const pdfPath = view().quickReading.pdfPath()
    const pdfFileName = view().quickReading.pdfFileName()
    if (!sessionID || !active || !pdfPath || !pdfFileName) {
      if (quickReading.store.binding) quickReading.unbind()
      return
    }
    const binding = quickReading.store.binding
    if (binding && binding.sessionID === sessionID && binding.pdfPath === pdfPath && binding.pdfFileName === pdfFileName) {
      return
    }
    quickReading.bind(sessionID, pdfPath, pdfFileName)
  })

  const active = createMemo(() => {
    const boundPath = quickReadingPdfPath()
    return !!params.id && view().quickReading.active() && !!boundPath && options.activeFilePath() === boundPath && isPdfPath(boundPath)
  })
  const layoutSwapped = createMemo(() => quickReading.store.snapshot.layoutSwapped)
  const page = createMemo(() => quickReading.store.view.page)
  const location = createMemo(() => quickReading.store.view.location)
  const pdfUrl = createMemo(() => {
    const boundPath = quickReadingPdfPath()
    if (!boundPath) return ""
    return `${sdk.url}/file/raw?path=${encodeURIComponent(boundPath)}&directory=${encodeURIComponent(sdk.directory)}`
  })
  const authHeader = createMemo(() => {
    const http = server.current?.http
    if (!http?.password) return undefined
    return `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
  })

  createEffect(() => {
    if (!view().quickReading.active()) return
    const boundPath = quickReadingPdfPath()
    if (!boundPath) {
      closeQuickReading()
      return
    }
    const currentPath = options.activeFilePath()
    if (!currentPath || currentPath !== boundPath) closeQuickReading()
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
