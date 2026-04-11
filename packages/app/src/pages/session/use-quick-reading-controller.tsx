import { createMemo, createEffect, createSignal, type Accessor } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { DEFAULT_PROMPT } from "@/context/prompt"
import { useQuickReadingMode } from "@/context/quick-reading-mode"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { DialogQuickReadingSettings } from "@/components/quick-reading/dialog-quick-reading-settings"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { useSessionLayout } from "@/pages/session/session-layout"
import { Identifier } from "@/utils/id"
import { formatServerError } from "@/utils/server-errors"

type Options = {
  activeFilePath: Accessor<string | undefined>
}

const isPdfPath = (path?: string) => !!path && path.split(".").pop()?.toLowerCase() === "pdf"

export function useQuickReadingController(options: Options) {
  const dialog = useDialog()
  const file = useFile()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const local = useLocal()
  const quickReading = useQuickReadingMode()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()
  const { params, view } = useSessionLayout()

  const quickReadingPdfPath = createMemo(() => view().quickReading.pdfPath())
  const [quickReadingFirstReadOpen, setQuickReadingFirstReadOpen] = createSignal(false)

  const closeQuickReading = () => {
    setQuickReadingFirstReadOpen(false)
    quickReading.unbind()
    view().quickReading.close()
  }

  const focusPromptInput = () => {
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-component="prompt-input"]')
      if (!(el instanceof HTMLElement)) return
      el.focus()
    })
  }

  const validateQuickReadingSendContext = () => {
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
    const sendContext = validateQuickReadingSendContext()
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
    page: number
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
        page: input.page,
        text,
        createdAt: Date.now(),
      })
      focusPromptInput()
      return
    }

    if (input.action !== "translate") return

    const settings = quickReading.store.snapshot.settings
    await sendQuickReadingTranslate({
      page: input.page,
      extraTextParts: [
        {
          text: `Translate selected text on page ${input.page} from ${binding.pdfFileName}`,
          ignored: true,
        },
        {
          text: `${settings.translatePrompt}\n\n[Selected text]\n${text}`,
          synthetic: true,
        },
      ],
    })
  }

  const handleImageSelectionAction = async (input: {
    action: "copy" | "translate" | "ask"
    page: number
    imageDataUrl: string
  }) => {
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

  const openSettings = () => {
    const binding = quickReading.store.binding
    if (!binding) return
    dialog.show(() => <DialogQuickReadingSettings pdfFileName={binding.pdfFileName} />)
  }

  const openFirstRead = () => {
    const binding = quickReading.store.binding
    if (!binding) return
    if (quickReading.store.snapshot.totalPages <= 0) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: "The PDF is still loading. Try pre-read again in a moment.",
      })
      return
    }
    setQuickReadingFirstReadOpen(true)
  }

  createEffect(() => {
    const sessionID = params.id
    const active = view().quickReading.active()
    const pdfPath = view().quickReading.pdfPath()
    const pdfFileName = view().quickReading.pdfFileName()
    const previewPage = pdfPath ? file.pdfPage(pdfPath) : undefined

    if (!sessionID || !active || !pdfPath || !pdfFileName) {
      if (quickReading.store.binding) {
        quickReading.unbind()
      }
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
    if (previewPage && previewPage > 0) {
      quickReading.setPage(previewPage)
    }
  })

  const active = createMemo(() => {
    const boundPath = quickReadingPdfPath()
    return (
      !!params.id &&
      view().quickReading.active() &&
      !!boundPath &&
      options.activeFilePath() === boundPath &&
      isPdfPath(boundPath)
    )
  })
  const layoutSwapped = createMemo(() => quickReading.store.snapshot.layoutSwapped)
  const page = createMemo(() => quickReading.store.snapshot.currentPage)
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
    if (!currentPath || currentPath !== boundPath) {
      closeQuickReading()
    }
  })

  const handlePageChange = (page: number) => {
    quickReading.setPage(page)
    const boundPath = quickReadingPdfPath()
    if (boundPath) file.setPdfPage(boundPath, page)
  }

  const handleDocumentInfo = ({ totalPages }: { totalPages: number }) => {
    quickReading.setTotalPages(totalPages)
  }

  const toggleLayoutSwapped = () => {
    quickReading.setLayoutSwapped(!layoutSwapped())
  }

  return {
    quickReading,
    pdfPath: quickReadingPdfPath,
    active,
    page,
    layoutSwapped,
    pdfUrl,
    authHeader,
    firstReadOpen: quickReadingFirstReadOpen,
    setFirstReadOpen: setQuickReadingFirstReadOpen,
    closeQuickReading,
    handleTextSelectionAction,
    handleImageSelectionAction,
    openSettings,
    openFirstRead,
    handlePageChange,
    handleDocumentInfo,
    toggleLayoutSwapped,
  }
}
