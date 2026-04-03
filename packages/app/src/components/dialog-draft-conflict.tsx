import type { Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"

export const DialogDraftConflict: Component<{
  onAccept: VoidFunction
  onDiscard: VoidFunction
}> = (props) => {
  const dialog = useDialog()

  const accept = () => {
    dialog.close()
    props.onAccept()
  }

  const discard = () => {
    dialog.close()
    props.onDiscard()
  }

  return (
    <Dialog
      title="检测到内容冲突"
      description="当前文件在该草稿创建后已发生变化。继续保存会覆盖当前真实文件中的部分内容。review 中显示的是当前真实变更，请确认是否继续。"
      persistent
    >
      <div class="flex items-center justify-end gap-2 p-4">
        <Button variant="ghost" onClick={() => dialog.close()}>
          取消
        </Button>
        <Button variant="secondary" onClick={discard}>
          放弃草稿
        </Button>
        <Button onClick={accept}>接受覆盖并保存</Button>
      </div>
    </Dialog>
  )
}
