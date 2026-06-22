import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { parseBackup } from "@/utils/session-backup"
import { formatServerError } from "@/utils/server-errors"

export function SessionImportInput(props: { directory: string; bind: (open: () => void) => void }) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const navigate = useNavigate()
  let input: HTMLInputElement | undefined

  const load = async (file: File) => {
    try {
      const body = parseBackup(await file.text())
      const result = await sdk.createClient({ directory: props.directory }).session.import(body)
      if (!result.data) throw new Error(language.t("common.requestFailed"))
      await sync.project.loadSessions(props.directory)
      showToast({
        variant: "success",
        title: language.t("toast.session.import.success.title"),
        description: language.t("toast.session.import.success.description", { title: result.data.title }),
      })
      navigate(`/${base64Encode(props.directory)}/session/${result.data.sessionID}`)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.session.import.failed.title"),
        description: formatServerError(err, language.t),
      })
    }
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
        if (file) void load(file)
      }}
    />
  )
}
