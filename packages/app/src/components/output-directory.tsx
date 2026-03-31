import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { type Accessor, Show, createSignal } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"

type Props = {
  label: string
  title: string
  name: string
  neighbor: string
  custom: string
  target: Accessor<"neighbor" | "custom">
  setTarget: (value: "neighbor" | "custom") => void
  value: Accessor<string>
  setValue: (value: string) => void
  error: Accessor<string | null>
  setError: (value: string | null) => void
}

export function OutputDirectory(props: Props) {
  const dialog = useDialog()
  const platform = usePlatform()
  const server = useServer()
  const [busy, setBusy] = createSignal(false)

  const apply = (value: string) => {
    props.setTarget("custom")
    props.setValue(value)
    props.setError(null)
  }

  const pick = async () => {
    if (busy()) return
    setBusy(true)
    let hold = false

    try {
      if (server.isLocal()) {
        if (platform.openDirectoryPickerDialog) {
          const result = await platform.openDirectoryPickerDialog({ title: props.title })
          const value = Array.isArray(result) ? result[0] : result
          if (value) apply(value)
          return
        }
      }

      const mod = await import("./dialog-select-directory")
      hold = true
      dialog.showModeless(
        () => (
          <mod.DialogSelectDirectory
            title={props.title}
            initial={props.value().trim() || undefined}
            persistent
            onSelect={(result) => {
              setBusy(false)
              if (!result || Array.isArray(result)) return
              apply(result)
            }}
          />
        ),
        () => setBusy(false),
      )
    } catch (err) {
      showToast({
        variant: "error",
        title: "选择文件夹失败",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (!hold) setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <label class="text-sm font-medium text-text-base">{props.label}</label>
      <div class="flex flex-col gap-1">
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name={props.name}
            checked={props.target() === "neighbor"}
            onChange={() => {
              props.setTarget("neighbor")
              props.setError(null)
            }}
          />
          <span class="text-text-base">{props.neighbor}</span>
        </label>
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name={props.name}
            checked={props.target() === "custom"}
            onChange={() => props.setTarget("custom")}
          />
          <span class="text-text-base">{props.custom}</span>
        </label>
      </div>
      <Show when={props.target() === "custom"}>
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <input
              type="text"
              value={props.value()}
              onInput={(e) => {
                props.setValue(e.currentTarget.value)
                props.setError(null)
              }}
              placeholder="输入目标文件夹路径，可粘贴相对路径或绝对路径"
              class="flex-1 min-w-0 px-2 py-1 rounded border border-border-base bg-surface-base text-text-base text-sm"
            />
            <Button
              type="button"
              size="small"
              variant="secondary"
              icon="folder"
              disabled={busy()}
              onClick={pick}
            >
              {busy() ? "选择中..." : "浏览"}
            </Button>
          </div>
          <Show when={props.error()}>
            <p class="text-xs text-red-500">{props.error()}</p>
          </Show>
        </div>
      </Show>
    </div>
  )
}
