import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import { TextField } from "@opencode-ai/ui/text-field"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSDK } from "@/context/sdk"

type DefaultSkill = { name: string; description: string; content: string }
type EditState = { mode: "none" } | { mode: "edit"; skill: DefaultSkill } | { mode: "new" }

export const DialogDefaultSkills: Component = () => {
  const globalSDK = useGlobalSDK()
  const sdk = useSDK()
  const dialog = useDialog()

  const [skills, { refetch }] = createResource<DefaultSkill[]>(async () => {
    const result = await globalSDK.client.config.skills.list()
    return ((result.data as unknown) as DefaultSkill[]) ?? []
  })

  const [edit, setEdit] = createSignal<EditState>({ mode: "none" })
  const [adding, setAdding] = createSignal(false)
  const [deleting, setDeleting] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [form, setForm] = createStore({ name: "", description: "", content: "" })

  function openNew() {
    setForm({ name: "", description: "", content: "" })
    setEdit({ mode: "new" })
  }

  function openEdit(skill: DefaultSkill) {
    setForm({ name: skill.name, description: skill.description, content: skill.content })
    setEdit({ mode: "edit", skill })
  }

  function cancelEdit() {
    setEdit({ mode: "none" })
  }

  async function handleSave() {
    if (!form.name.trim()) {
      showToast({ variant: "error", icon: "circle-x", title: "名称不能为空" })
      return
    }
    setSaving(true)
    try {
      await globalSDK.client.config.skills.save({
        name: form.name.trim(),
        description: form.description.trim(),
        content: form.content,
      })
      await refetch()
      setEdit({ mode: "none" })
      showToast({ variant: "success", icon: "circle-check", title: "Skill 已保存" })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", icon: "circle-x", title: "保存失败", description: message })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(name: string) {
    setDeleting(name)
    try {
      await globalSDK.client.config.skills.delete({ name })
      await refetch()
      showToast({ icon: "check", title: `已删除 ${name}` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", icon: "circle-x", title: "删除失败", description: message })
    } finally {
      setDeleting(null)
    }
  }

  async function handleAddToProject() {
    setAdding(true)
    try {
      const result = await globalSDK.client.config.skills.addDefaults({ directory: sdk.directory })
      const added = ((result.data as unknown) as { added: string[] }).added
      if (added.length > 0) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Skills 已复制到项目",
          description: `已复制：${added.join(", ")}`,
        })
      } else {
        showToast({ icon: "check", title: "已是最新", description: "默认 Skills 已全部存在于项目中" })
      }
      dialog.close()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", icon: "circle-x", title: "添加失败", description: message })
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog
      title="默认 Skills"
      action={
        <div class="flex items-center gap-1.5 -my-1">
          <Button variant="secondary" size="small" onClick={openNew}>
            <Icon name="plus" size="small" />
            新建
          </Button>
          <Button variant="primary" size="small" disabled={adding()} onClick={handleAddToProject}>
            <Icon name="download" size="small" />
            {adding() ? "添加中..." : "添加到项目"}
          </Button>
        </div>
      }
    >
      <div class="flex flex-col gap-3 min-h-0">
        {/* Skill list */}
        <Switch>
          <Match when={skills.loading}>
            <div class="text-12-regular text-text-weak px-1">加载中...</div>
          </Match>
          <Match when={skills()?.length === 0 && edit().mode === "none"}>
            <div class="text-12-regular text-text-weak px-1">
              暂无默认 Skills，点击「新建」创建第一个
            </div>
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-1.5 overflow-y-auto max-h-80">
              <For each={skills()}>
                {(skill) => (
                  <div class="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border border-border-weak-base bg-surface-base hover:border-border-base transition-colors">
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-13-medium text-text-strong truncate">{skill.name}</span>
                      <Show when={skill.description}>
                        <span class="text-12-regular text-text-weak line-clamp-2">{skill.description}</span>
                      </Show>
                      <Show when={!skill.description}>
                        <span class="text-12-regular text-text-subtle italic">暂无描述</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                      <IconButton
                        icon="edit"
                        variant="ghost"
                        size="small"
                        aria-label="编辑"
                        onClick={() => openEdit(skill)}
                      />
                      <IconButton
                        icon="trash"
                        variant="ghost"
                        size="small"
                        aria-label="删除"
                        disabled={deleting() === skill.name}
                        onClick={() => handleDelete(skill.name)}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Match>
        </Switch>

        {/* Edit / New form */}
        <Show when={edit().mode !== "none"}>
          <div class="flex flex-col gap-3 p-3 rounded-lg border border-border-base bg-surface-raised-base">
            <span class="text-13-medium text-text-strong">
              {edit().mode === "new"
                ? "新建 Skill"
                : `编辑：${(edit() as { mode: "edit"; skill: DefaultSkill }).skill.name}`}
            </span>
            <Show when={edit().mode === "new"}>
              <TextField
                label="名称（英文，用作目录名）"
                placeholder="e.g. academic-researcher"
                value={form.name}
                onChange={(v) => setForm("name", v)}
              />
            </Show>
            <TextField
              label="描述"
              placeholder="这个 Skill 的用途..."
              value={form.description}
              onChange={(v) => setForm("description", v)}
            />
            <TextField
              multiline
              label="内容（Markdown）"
              placeholder="Skill 的详细指令..."
              value={form.content}
              onChange={(v) => setForm("content", v)}
              spellcheck={false}
              class="font-mono text-xs min-h-24 max-h-48 overflow-y-auto"
            />
            <div class="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="small" onClick={cancelEdit}>
                取消
              </Button>
              <Button type="button" variant="primary" size="small" disabled={saving()} onClick={handleSave}>
                {saving() ? "保存中..." : "保存"}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
