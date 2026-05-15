import { createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

type TagType = "annotated" | "lightweight"

interface DialogAddTagProps {
  hash: string
  tags: string[]
  remotes: string[]
  initialName?: string
  initialType?: TagType
  initialMessage?: string
  onAction: (opts: { name: string; type: TagType; message: string; remote: string | null; force: boolean }) => void
}

export function DialogAddTag(props: DialogAddTagProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal(props.initialName ?? "")
  const [type, setType] = createSignal<TagType>(props.initialType ?? "annotated")
  const [message, setMessage] = createSignal(props.initialMessage ?? "")
  const [remote, setRemote] = createSignal("-1")
  const [push, setPush] = createSignal(false)
  const [conflict, setConflict] = createSignal(false)
  const typeOptions: TagType[] = ["annotated", "lightweight"]
  const remoteOptions = () => [{ name: "Don't push", value: "-1" }, ...props.remotes.map((r) => ({ name: r, value: r }))]

  const submit = (force: boolean) => {
    const n = name().trim()
    if (!n) return
    dialog.close()
    props.onAction({
      name: n,
      type: type(),
      message: message().trim(),
      remote: props.remotes.length === 1 ? (push() ? props.remotes[0]! : null) : remote() === "-1" ? null : remote(),
      force,
    })
  }

  const confirm = () => {
    if (props.tags.includes(name().trim())) {
      setConflict(true)
      return
    }
    submit(false)
  }

  const t = (key: string) => language.t(key)
  const typeLabel = (v: TagType) =>
    v === "annotated" ? t("session.tab.gitGraph.addTagTypeAnnotated") : t("session.tab.gitGraph.addTagTypeLightweight")

  return (
    <Dialog title="Add Tag" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <Show
          when={conflict()}
          fallback={
            <>
              <p class="text-sm text-text-base">
                Add tag to commit <b>{props.hash.slice(0, 7)}</b>:
              </p>
              <TextField
                label="Name"
                value={name()}
                onChange={(value) => {
                  setName(value)
                  setConflict(false)
                }}
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
                  label="Message"
                  value={message()}
                  onChange={setMessage}
                  placeholder="Optional"
                  description="A message can only be added to an annotated tag."
                />
              </Show>
              <Show when={props.remotes.length === 1}>
                <Checkbox
                  checked={push()}
                  onChange={setPush}
                  description="Once this tag has been added, push it to the repositories remote."
                >
                  Push to remote
                </Checkbox>
              </Show>
              <Show when={props.remotes.length > 1}>
                <Select
                  options={remoteOptions()}
                  current={remoteOptions().find((r) => r.value === remote())}
                  value={(r) => r.value}
                  label={(r) => r.name}
                  onSelect={(r) => setRemote(r?.value ?? "-1")}
                  variant="outline"
                  size="small"
                />
              </Show>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => dialog.close()}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={confirm} disabled={!name().trim()}>
                  Add Tag
                </Button>
              </div>
            </>
          }
        >
          <p class="text-sm text-text-base">
            A tag named <b>{name().trim()}</b> already exists, do you want to replace it with this new tag?
          </p>
          <div class="flex justify-end gap-2">
            <Button onClick={() => submit(true)}>Yes, replace the existing tag</Button>
            <Button variant="ghost" onClick={() => setConflict(false)}>
              No, choose another tag name
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
