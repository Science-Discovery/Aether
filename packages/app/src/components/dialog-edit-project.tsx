import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { Icon } from "@opencode-ai/ui/icon"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { type LocalProject, getAvatarColors } from "@/context/layout"
import { getFilename } from "@opencode-ai/util/path"
import { Avatar } from "@opencode-ai/ui/avatar"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const ICON_SIZE = 128

async function optimizeIcon(file: File) {
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read icon"))
    reader.readAsDataURL(file)
  })

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Failed to load icon"))
    img.src = src
  })

  const scale = Math.min(1, ICON_SIZE / Math.max(img.naturalWidth, img.naturalHeight, 1))
  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return src
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL("image/png")
}

export function DialogEditProject(props: { project: LocalProject }) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()

  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())

  const [store, setStore] = createStore({
    name: defaultName(),
    color: props.project.icon?.color || "pink",
    iconUrl: props.project.icon?.override || "",
    startup: props.project.commands?.start ?? "",
    dragOver: false,
    iconHover: false,
  })

  let iconInput: HTMLInputElement | undefined

  async function handleFileSelect(file: File) {
    if (!file.type.startsWith("image/")) return
    optimizeIcon(file)
      .then((src) => {
        setStore("iconUrl", src)
        setStore("iconHover", false)
      })
      .catch(() => {})
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    setStore("dragOver", false)
    const file = e.dataTransfer?.files[0]
    if (file) handleFileSelect(file)
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault()
    setStore("dragOver", true)
  }

  function handleDragLeave() {
    setStore("dragOver", false)
  }

  function handleInputChange(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) handleFileSelect(file)
  }

  function clearIcon() {
    setStore("iconUrl", "")
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async () => {
      const name = store.name.trim() === folderName() ? "" : store.name.trim()
      const start = store.startup.trim()
      const icon = { color: store.color, override: store.iconUrl || undefined }

      globalSync.project.meta(props.project.worktree, { name, icon, commands: { start: start || undefined } })
      globalSync.project.icon(props.project.worktree, icon.override)
      dialog.close()

      globalSDK.client.project
        .updateDirectoryMeta({
          body_directory: props.project.worktree,
          name: name || undefined,
          projectID: props.project.id && !props.project.id.startsWith("dir:") ? props.project.id : undefined,
          icon,
        })
        .catch(() => {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: language.t("common.requestFailed"),
          })
        })

      const pid = props.project.id && !props.project.id.startsWith("dir:") ? props.project.id : undefined
      if (pid && start) {
        globalSDK.client.project
          .update({
            projectID: pid,
            commands: { start },
          })
          .catch(() => {})
      }
    },
  }))

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (saveMutation.isPending) return
    saveMutation.mutate()
  }

  return (
    <Dialog title={language.t("dialog.project.edit.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col gap-6 p-6 pt-0">
        <div class="flex flex-col gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("dialog.project.edit.name")}
            placeholder={folderName()}
            value={store.name}
            onChange={(v) => setStore("name", v)}
          />

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-weak">{language.t("dialog.project.edit.icon")}</label>
            <div class="flex gap-3 items-start">
              <div
                class="relative"
                onMouseEnter={() => setStore("iconHover", true)}
                onMouseLeave={() => setStore("iconHover", false)}
              >
                <div
                  class="relative size-16 rounded-md transition-colors cursor-pointer"
                  classList={{
                    "border-text-interactive-base bg-surface-info-base/20": store.dragOver,
                    "border-border-base hover:border-border-strong": !store.dragOver,
                    "overflow-hidden": !!store.iconUrl,
                  }}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onClick={() => {
                    if (store.iconUrl && store.iconHover) {
                      clearIcon()
                    } else {
                      iconInput?.click()
                    }
                  }}
                >
                  <Show
                    when={store.iconUrl}
                    fallback={
                      <div class="size-full flex items-center justify-center">
                        <Avatar
                          fallback={store.name || defaultName()}
                          {...getAvatarColors(store.color)}
                          class="size-full text-[32px]"
                        />
                      </div>
                    }
                  >
                    <img
                      src={store.iconUrl}
                      alt={language.t("dialog.project.edit.icon.alt")}
                      class="size-full object-cover"
                    />
                  </Show>
                </div>
                <div
                  class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"
                  classList={{
                    "opacity-100": store.iconHover && !store.iconUrl,
                    "opacity-0": !(store.iconHover && !store.iconUrl),
                  }}
                >
                  <Icon name="cloud-upload" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
                </div>
                <div
                  class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"
                  classList={{
                    "opacity-100": store.iconHover && !!store.iconUrl,
                    "opacity-0": !(store.iconHover && !!store.iconUrl),
                  }}
                >
                  <Icon name="trash" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
                </div>
              </div>
              <input
                id="icon-upload"
                ref={(el) => {
                  iconInput = el
                }}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={handleInputChange}
              />
              <div class="flex flex-col gap-1.5 text-12-regular text-text-weak self-center">
                <span>{language.t("dialog.project.edit.icon.hint")}</span>
                <span>{language.t("dialog.project.edit.icon.recommended")}</span>
              </div>
            </div>
          </div>

          <Show when={!store.iconUrl}>
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{language.t("dialog.project.edit.color")}</label>
              <div class="flex gap-1.5">
                <For each={AVATAR_COLOR_KEYS}>
                  {(color) => (
                    <button
                      type="button"
                      aria-label={language.t("dialog.project.edit.color.select", { color })}
                      aria-pressed={store.color === color}
                      classList={{
                        "flex items-center justify-center size-10 p-0.5 rounded-lg overflow-hidden transition-colors cursor-default": true,
                        "bg-transparent border-2 border-icon-strong-base hover:bg-surface-base-hover":
                          store.color === color,
                        "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base":
                          store.color !== color,
                      }}
                      onClick={() => setStore("color", color)}
                    >
                      <Avatar
                        fallback={store.name || defaultName()}
                        {...getAvatarColors(color)}
                        class="size-full rounded"
                      />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <TextField
            multiline
            label={language.t("dialog.project.edit.worktree.startup")}
            description={language.t("dialog.project.edit.worktree.startup.description")}
            placeholder={language.t("dialog.project.edit.worktree.startup.placeholder")}
            value={store.startup}
            onChange={(v) => setStore("startup", v)}
            spellcheck={false}
            class="max-h-14 w-full overflow-y-auto font-mono text-xs"
          />
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
