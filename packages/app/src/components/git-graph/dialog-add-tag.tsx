import { createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

type TagType = "annotated" | "lightweight"

interface DialogAddTagProps {
  hash: string
  onAction: (opts: { name: string; type: TagType; message: string }) => void
}

export function DialogAddTag(props: DialogAddTagProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [type, setType] = createSignal<TagType>("annotated")
  const [message, setMessage] = createSignal("")
  const typeOptions: TagType[] = ["annotated", "lightweight"]

  const confirm = () => {
    const n = name().trim()
    if (!n) return
    dialog.close()
    props.onAction({ name: n, type: type(), message: message().trim() })
  }

  const t = (key: string) => language.t(key)
  const typeLabel = (v: TagType) =>
    v === "annotated" ? t("session.tab.gitGraph.addTagTypeAnnotated") : t("session.tab.gitGraph.addTagTypeLightweight")

  return (
    <Dialog title={t("session.tab.gitGraph.addTagTitle")} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <TextField
          label={t("session.tab.gitGraph.addTagName")}
          value={name()}
          onChange={setName}
          placeholder={t("session.tab.gitGraph.addTagNamePlaceholder")}
        />
        <Select
          options={typeOptions}
          current={type()}
          value={(v) => v}
          label={typeLabel}
          onSelect={(v) => setType(v ?? "annotated")}
          variant="outline"
          size="small"
        />
        <Show when={type() === "annotated"}>
          <TextField
            label={t("session.tab.gitGraph.addTagMessage")}
            value={message()}
            onChange={setMessage}
            placeholder={t("session.tab.gitGraph.addTagMessagePlaceholder")}
            description={t("session.tab.gitGraph.addTagMessageDescription")}
          />
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm} disabled={!name().trim()}>
            {t("session.tab.gitGraph.addTag")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
