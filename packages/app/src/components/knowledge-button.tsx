import { Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { KnowledgeDialog } from "./knowledge-dialog"
import { useKnowledge } from "@/context/knowledge"

export const KnowledgeButton: Component = () => {
  const knowledge = useKnowledge()
  const dialog = useDialog()

  const label = () => {
    const list = knowledge.activeKnowledgeBases()
    if (list.length === 0) {
      return "知识库：无"
    }
    const text = list.map((kb) => `${kb.name}(${kb.pdfFileCount ?? kb.documentCount ?? 0})`).join(", ")
    return `知识库：${text}`
  }

  const handleClick = () => {
    dialog.show(() => <KnowledgeDialog />)
  }

  return (
    <Tooltip placement="top" gutter={4} value={<span>{label()}</span>}>
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
