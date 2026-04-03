import { Component, createSignal, onMount, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

type UpdateState = "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error"

const detectOS = (): string => {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes("mac")) return "darwin"
  if (ua.includes("win")) return "windows"
  return "linux"
}

const Spinner = () => <div class="size-4 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />

export const DialogUpdate: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  const [state, setState] = createSignal<UpdateState>("checking")
  const [remoteVersion, setRemoteVersion] = createSignal("")
  const [downloadedVersion, setDownloadedVersion] = createSignal("")
  const [errorMessage, setErrorMessage] = createSignal("")

  const currentVersion = () => downloadedVersion() || platform.version || ""

  const fetchApi = async (path: string, init?: RequestInit) => {
    const res = await fetch(new URL(path, window.location.origin), init)
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
    return res
  }

  const checkVersion = async () => {
    setState("checking")
    setErrorMessage("")
    try {
      const os = detectOS()
      const res = await fetchApi(`/global/web-update/check?os=${os}`)
      const data = await res.json()
      if (data.error) {
        setState("error")
        setErrorMessage(data.error)
        return
      }
      setRemoteVersion(data.remoteVersion)
      setDownloadedVersion(data.currentVersion || "")
      setState(data.updateAvailable ? "available" : "up-to-date")
    } catch (e) {
      setState("error")
      setErrorMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const downloadUpdate = async () => {
    setState("downloading")
    setErrorMessage("")
    try {
      const os = detectOS()
      const res = await fetchApi("/global/web-update/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ os, version: remoteVersion() }),
      })
      const data = await res.json()
      if (!data.success) {
        setState("error")
        setErrorMessage(data.error)
        return
      }
      setState("downloaded")
    } catch (e) {
      setState("error")
      setErrorMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const installUpdate = async () => {
    setState("installing")
    setErrorMessage("")
    try {
      const os = detectOS()
      const res = await fetchApi("/global/web-update/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ os }),
      })
      const data = await res.json()
      if (!data.success) {
        setState("error")
        setErrorMessage(data.error)
        return
      }
      setTimeout(() => {
        window.location.reload()
      }, 3000)
    } catch (e) {
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
            <span class="text-13-medium text-text-strong">v{currentVersion()}</span>
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
            <div class="flex items-center gap-2 text-13-regular text-text-strong">
              <Icon name="arrow-down-to-line" class="size-4" />
              <span>{language.t("update.available")}</span>
            </div>
            <Button size="small" variant="primary" onClick={downloadUpdate}>
              {language.t("update.download")}
            </Button>
          </Show>

          <Show when={state() === "downloading"}>
            <div class="flex items-center gap-2 text-13-regular text-text-weak">
              <Spinner />
              <span>{language.t("update.downloading")}</span>
            </div>
          </Show>

          <Show when={state() === "downloaded"}>
            <div class="flex items-center gap-2 text-13-regular text-text-dimmed-green">
              <Icon name="circle-check" class="size-4" />
              <span>{language.t("update.downloadComplete")}</span>
            </div>
            <Button size="small" variant="primary" onClick={installUpdate}>
              {language.t("update.install")}
            </Button>
          </Show>

          <Show when={state() === "installing"}>
            <div class="flex items-center gap-2 text-13-regular text-text-weak">
              <Spinner />
              <span>{language.t("update.installing")}</span>
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
