import { type Component, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { useQuickReadingMode } from "@/context/quick-reading-mode"

export const DialogQuickReadingSettings: Component<{ pdfFileName?: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const quickReading = useQuickReadingMode()

  const settings = createMemo(() => quickReading.store.snapshot.settings)

  const [translatePrompt, setTranslatePrompt] = createSignal(settings().translatePrompt)
  const [questionPrompt, setQuestionPrompt] = createSignal(settings().questionPrompt)
  const [firstReadPrompt, setFirstReadPrompt] = createSignal(settings().firstReadPrompt)
  const [autoFirstRead, setAutoFirstRead] = createSignal(settings().autoFirstRead)
  const [saving, setSaving] = createSignal(false)

  const zh = () => language.locale() === "zh" || language.locale() === "zht"
  const title = () => (zh() ? "快速阅读设置" : "Quick reading settings")
  const autoFirstReadLabel = () =>
    zh()
      ? "进入快速阅读模式时自动预读（当前阶段保留设置，但不会自动触发）"
      : "Auto pre-read on quick reading open (saved for now, not triggered in this phase)"

  const scopeLabel = () =>
    props.pdfFileName
      ? zh()
        ? `当前设置仅作用于本对话中的 ${props.pdfFileName}`
        : `These settings apply only to ${props.pdfFileName} in the current session.`
      : zh()
        ? "当前设置仅作用于本对话中的这份 PDF。"
        : "These settings apply only to this PDF in the current session."

  const handleSave = () => {
    if (saving()) return
    setSaving(true)
    quickReading.setSettings({
      translatePrompt: translatePrompt(),
      questionPrompt: questionPrompt(),
      firstReadPrompt: firstReadPrompt(),
      autoFirstRead: autoFirstRead(),
    })
    dialog.close()
  }

  return (
    <Dialog title={title()} size="large">
      <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto p-4">
        <div class="rounded border border-border-base bg-surface-raised-base px-3 py-2 text-xs text-text-muted">
          {scopeLabel()}
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.translatePrompt")}</span>
          <textarea
            class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover"
            rows={3}
            value={translatePrompt()}
            onInput={(event) => setTranslatePrompt(event.currentTarget.value)}
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.questionPrompt")}</span>
          <textarea
            class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover"
            rows={5}
            value={questionPrompt()}
            onInput={(event) => setQuestionPrompt(event.currentTarget.value)}
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.firstReadPrompt")}</span>
          <textarea
            class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover"
            rows={4}
            value={firstReadPrompt()}
            onInput={(event) => setFirstReadPrompt(event.currentTarget.value)}
          />
        </label>

        <label class="flex cursor-pointer items-start gap-2 text-sm text-text-base">
          <input
            type="checkbox"
            checked={autoFirstRead()}
            onChange={(event) => setAutoFirstRead(event.currentTarget.checked)}
            class="mt-0.5 rounded"
          />
          <span>{autoFirstReadLabel()}</span>
        </label>

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => dialog.close()} disabled={saving()}>
            {language.t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving()}>
            {saving() ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
