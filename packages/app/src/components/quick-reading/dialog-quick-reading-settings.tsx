import { type Component, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { useQuickReadingMode } from "@/context/quick-reading-mode"

export const DialogQuickReadingSettings: Component<{ pdfFileName?: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const quick = useQuickReadingMode()
  const settings = createMemo(() => quick.store.snapshot.settings)
  const [translate, setTranslate] = createSignal(settings().translatePrompt)
  const [question, setQuestion] = createSignal(settings().questionPrompt)
  const [first, setFirst] = createSignal(settings().firstReadPrompt)
  const [auto, setAuto] = createSignal(settings().autoFirstRead)
  const [saving, setSaving] = createSignal(false)
  const zh = () => language.locale() === "zh" || language.locale() === "zht"

  const scope = () => {
    if (props.pdfFileName) {
      return zh()
        ? `这些设置会作用于当前工作区中的全部 PDF，包含 ${props.pdfFileName}。`
        : `These settings apply to all PDFs in the current workspace, including ${props.pdfFileName}.`
    }
    return zh() ? "这些设置会作用于当前工作区中的全部 PDF。" : "These settings apply to all PDFs in the current workspace."
  }

  const save = () => {
    if (saving()) return
    setSaving(true)
    quick.setSettings({
      translatePrompt: translate(),
      questionPrompt: question(),
      firstReadPrompt: first(),
      autoFirstRead: auto(),
    })
    dialog.close()
  }

  return (
    <Dialog title={zh() ? "阅读视图设置" : "Reading view settings"} size="large">
      <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto p-4">
        <div class="rounded border border-border-base bg-surface-raised-base px-3 py-2 text-xs text-text-muted">{scope()}</div>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.translatePrompt")}</span>
          <textarea class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover" rows={3} value={translate()} onInput={(event) => setTranslate(event.currentTarget.value)} />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.questionPrompt")}</span>
          <textarea class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover" rows={5} value={question()} onInput={(event) => setQuestion(event.currentTarget.value)} />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.firstReadPrompt")}</span>
          <textarea class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover" rows={4} value={first()} onInput={(event) => setFirst(event.currentTarget.value)} />
        </label>

        <label class="flex items-center gap-2 text-sm text-text-base cursor-pointer">
          <input
            type="checkbox"
            checked={auto()}
            onChange={(event) => setAuto(event.currentTarget.checked)}
            class="rounded"
          />
          {zh() ? "自动提示 AI 预读" : "Automatically prompt AI pre-read"}
        </label>

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => dialog.close()} disabled={saving()}>{language.t("common.cancel")}</Button>
          <Button onClick={save} disabled={saving()}>{saving() ? language.t("common.saving") : language.t("common.save")}</Button>
        </div>
      </div>
    </Dialog>
  )
}
