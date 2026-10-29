import { For, Show, createMemo, onCleanup } from "solid-js"
import type { NativeCodexSkills } from "@opencode-ai/sdk/v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import type { createNativeSkills } from "@/context/native-skills"
import type { NativeMode, NativePermission } from "@/utils/native"
import type { SlashCommand } from "./slash-popover"

export type NativeSkill = NativeCodexSkills["skills"][number]

export function nativeSlash(input: {
  session?: string
  enabled: boolean
  plan: boolean
  skills: NativeSkill[]
  t: (key: string) => string
}): SlashCommand[] {
  const names = [
    "new",
    ...(input.enabled ? ["model", "permissions"] : []),
    ...(input.enabled && input.plan ? ["plan"] : []),
    ...(input.session ? ["status"] : []),
    "skills",
  ]
  return [
    ...names.map((name) => ({
      id: `native.${name}`,
      trigger: name,
      title: input.t(`native.slash.${name}`),
      description: input.t(`native.slash.${name}`),
      type: "native" as const,
    })),
    ...input.skills.map((skill) => ({
      id: `native.skill.${encodeURIComponent(skill.name)}.${encodeURIComponent(skill.path)}`,
      trigger: skill.name,
      title: skill.displayName || skill.name,
      description: `${skill.description} · ${skill.path}`,
      type: "skill" as const,
      source: "skill" as const,
      skill,
    })),
  ]
}

export function NativeChoice(props: { kind: "model" | "permissions" | "plan"; valid: () => boolean }) {
  const native = useLocal().native
  const language = useLanguage()
  const dialog = useDialog()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const items = createMemo(() => {
    if (props.kind === "model")
      return (native.status()?.models ?? []).map((model) => ({
        id: model.id,
        title: model.name,
        description: model.id,
      }))
    if (props.kind === "plan")
      return (["default", ...(native.status()?.capabilities?.plan ? ["plan"] : [])] as NativeMode[]).map((id) => ({
        id,
        title: language.t(`native.mode.${id}`),
        description: language.t("native.mode.next"),
      }))
    return (["user", ...(native.status()?.permissions?.auto ? ["auto"] : []), "full"] as NativePermission[]).map(
      (id) => ({
        id,
        title: language.t(`native.permission.${id}`),
        description: language.t(`native.permission.${id}.description`),
      }),
    )
  })
  return (
    <Dialog title={language.t(`native.slash.${props.kind}`)}>
      <Show when={native.permissionError()}>
        {(error) => (
          <div role="alert" class="px-4 text-12-regular text-text-weak">
            {error()}
          </div>
        )}
      </Show>
      <List
        items={items}
        key={(item) => item.id}
        filterKeys={["title", "description"]}
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t(native.loading() ? "native.checking" : "native.chooseModel")}
        onSelect={async (item) => {
          if (!item || disposed || !props.valid() || native.saving() || !native.enabled()) return
          if (props.kind === "model") native.setModel(item.id)
          if (props.kind === "permissions") await native.setPermission(item.id as NativePermission)
          if (props.kind === "plan") await native.setMode(item.id as NativeMode)
          if (!disposed && props.valid() && (props.kind === "model" || !native.permissionError())) dialog.close()
        }}
      >
        {(item) => (
          <div class="flex flex-col gap-1 min-w-0">
            <span>{item.title}</span>
            <span class="text-12-regular text-text-weak whitespace-normal">{item.description}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}

export function NativeSkills(props: {
  catalog: ReturnType<typeof createNativeSkills>
  onSelect: (skill: NativeSkill) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <Dialog title={language.t("native.slash.skills")}>
      <div class="px-4 pb-2 flex flex-col gap-2">
        <Button
          size="small"
          variant="secondary"
          disabled={props.catalog.loading()}
          onClick={() => void props.catalog.refresh()}
        >
          {language.t(props.catalog.loading() ? "common.loading" : "native.skills.refresh")}
        </Button>
        <Show when={props.catalog.error()}>
          {(error) => (
            <div role="alert" class="text-12-regular text-text-weak break-words">
              {error()}
            </div>
          )}
        </Show>
        <For each={props.catalog.data()?.errors ?? []}>
          {(error) => (
            <div role="status" class="text-12-regular text-text-weak break-words">
              {error}
            </div>
          )}
        </For>
      </div>
      <List
        items={() => props.catalog.data()?.skills ?? []}
        key={(skill) => JSON.stringify([skill.name, skill.path])}
        filterKeys={["name", "displayName", "description"]}
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t(
          props.catalog.loading()
            ? "common.loading"
            : props.catalog.data()?.state === "disabled"
              ? "native.disabledShort"
              : "native.skills.empty",
        )}
        onSelect={(skill) => {
          if (!skill || props.catalog.loading()) return
          props.onSelect(skill)
          dialog.close()
        }}
      >
        {(skill) => (
          <div class="flex flex-col gap-1 min-w-0">
            <span>{skill.displayName || skill.name}</span>
            <span class="text-12-regular text-text-weak whitespace-normal">{skill.description}</span>
            <span class="text-11-regular text-text-subtle truncate" title={skill.path}>
              {skill.path}
            </span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
