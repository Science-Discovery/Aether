import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Select } from "@opencode-ai/ui/select"
import { useLanguage } from "@/context/language"

interface DialogSelectProps<T> {
  title: string
  description?: string
  options: T[]
  value: (x: T) => string
  label: (x: T) => string
  defaultValue?: string
  actionLabel: string
  onAction: (value: T) => void
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const language = useLanguage()
  const [selectedKey, setSelectedKey] = createSignal(props.defaultValue ?? "")

  const selected = () => props.options.find((o) => props.value(o) === selectedKey())

  const confirm = () => {
    const v = selected()
    if (!v) return
    dialog.close()
    props.onAction(v)
  }

  const handleSelect = (v: T | undefined) => {
    setSelectedKey(v ? props.value(v) : "")
  }

  return (
    <Dialog title={props.title} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        {props.description && <p class="text-sm text-text-base">{props.description}</p>}
        <Select
          options={props.options}
          current={selected()}
          value={props.value}
          label={props.label}
          onSelect={handleSelect}
          variant="outline"
          size="small"
        />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button onClick={confirm} disabled={!selected()}>
            {props.actionLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
