import { Component, createSignal, onMount, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

type UpdateState = "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error"

const Spinner = () => <div class="size-4 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />

const ProgressBar = () => (
  <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-weak">
    <div class="h-full w-full animate-pulse rounded-full bg-icon-base" />
  </div>
)

export const DialogUpdate: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const [state, setState] = createSignal<UpdateState>("checking")
  const [remoteVersion, setRemoteVersion] = createSignal("")
  const [currentVersion, setCurrentVersion] = createSignal("")
  const [errorMessage, setErrorMessage] = createSignal("")

  const current = () => currentVersion() || platform.version || ""
  const cancelled = (err: unknown) => err instanceof Error && err.message === "Update cancelled"
  const sync = async () => {
    if (!platform.checkUpdate) throw new Error("Updates are not supported on this platform")
    const data = await platform.checkUpdate()
    if (data.currentVersion?.trim()) setCurrentVersion(data.currentVersion.trim())
    setRemoteVersion(data.version?.trim() ?? "")
    return data
  }

  const checkVersion = async () => {
    setState("checking")
    setErrorMessage("")
    try {
      const data = await sync()
      if (!data.updateAvailable) {
        setState("up-to-date")
        return
      }
      setState(data.downloaded ? "downloaded" : "available")
    } catch (e) {
      setState("error")
      setErrorMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const downloadUpdate = async () => {
    if (!platform.downloadUpdate) return
    setState("downloading")
    setErrorMessage("")
    try {
      await platform.downloadUpdate()
      const data = await sync()
      if (!data.updateAvailable) {
        setState("up-to-date")
        return
      }
      setState(data.downloaded ? "downloaded" : "available")
    } catch (e) {
      if (cancelled(e)) {
        setState("available")
        return
      }
      setState("error")
      setErrorMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const installUpdate = async () => {
    if (!platform.update) return
    setState("installing")
    setErrorMessage("")
    try {
      await platform.update()
      await platform.restart()
      setTimeout(() => {
        dialog.close()
      }, 1200)
    } catch (e) {
      if (cancelled(e)) {
        setState("downloaded")
        return
      }
      setState("error")
      setErrorMessage(e instanceof Error ? e.message : String(e))
    }
  }

  onMount(() => {
    void checkVersion()
  })

  return (
    <Dialog size="normal" transition>
      <div class="flex flex-col gap-6 p-6">
        <div class="flex items-center gap-3">
          <Icon name="cloud-upload" class="text-icon-base size-5" />
          <h2 class="text-16-medium text-text-strong">{language.t("update.title")}</h2>
        </div>

        <div class="flex flex-col gap-4">
          <div class="flex justify-between items-center">
            <span class="text-13-regular text-text-weak">{language.t("update.currentVersion")}</span>
            <span class="text-13-medium text-text-strong">{current() ? `v${current()}` : "-"}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-13-regular text-text-weak">{language.t("update.remoteVersion")}</span>
            <span class="text-13-medium text-text-strong">
              {state() === "checking" ? "..." : remoteVersion() ? `v${remoteVersion()}` : "-"}
            </span>
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <Show when={state() === "checking"}>
            <div class="flex items-center gap-2 text-13-regular text-text-weak">
              <Spinner />
              <span>{language.t("update.checking")}</span>
            </div>
          </Show>

          <Show when={state() === "up-to-date"}>
            <div class="flex items-center gap-2 text-13-regular text-text-dimmed-green">
              <Icon name="circle-check" class="size-4" />
              <span>{language.t("update.upToDate")}</span>
            </div>
          </Show>

          <Show when={state() === "available"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 text-13-regular text-text-strong">
                <Icon name="arrow-down-to-line" class="size-4" />
                <span>{language.t("update.available")}</span>
              </div>
              <Button size="small" variant="primary" onClick={downloadUpdate}>
                {language.t("update.download")}
              </Button>
            </div>
          </Show>

          <Show when={state() === "downloading"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 text-13-regular text-text-weak">
                <Spinner />
                <span>{language.t("update.downloading")}</span>
              </div>
              <ProgressBar />
            </div>
          </Show>

          <Show when={state() === "downloaded"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 text-13-regular text-text-dimmed-green">
                <Icon name="circle-check" class="size-4" />
                <span>{language.t("update.downloadComplete")}</span>
              </div>
              <div class="text-12-regular text-text-weak">{language.t("update.installHint")}</div>
            </div>
            <Button size="small" variant="primary" onClick={installUpdate}>
              {language.t("update.install")}
            </Button>
          </Show>

          <Show when={state() === "installing"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 text-13-regular text-text-weak">
                <Spinner />
                <span>{language.t("update.installing")}</span>
              </div>
              <ProgressBar />
              <div class="text-12-regular text-text-weak">{language.t("update.installHint")}</div>
            </div>
          </Show>

          <Show when={state() === "error"}>
            <div class="flex items-center gap-2 text-13-regular text-text-dimmed-red">
              <Icon name="warning" class="size-4" />
              <span>
                {language.t("update.checkFailed")}: {errorMessage()}
              </span>
            </div>
            <Button size="small" variant="secondary" onClick={checkVersion}>
              {language.t("update.retry")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
