import { type Component, Show, createSignal } from "solid-js"

const [msg, setMsg] = createSignal("")
const [shown, setShown] = createSignal(false)
const [fade, setFade] = createSignal(false)

let fadeTimer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined

const clear = () => {
  if (fadeTimer) clearTimeout(fadeTimer)
  if (hideTimer) clearTimeout(hideTimer)
  fadeTimer = undefined
  hideTimer = undefined
}

export function showFileRefreshNotice(changed: boolean) {
  clear()
  setMsg(changed ? "拉取到更新" : "未发现更新")
  setFade(false)
  setShown(true)
  fadeTimer = setTimeout(() => {
    setFade(true)
    fadeTimer = undefined
  }, 2000)
  hideTimer = setTimeout(() => {
    setShown(false)
    setFade(false)
    hideTimer = undefined
  }, 2600)
}

export const FileRefreshNotice: Component = () => {
  return (
    <Show when={shown()}>
      <div
        class="flex items-center gap-2 px-2 py-1 rounded-md border border-border-base bg-surface-base text-xs select-none shrink-0 transition-opacity duration-500"
        classList={{
          "opacity-100": !fade(),
          "opacity-0": fade(),
        }}
      >
        <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${msg() === "拉取到更新" ? "bg-green-500" : "bg-border-strong-base"}`} />
        <span class="text-text-weak shrink-0">{msg()}</span>
      </div>
    </Show>
  )
}
