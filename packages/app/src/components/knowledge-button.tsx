import { Component, Show, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { KnowledgeDialog } from "./knowledge-dialog"
import { useKnowledge } from "@/context/knowledge"
import { useLanguage } from "@/context/language"

export const KnowledgeButton: Component = () => {
  const knowledge = useKnowledge()
  const dialog = useDialog()
  const language = useLanguage()

  const handleClick = () => {
    dialog.show(() => <KnowledgeDialog />)
  }

  return (
    <Tooltip
      placement="top"
      gutter={4}
      value={
        <div class="flex flex-col gap-1">
          <span>{language.t("knowledge.title")}</span>
          <Show when={knowledge.enabled()}>
            <span class="text-12-regular text-text-weak">
              {knowledge.state.documentCount} {language.t("knowledge.documents")}
            </span>
          </Show>
        </div>
      }
    >
      <Button
        variant="ghost"
        size="normal"
        class="h-7 px-2 flex items-center gap-1"
        onClick={handleClick}
        classList={{
          "text-icon-strong-base": knowledge.enabled(),
          "text-icon-weak": !knowledge.enabled(),
        }}
      >
        <Icon
          name="brain"
          class="size-4"
          classList={{
            "text-icon-success-base": knowledge.enabled(),
          }}
        />
      </Button>
    </Tooltip>
  )
}