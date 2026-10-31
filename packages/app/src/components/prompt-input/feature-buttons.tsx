import { Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { KnowledgeButton } from "@/components/knowledge-button"
import { DialogEvolvedSkills } from "@/skill-evolution/dialog-evolved-skills"

export function FeatureButtons(props: { sessionID?: string; style?: JSX.CSSProperties }) {
  const sync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()

  return (
    <>
      <Show when={sync.ready && sync.data.config.knowledge?.enabled === true}>
        <div style={props.style}>
          <KnowledgeButton sessionID={props.sessionID} />
        </div>
      </Show>
      <Show when={sync.ready && sync.data.config.skills?.evolution_enabled === true}>
        <Tooltip placement="top" gutter={4} value={language.t("evolvedSkills.title")}>
          <Button
            variant="ghost"
            size="normal"
            class="h-7 w-7 p-0 flex items-center justify-center text-icon-weak shrink-0"
            onClick={() => dialog.show(() => <DialogEvolvedSkills />)}
            aria-label={language.t("evolvedSkills.title")}
          >
            <Icon name="list-square" class="size-4" />
          </Button>
        </Tooltip>
      </Show>
    </>
  )
}
