import { type Component, createSignal } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useReadingMode } from "@/context/reading-mode"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { upsertSessionList } from "@/utils/session-store"
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
  if (input.json) headers["Content-Type"] = "application/json"
  return headers
}

export const DialogReadingModeSettings: Component<{ sessionID: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()
  const readingMode = useReadingMode()

  const session = sync.session.get(props.sessionID)
  const meta = session?.readingMode ?? readingMode.store.sessionMeta

  const [translatePrompt, setTranslatePrompt] = createSignal(meta?.settings.translatePrompt ?? "")
  const [questionPrompt, setQuestionPrompt] = createSignal(meta?.settings.questionPrompt ?? "")
  const [firstReadPrompt, setFirstReadPrompt] = createSignal(meta?.settings.firstReadPrompt ?? "")
  const [contextPageRange, setContextPageRange] = createSignal<0 | 1 | 2>(meta?.settings.contextPageRange ?? 1)
  const [autoFirstRead, setAutoFirstRead] = createSignal(meta?.settings.autoFirstRead ?? true)
  const [saving, setSaving] = createSignal(false)

  const title = () =>
    language.locale() === "zh" || language.locale() === "zht" ? "阅读设置" : "Reading settings"

  const autoFirstReadLabel = () =>
    language.locale() === "zh" || language.locale() === "zht"
      ? "进入此阅读会话时自动询问 AI 预读"
      : "Prompt AI first-read when opening this reading session"

  const handleSave = async () => {
    if (!meta || saving()) return
    setSaving(true)
    try {
      const http = server.current?.http
      const response = await fetch(`${sdk.url}/reading-mode/session/${encodeURIComponent(props.sessionID)}`, {
        method: "PATCH",
        headers: buildAuthHeaders({ username: http?.username, password: http?.password, json: true }),
        body: JSON.stringify({
          settings: {
            translatePrompt: translatePrompt(),
            questionPrompt: questionPrompt(),
            firstReadPrompt: firstReadPrompt(),
            contextPageRange: contextPageRange(),
            autoFirstRead: autoFirstRead(),
          },
        }),
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || `HTTP ${response.status}`)
      }

      const next = (await response.json()) as Session
      sync.set("session", (items: Session[]) => upsertSessionList(items, next))
      if (next.readingMode) {
        readingMode.setSessionMeta(next.readingMode)
      }
      dialog.close()
    } catch (cause) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(cause, language.t),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={title()} size="large">
      <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto p-4">
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

        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.contextPageRange")}</span>
          <select
            class="rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none"
            value={contextPageRange()}
            onChange={(event) => setContextPageRange(Number(event.currentTarget.value) as 0 | 1 | 2)}
          >
            <option value={0}>{language.t("reading.dialog.advanced.contextPage.0")}</option>
            <option value={1}>{language.t("reading.dialog.advanced.contextPage.1")}</option>
            <option value={2}>{language.t("reading.dialog.advanced.contextPage.2")}</option>
          </select>
        </label>

        <label class="flex cursor-pointer items-center gap-2 text-sm text-text-base">
          <input
            type="checkbox"
            checked={autoFirstRead()}
            onChange={(event) => setAutoFirstRead(event.currentTarget.checked)}
            class="rounded"
          />
          {autoFirstReadLabel()}
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
