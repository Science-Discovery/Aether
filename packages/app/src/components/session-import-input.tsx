import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast, toaster } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { BACKUP_WARN_BYTES, formatBackupSize, parseBackup } from "@/utils/session-backup"
import { formatServerError } from "@/utils/server-errors"

export function SessionImportInput(props: { directory: string; bind: (open: () => void) => void }) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const navigate = useNavigate()
  const dialog = useDialog()
  let input: HTMLInputElement | undefined
  let pending = false
  let toast: number | undefined

  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const progress = (
    key:
      | "session.import.progress.read"
      | "session.import.progress.parse"
      | "session.import.progress.import"
      | "session.import.progress.refresh",
  ) => {
    if (toast !== undefined) toaster.dismiss(toast)
    toast = showToast({
      variant: "loading",
      persistent: true,
      guarded: true,
      title: language.t("session.import.progress.title"),
      description: language.t(key),
    })
  }

  const dismiss = () => {
    if (toast === undefined) return
    toaster.dismiss(toast)
    toast = undefined
  }

  const load = async (file: File) => {
    if (pending) return
    pending = true
    try {
      const client = sdk.createClient({ directory: props.directory })
      const status = await client.session.status()
      if (Object.values(status.data ?? {}).some((item) => item.type !== "idle")) {
        showToast({
          title: language.t("toast.session.import.active.title"),
          description: language.t("toast.session.import.active.description"),
        })
        return
      }
      progress("session.import.progress.read")
      await frame()
      const text = await file.text()
      progress("session.import.progress.parse")
      await frame()
      const body = parseBackup(text)
      progress("session.import.progress.import")
      const result = await client.session.import(body)
      if (!result.data) {
        if (result.error && "name" in result.error && result.error.name === "SessionImportActiveError") {
          throw new Error(language.t("toast.session.import.active.description"))
        }
        throw new Error(language.t("common.requestFailed"))
      }
      progress("session.import.progress.refresh")
      await sync.project.loadSessions(props.directory)
      dismiss()
      showToast({
        variant: "success",
        title: language.t("toast.session.import.success.title"),
        description: language.t("toast.session.import.success.description", { title: result.data.title }),
      })
      navigate(`/${base64Encode(props.directory)}/session/${result.data.sessionID}`)
    } catch (err) {
      dismiss()
      showToast({
        variant: "error",
        title: language.t("toast.session.import.failed.title"),
        description: formatServerError(err, language.t),
      })
    } finally {
      pending = false
    }
  }

  const select = (file: File) => {
    if (file.size < BACKUP_WARN_BYTES) {
      void load(file)
      return
    }
    dialog.show(() => (
      <Dialog title={language.t("session.import.warning.title")} fit>
        <div class="flex flex-col gap-4 px-6 pb-4">
          <p class="text-14-regular text-text-strong">
            {language.t("session.import.warning.description", { size: formatBackupSize(file.size) })}
          </p>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                void load(file)
              }}
            >
              {language.t("common.continue")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  props.bind(() => input?.click())

  return (
    <input
      ref={input}
      type="file"
      accept=".json,application/json"
      class="hidden"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ""
        if (file) select(file)
      }}
    />
  )
}
