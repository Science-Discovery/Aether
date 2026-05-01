import { Component, createSignal, Show, createEffect, onCleanup, batch } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useParams } from "@solidjs/router"

export const SteerButton: Component = () => {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  let anchorRef: HTMLDivElement | undefined
  let textareaRef: HTMLTextAreaElement | undefined

  const busy = () => {
    const id = params.id
    if (!id) return false
    const status = sync.data.session_status[id]
    return status?.type !== "idle"
  }

  const popupStyle = () => {
    if (!anchorRef) return { display: "none" }
    const rect = anchorRef.getBoundingClientRect()
    return {
      position: "fixed" as const,
      bottom: `${window.innerHeight - rect.top + 4}px`,
      left: `${rect.left}px`,
    }
  }

  const handleSend = async () => {
    const t = text().trim()
    if (!t) return
    const id = params.id
    if (!id) return

    if (!busy()) {
      showToast({
        title: language.t("prompt.steer.toast.notBusy.title"),
        description: language.t("prompt.steer.toast.notBusy.description"),
      })
      setOpen(false)
      return
    }

    setSending(true)
    try {
      await sdk.client.session.steer({ sessionID: id, text: t })
      await sync.session.sync(id, { force: true })
      batch(() => {
        setText("")
        setOpen(false)
      })
    } catch {
      showToast({
        title: language.t("prompt.steer.toast.failed.title"),
        description: language.t("prompt.steer.toast.failed.description"),
      })
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === "Escape") {
      setOpen(false)
    }
  }

  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.closest("[data-component=steer-button]") && !target.closest("[data-component=steer-popup]")) {
      setOpen(false)
    }
  }

  const toggleOpen = () => {
    if (!busy()) {
      showToast({
        title: language.t("prompt.steer.toast.notBusy.title"),
        description: language.t("prompt.steer.toast.notBusy.description"),
      })
      return
    }
    setOpen(!open())
  }

  createEffect(() => {
    if (open()) {
      document.addEventListener("click", handleClickOutside, true)
      onCleanup(() => document.removeEventListener("click", handleClickOutside, true))
      requestAnimationFrame(() => textareaRef?.focus())
    }
  })

  return (
    <div data-component="steer-button" ref={anchorRef} class="relative">
      <Tooltip placement="top" gutter={4} value={<span>{language.t("prompt.action.steer")}</span>}>
        <Button
          variant="ghost"
          size="normal"
          class="h-7 w-7 p-0 flex items-center justify-center shrink-0"
          classList={{
            "text-icon-weak": !open(),
            "text-icon-strong-base": open(),
          }}
          onClick={toggleOpen}
          aria-label={language.t("prompt.action.steer")}
        >
          <Icon name="steer" class="size-4" />
        </Button>
      </Tooltip>
      <Show when={open()}>
        <Portal>
          <div
            data-component="steer-popup"
            style={popupStyle()}
            class="z-50 w-[512px] rounded-lg border border-border-weak-base bg-surface-base shadow-lg p-3 flex flex-col gap-2"
          >
            <textarea
              ref={textareaRef}
              rows={4}
              class="flex-1 min-w-0 px-2 py-1.5 rounded-md border border-border-weak-base bg-background-base text-13-regular text-text-strong outline-none focus:border-border-strong-base resize-none"
              placeholder={language.t("prompt.steer.placeholder")}
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={sending()}
            />
            <div class="flex justify-end">
              <Button
                variant="primary"
                size="small"
                class="shrink-0"
                disabled={!text().trim() || sending()}
                onClick={handleSend}
              >
                {language.t("prompt.steer.send")}
              </Button>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  )
}
