import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"

const DEFAULT_PRIVATE = ["*.env", "*.env.*"]

function globs(value: string) {
  return [
    ...new Set(
      value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ]
}

export function DialogSafeZone(props: { onDone: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const existing = globalSync.data.config.safeZone
  const [priv, setPriv] = createSignal((existing?.private ?? DEFAULT_PRIVATE).join("\n"))
  const [open, setOpen] = createSignal((existing?.open ?? []).join("\n"))
  const [saving, setSaving] = createSignal(false)

  const done = () => {
    props.onDone()
    dialog.close()
  }

  const save = () => {
    if (saving()) return
    setSaving(true)
    const next = globs(priv())
    const openGlobs = globs(open())
    const safeZone = {
      ...globalSync.data.config.safeZone,
      ...(next.length > 0 ? { private: next } : {}),
      ...(openGlobs.length > 0 ? { open: openGlobs } : {}),
    }
    globalSync
      .updateConfig({ safeZone })
      .then(done)
      .catch(() => {
        showToast({ variant: "error", title: language.t("common.requestFailed") })
      })
      .finally(() => setSaving(false))
  }

  return (
    <Dialog title={language.t("prompt.permissions.safezone.title")} fit persistent class="w-full max-w-[520px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">{language.t("prompt.permissions.safezone.description")}</p>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("prompt.permissions.safezone.private.label")}</span>
          <textarea
            class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover"
            rows={4}
            placeholder={language.t("prompt.permissions.safezone.private.hint")}
            value={priv()}
            onInput={(event) => setPriv(event.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-muted">{language.t("prompt.permissions.safezone.open.label")}</span>
          <textarea
            class="resize-none rounded border border-border-base bg-surface-raised-base p-2 text-sm focus:outline-none focus:border-border-base-hover"
            rows={3}
            placeholder={language.t("prompt.permissions.safezone.open.hint")}
            value={open()}
            onInput={(event) => setOpen(event.currentTarget.value)}
          />
        </label>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={done}>
            {language.t("prompt.permissions.safezone.skip")}
          </Button>
          <Button onClick={save} disabled={saving()}>
            {language.t("prompt.permissions.safezone.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

let show: (() => void) | undefined

export function useSafeZoneOnboarding() {
  const dialog = useDialog()
  const [store, setStore] = persisted(
    { ...Persist.serverGlobal("permission.safezone", ["permission.safezone.v1"]) },
    createStore({ onboarded: false }),
  )
  show = () => {
    if (store.onboarded) return
    dialog.show(() => <DialogSafeZone onDone={() => setStore("onboarded", true)} />)
  }
  return openSafeZoneOnboarding
}

export function openSafeZoneOnboarding() {
  show?.()
}
