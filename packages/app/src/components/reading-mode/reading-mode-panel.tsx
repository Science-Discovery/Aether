import { type Component, createEffect, createMemo, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { OfficialReadingPdfViewer } from "./reading-pdf-viewer-official"
import { ReadingFirstReadGate } from "./reading-first-read-gate-pdf"
import { DialogReadingModeSettings } from "@/components/dialog-reading-mode-settings"
import { DEFAULT_PROMPT } from "@/context/prompt"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useReadingMode } from "@/context/reading-mode"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sendFollowupDraft, type FollowupDraft } from "@/components/prompt-input/submit"
import { Identifier } from "@/utils/id"
import { formatServerError } from "@/utils/server-errors"
import { createSizing, type Sizing } from "@/pages/session/helpers"

export const ReadingModePanel: Component<{
  sessionID: string
  width: number
  minWidth: number
  maxWidth: number
  layoutSwapped: boolean
  onSwapLayout?: () => void
  onResizeWidth: (width: number) => void
  resizeHandleEnabled?: boolean
  sizing?: Sizing
}> = (props) => {
  const rm = useReadingMode()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const language = useLanguage()
  const dialog = useDialog()
  const size = props.sizing ?? createSizing()

  const pdfUrl = createMemo(() => `${sdk.url}/reading-mode/pdf?sessionID=${encodeURIComponent(props.sessionID)}`)
  let restoredInitialPage = false

  createEffect(() => {
    const info = sync.session.get(props.sessionID)
    const meta = info?.readingMode
    if (!meta) return
    rm.setSessionMeta(meta)
    if (!restoredInitialPage && meta.lastReadPage > 1) {
      rm.setPage(meta.lastReadPage)
      restoredInitialPage = true
    }
  })

  const sessionMeta = createMemo(() => sync.session.get(props.sessionID)?.readingMode ?? rm.store.sessionMeta ?? null)

  const focusPromptInput = () => {
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-component="prompt-input"]')
      if (!(el instanceof HTMLElement)) return
      el.focus()
    })
  }

  const translateLabel = (page: number) =>
    language.locale() === "zh" || language.locale() === "zht"
      ? `\u7ffb\u8bd1\u7b2c ${page} \u9875\u9009\u4e2d\u6587\u672c`
      : `Translate selected text on page ${page}`

  const translatePromptText = (prompt: string, text: string) => `${prompt}\n\n[Selected text]\n${text}`

  const translateImageLabel = (page: number) =>
    language.locale() === "zh" || language.locale() === "zht"
      ? `\u7ffb\u8bd1\u7b2c ${page} \u9875\u622a\u56fe\u9009\u533a`
      : `Translate captured region on page ${page}`

  const translateImagePromptText = (prompt: string) =>
    `${prompt}\n\n[Selected image]\nPlease translate the content shown in the attached image.`

  const handleTextSelectionAction = async (input: { action: "copy" | "translate" | "ask"; page: number; text: string }) => {
    const text = input.text.trim()
    if (!text) return

    if (input.action === "ask") {
      rm.setPendingQuestion({
        kind: "text-question",
        page: input.page,
        text,
        createdAt: Date.now(),
      })
      focusPromptInput()
      return
    }

    if (input.action !== "translate") return

    const meta = sessionMeta()
    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!meta || !currentModel || !currentAgent) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const draft: FollowupDraft = {
      sessionID: props.sessionID,
      sessionDirectory: sdk.directory,
      prompt: DEFAULT_PROMPT,
      context: [],
      agent: currentAgent.name,
      model: {
        providerID: currentModel.provider.id,
        modelID: currentModel.id,
      },
      variant,
      extraTextParts: [
        {
          text: translateLabel(input.page),
          ignored: true,
        },
        {
          text: translatePromptText(meta.settings.translatePrompt, text),
          synthetic: true,
        },
      ],
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

  const handleImageSelectionAction = async (input: {
    action: "copy" | "translate" | "ask"
    page: number
    imageDataUrl: string
  }) => {
    if (!input.imageDataUrl) return

    if (input.action === "ask") {
      rm.setPendingQuestion({
        kind: "image-question",
        page: input.page,
        text:
          language.locale() === "zh" || language.locale() === "zht"
            ? `\u6765\u81ea\u7b2c ${input.page} \u9875\u7684\u622a\u56fe\u9009\u533a`
            : `Captured region from page ${input.page}`,
        imageDataUrl: input.imageDataUrl,
        createdAt: Date.now(),
      })
      focusPromptInput()
      return
    }

    if (input.action !== "translate") return

    const meta = sessionMeta()
    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!meta || !currentModel || !currentAgent) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const draft: FollowupDraft = {
      sessionID: props.sessionID,
      sessionDirectory: sdk.directory,
      prompt: DEFAULT_PROMPT,
      attachments: [
        {
          filename: `pdf-region-page-${input.page}.png`,
          mime: "image/png",
          dataUrl: input.imageDataUrl,
        },
      ],
      context: [],
      agent: currentAgent.name,
      model: {
        providerID: currentModel.provider.id,
        modelID: currentModel.id,
      },
      variant,
      extraTextParts: [
        {
          text: translateImageLabel(input.page),
          ignored: true,
        },
        {
          text: translateImagePromptText(meta.settings.translatePrompt),
          synthetic: true,
        },
      ],
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

  const handleOpenSettings = () => {
    dialog.show(() => <DialogReadingModeSettings sessionID={props.sessionID} />)
  }

  return (
    <div class="relative h-full shrink-0 overflow-visible" style={{ width: `${props.width}px` }}>
      <ReadingFirstReadGate sessionID={props.sessionID} />
      <div
        class="flex h-full flex-col overflow-hidden bg-surface-base"
        classList={{
          "border-r border-border-base": !props.layoutSwapped,
          "border-l border-border-base": props.layoutSwapped,
        }}
      >
        <div class="min-h-0 flex-1">
          <OfficialReadingPdfViewer
            url={pdfUrl()}
            layoutSwapped={props.layoutSwapped}
            onSwapLayout={props.onSwapLayout}
            onOpenSettings={handleOpenSettings}
            onTextSelectionAction={handleTextSelectionAction}
            onImageSelectionAction={handleImageSelectionAction}
          />
        </div>
      </div>

      <Show when={props.resizeHandleEnabled !== false}>
        <div
          class="absolute inset-y-0 z-10 w-0 overflow-visible"
          classList={{
            "left-0": props.layoutSwapped,
            "right-0": !props.layoutSwapped,
          }}
          onPointerDown={() => size.start()}
        >
          <div
            class="pointer-events-none absolute inset-y-0 w-px bg-border-base/80"
            classList={{
              "left-0 -translate-x-1/2": !props.layoutSwapped,
              "right-0 translate-x-1/2": props.layoutSwapped,
            }}
          />
          <ResizeHandle
            direction="horizontal"
            edge={props.layoutSwapped ? "start" : "end"}
            class="after:bg-border-base/90"
            size={props.width}
            min={props.minWidth}
            max={props.maxWidth}
            onResize={(width) => {
              size.touch()
              props.onResizeWidth(width)
            }}
          />
        </div>
      </Show>
    </div>
  )
}
