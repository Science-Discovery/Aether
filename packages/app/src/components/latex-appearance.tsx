import type { JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"

export function LatexAppearance() {
  const language = useLanguage()
  const settings = useSettings()
  return (
    <section class="flex flex-col gap-3" data-component="latex-appearance">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-14-medium text-text-strong">{language.t("latex.appearance")}</h3>
        <Button
          size="small"
          variant="ghost"
          onClick={() => settings.latex.reset()}
          data-action="latex-appearance-reset"
        >
          {language.t("latex.appearance.reset")}
        </Button>
      </div>
      <p class="text-12-regular text-text-weak">{language.t("latex.appearance.help")}</p>
      <SettingsList>
        <Row title={language.t("latex.appearance.mode")}>
          <Select
            options={["auto", "light", "dark"] as const}
            current={settings.latex.mode()}
            label={(value) => language.t(`latex.appearance.mode.${value}`)}
            onSelect={(value) => value && settings.latex.setMode(value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            data-action="latex-appearance-mode"
            triggerProps={{ "aria-label": language.t("latex.appearance.mode") }}
          />
        </Row>
        <Row title={language.t("latex.appearance.size")}>
          <Select
            options={Array.from({ length: 9 }, (_, index) => index + 12)}
            current={settings.latex.size()}
            value={(value) => String(value)}
            label={(value) => `${value} px`}
            onSelect={(value) => value !== undefined && settings.latex.setSize(value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            data-action="latex-appearance-size"
            triggerProps={{ "aria-label": language.t("latex.appearance.size") }}
          />
        </Row>
        <Row title={language.t("latex.appearance.spacing")}>
          <Select
            options={["compact", "normal", "wide"] as const}
            current={settings.latex.spacing()}
            label={(value) => language.t(`latex.appearance.spacing.${value}`)}
            onSelect={(value) => value && settings.latex.setSpacing(value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            data-action="latex-appearance-spacing"
            triggerProps={{ "aria-label": language.t("latex.appearance.spacing") }}
          />
        </Row>
      </SettingsList>
      <p class="text-12-regular text-text-weak">{language.t("latex.appearance.font")}</p>
    </section>
  )
}

function Row(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border-weak-base py-3 last:border-none">
      <span class="text-14-medium text-text-strong">{props.title}</span>
      {props.children}
    </div>
  )
}
