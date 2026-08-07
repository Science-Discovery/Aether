import { onCleanup, onMount, type Component } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

const monitor = "aether:mineru-monitor"

export function watchMineruMonitor(value = true) {
  if (value) localStorage.setItem(monitor, "1")
  if (!value) localStorage.removeItem(monitor)
  window.dispatchEvent(new CustomEvent(monitor, { detail: value }))
}

export const MineruMonitor: Component = () => {
  const global = useGlobalSDK()
  const language = useLanguage()
  const platform = usePlatform()
  let previous: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let watching = localStorage.getItem(monitor) === "1"
  let checking = false

  onMount(() => {
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void check(), delay)
    }
    const check = async () => {
      if (checking) return
      checking = true
      const value = await global.client.global
        .mineruManagedStatus({ throwOnError: true })
        .then((item) => item.data)
        .catch(() => undefined)
      checking = false
      if (!value) {
        if (watching) schedule(10_000)
        return
      }
      if (!value.supported) {
        watching = false
        localStorage.removeItem(monitor)
        return
      }
      if (previous === undefined && value.install === "cancelled") {
        await platform.notify?.(
          language.t("settings.general.mineru.notification.interrupted"),
          language.t("settings.general.mineru.notification.open"),
        )
      }
      if (
        (previous === "installing" || (watching && previous !== undefined && previous !== "ready")) &&
        value.install === "ready"
      ) {
        await platform.notify?.(
          language.t("settings.general.mineru.notification.ready"),
          language.t("settings.general.mineru.notification.readyDescription"),
        )
      }
      if (
        (previous === "installing" || (watching && previous !== undefined && previous !== "failed")) &&
        value.install === "failed"
      ) {
        await platform.notify?.(
          language.t("settings.general.mineru.notification.failed"),
          value.error ?? language.t("settings.general.mineru.notification.open"),
        )
      }
      previous = value.install
      if (value.install === "installing") {
        schedule(3_000)
        return
      }
      if (watching && value.install === "unconfigured") {
        schedule(10_000)
        return
      }
      watching = false
      localStorage.removeItem(monitor)
    }
    const wake = (event: Event) => {
      watching = (event as CustomEvent<boolean>).detail
      if (timer) clearTimeout(timer)
      timer = undefined
      if (watching) void check()
    }
    window.addEventListener(monitor, wake)
    if (watching) void check()
    onCleanup(() => {
      window.removeEventListener(monitor, wake)
      if (timer) clearTimeout(timer)
    })
  })

  return null
}
