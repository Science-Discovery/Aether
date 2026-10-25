import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { VariantSelect } from "./prompt-input/variant-select"

export function EngineSelect() {
  const local = useLocal()
  const language = useLanguage()
  const options = ["aether", "codex"] as const
  return (
    <Select<"aether" | "codex">
      options={[...options]}
      current={local.native.known() ? (local.native.engine() ? "codex" : "aether") : undefined}
      placeholder={language.t("common.loading")}
      label={(value) => (value === "codex" ? "Codex" : "Aether")}
      onSelect={(value) => value && local.native.select(value)}
      disabled={local.native.locked()}
      variant="ghost"
      size="normal"
      valueClass="truncate text-13-regular text-text-base"
      triggerProps={{ "data-action": "prompt-engine", "aria-label": language.t("native.engine") }}
    />
  )
}

export function NativeModels() {
  const native = useLocal().native
  const language = useLanguage()
  return (
    <>
      <Select
        options={native.status()?.models ?? []}
        current={native.model()}
        value={(model) => model.id}
        label={(model) => model.name}
        onSelect={(model) => model && native.setModel(model.id)}
        placeholder={language.t(native.loading() ? "native.checking" : "native.chooseModel")}
        disabled={native.loading()}
        variant="ghost"
        size="normal"
        class="min-w-0 max-w-[240px]"
        valueClass="truncate text-13-regular text-text-base"
        triggerProps={{ "data-action": "prompt-native-model", "aria-label": language.t("native.chooseModel") }}
      />
      <Show when={(native.model()?.efforts.length ?? 0) > 0}>
        <VariantSelect
          variants={native.model()?.efforts ?? []}
          current={native.effort()}
          label={language.t("common.default")}
          provider="Codex"
          onSelect={native.setEffort}
        />
      </Show>
      <Show when={!native.ready() && !native.loading()}>
        <Button
          variant="ghost"
          size="small"
          onClick={() => void native.refresh()}
          title={language.t("native.notReady")}
          aria-label={language.t("native.refresh")}
          data-action="prompt-native-refresh"
        >
          {language.t("native.refresh")}
        </Button>
      </Show>
      <Tooltip value={language.t("native.permissions")}>
        <span class="flex items-center p-1 text-icon-weak" aria-label={language.t("native.permissions")}>
          <Icon name="shield" size="small" />
        </span>
      </Tooltip>
    </>
  )
}
