import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useKnowledge } from "@/context/knowledge"
import { useLanguage } from "@/context/language"

export function KnowledgeStatus() {
  const knowledge = useKnowledge()
  const language = useLanguage()
  return (
    <Show when={!knowledge.ready()}>
      <div class="flex items-center justify-between gap-3 text-12-regular text-text-weak" role="status">
        <span>{language.t(knowledge.error() ? "knowledge.loadFailed" : "knowledge.loading")}</span>
        <Show when={knowledge.error()}>
          <Button variant="secondary" size="small" onClick={() => void knowledge.retry()}>
            {language.t("common.retry")}
          </Button>
        </Show>
      </div>
    </Show>
  )
}
