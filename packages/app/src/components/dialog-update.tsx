import { Component, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

type View =
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "failed"
  | "recovering"
  | "error"
type Props = {
  auto?: "download" | "install"
}

const Spinner = () => <div class="size-4 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />

const ProgressBar = () => (
  <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-weak">
    <div class="h-full w-full animate-pulse rounded-full bg-icon-base" />
  </div>
)

const paint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })

export const DialogUpdate: Component<Props> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    state: "checking" as View,
    remoteVersion: "",
    currentVersion: "",
    error: "",
  })

  const current = () => store.currentVersion || platform.version || ""
  const cancelled = (err: unknown) => err instanceof Error && err.message === "Update cancelled"
  const sync = async () => {
    if (!platform.checkUpdate) throw new Error("Updates are not supported on this platform")
    const data = await platform.checkUpdate()
    setStore("currentVersion", data.currentVersion?.trim() ?? "")
    setStore("remoteVersion", data.version?.trim() ?? "")
    setStore("error", data.updateError?.trim() ?? "")
    return data
  }

  const apply = async () => {
    const data = await sync()
    if (!data.updateAvailable) {
      setStore("state", "up-to-date")
      return data
    }
    if (data.status === "downloading") {
      setStore("state", "downloading")
      return data
    }
    if (data.status === "downloaded") {
      setStore("state", "downloaded")
      return data
    }
    if (data.status === "installing") {
      setStore("state", "installing")
      return data
    }
    if (data.status === "failed") {
      setStore("state", "failed")
      return data
    }
    setStore("state", "available")
    return data
  }

  const checkVersion = async () => {
    setStore("state", "checking")
    setStore("error", "")
    try {
      await apply()
    } catch (err) {
      setStore("state", "error")
      setStore("error", err instanceof Error ? err.message : String(err))
    }
  }

  const downloadUpdate = async () => {
    if (!platform.downloadUpdate) return
    setStore("state", "downloading")
    setStore("error", "")
    try {
      await paint()
      await platform.downloadUpdate()
      await apply()
    } catch (err) {
      if (cancelled(err)) {
        setStore("state", "available")
        return
      }
      setStore("state", "failed")
      setStore("error", err instanceof Error ? err.message : String(err))
    }
  }

  const installUpdate = async () => {
    if (!platform.update) return
    setStore("state", "installing")
    setStore("error", "")
    try {
      await paint()
      await platform.update()
      await platform.restart()
      setTimeout(() => {
        dialog.close()
      }, 1200)
    } catch (err) {
      if (cancelled(err)) {
        setStore("state", "downloaded")
        return
      }
      setStore("state", "failed")
      setStore("error", err instanceof Error ? err.message : String(err))
    }
  }

  const recoverUpdate = async () => {
    if (!platform.recoverUpdate) return
    setStore("state", "recovering")
    if (!store.error) setStore("error", language.t("update.recoverHint"))
    try {
      await paint()
      await platform.recoverUpdate()
      await platform.restart()
      setTimeout(() => {
        dialog.close()
      }, 1200)
    } catch (err) {
      if (cancelled(err)) {
        setStore("state", "failed")
        return
      }
      setStore("state", "failed")
      setStore("error", err instanceof Error ? err.message : String(err))
    }
  }

  const start = async () => {
    const data = await apply()
    if (!data.updateAvailable || !props.auto) return
    if (props.auto === "download") {
      if (data.status !== "available") return
      await downloadUpdate()
      return
    }
    if (data.status === "downloaded") {
      await installUpdate()
      return
    }
    if (data.status !== "available") return
    await downloadUpdate()
    if (store.state === "downloaded") {
      await installUpdate()
    }
  }

  onMount(() => {
    void start().catch((err) => {
      setStore("state", "error")
      setStore("error", err instanceof Error ? err.message : String(err))
    })
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
              {store.state === "checking" ? "..." : store.remoteVersion ? `v${store.remoteVersion}` : "-"}
            </span>
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <Show when={store.state === "checking"}>
            <div class="flex items-center gap-2 text-13-regular text-text-weak">
              <Spinner />
              <span>{language.t("update.checking")}</span>
            </div>
          </Show>

          <Show when={store.state === "up-to-date"}>
            <div class="flex items-center gap-2 text-13-regular text-text-dimmed-green">
              <Icon name="circle-check" class="size-4" />
              <span>{language.t("update.upToDate")}</span>
            </div>
          </Show>

          <Show when={store.state === "available"}>
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

          <Show when={store.state === "downloading"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 text-13-regular text-text-weak">
                <Spinner />
                <span>{language.t("update.downloading")}</span>
              </div>
              <ProgressBar />
            </div>
          </Show>

          <Show when={store.state === "downloaded"}>
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

          <Show when={store.state === "installing" || store.state === "recovering"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 text-13-regular text-text-weak">
                <Spinner />
                <span>{language.t(store.state === "recovering" ? "update.recovering" : "update.installing")}</span>
              </div>
              <ProgressBar />
              <div class="text-12-regular text-text-weak">
                {language.t(store.state === "recovering" ? "update.recoverHint" : "update.installHint")}
              </div>
            </div>
          </Show>

          <Show when={store.state === "failed"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 text-13-regular text-text-dimmed-red">
                <Icon name="warning" class="size-4" />
                <span>{store.error || language.t("update.recoverHint")}</span>
              </div>
              <div class="text-12-regular text-text-weak">{language.t("update.recoverHint")}</div>
            </div>
            <Button size="small" variant="primary" onClick={recoverUpdate}>
              {language.t("update.recover")}
            </Button>
          </Show>

          <Show when={store.state === "error"}>
            <div class="flex items-center gap-2 text-13-regular text-text-dimmed-red">
              <Icon name="warning" class="size-4" />
              <span>
                {language.t("update.checkFailed")}: {store.error}
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
