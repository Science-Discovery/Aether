import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import type { NativeMode, NativePermission } from "@/utils/native"
import { VariantSelect } from "./prompt-input/variant-select"
import { NativeHistoryControl } from "./native-history"

export function EngineSelect() {
  const local = useLocal()
  const language = useLanguage()
  return (
    <Select<"aether" | "codex">
      options={local.native.enabled() || local.native.engine() ? ["aether", "codex"] : ["aether"]}
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
        disabled={!native.enabled() || native.loading()}
        variant="ghost"
        size="normal"
        class="min-w-0 max-w-[240px]"
        valueClass="truncate text-13-regular text-text-base"
        triggerProps={{ "data-action": "prompt-native-model", "aria-label": language.t("native.chooseModel") }}
      />
      <Show when={native.enabled() && (native.model()?.efforts.length ?? 0) > 0}>
        <VariantSelect
          variants={native.model()?.efforts ?? []}
          current={native.effort()}
          label={language.t("common.default")}
          provider="Codex"
          onSelect={native.setEffort}
        />
      </Show>
      <Tooltip value={language.t("native.mode.next")}>
        <div>
          <Select<NativeMode>
            options={
              native.status()?.capabilities?.plan || native.mode() === "plan" ? ["default", "plan"] : ["default"]
            }
            current={native.mode()}
            label={(value) => language.t(`native.mode.${value}`)}
            onSelect={(value) => value && void native.setMode(value)}
            disabled={!native.enabled() || native.loading() || native.saving()}
            variant="ghost"
            size="normal"
            valueClass="truncate text-13-regular text-text-base"
            triggerProps={{ "data-action": "prompt-native-mode", "aria-label": language.t("native.mode") }}
          />
        </div>
      </Tooltip>
      <Show when={native.enabled() && !native.loading() && !native.status()?.capabilities?.plan}>
        <span role="status" class="text-12-regular text-text-weak" title={native.status()?.capabilities?.error}>
          {language.t("native.mode.unavailable")}
        </span>
      </Show>
      <Show when={!native.enabled()}>
        <span role="status" class="text-12-regular text-text-weak">
          {language.t("native.disabledShort")}
        </span>
      </Show>
      <Show when={native.enabled() && !native.ready() && !native.loading() && !native.saving()}>
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
      <Tooltip
        value={`${language.t(`native.permission.${native.permission()}.description`)} ${language.t("native.permission.next")}`}
      >
        <div>
          <Select<NativePermission>
            options={["user", "auto", "full"]}
            current={native.permission()}
            label={(value) => language.t(`native.permission.${value}`)}
            onSelect={(value) => value && void native.setPermission(value)}
            disabled={!native.enabled() || native.saving()}
            variant="ghost"
            size="normal"
            valueClass="truncate text-13-regular text-text-base"
            triggerProps={{ "data-action": "prompt-native-permission", "aria-label": language.t("native.permission") }}
          >
            {(value) =>
              value && (
                <div class="max-w-[280px]">
                  <div>{language.t(`native.permission.${value}`)}</div>
                  <div class="text-12-regular text-text-weak whitespace-normal">
                    {language.t(`native.permission.${value}.description`)}
                  </div>
                </div>
              )
            }
          </Select>
        </div>
      </Tooltip>
      <Show when={native.saving()}>
        <span role="status" class="text-12-regular text-text-weak">
          {language.t("native.settings.saving")}
        </span>
      </Show>
      <Show when={native.permissionError()}>
        {(error) => (
          <span role="alert" class="text-12-regular text-text-weak">
            {language.t("native.settings.failed", { error: error() })}
          </span>
        )}
      </Show>
      <Show
        when={
          native.enabled() && native.permission() === "auto" && !native.loading() && !native.status()?.permissions?.auto
        }
      >
        <span role="status" class="text-12-regular text-text-weak">
          {language.t("native.permission.unavailable")}
        </span>
      </Show>
      <NativeHistoryControl />
    </>
  )
}
