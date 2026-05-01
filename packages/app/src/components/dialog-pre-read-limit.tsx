import type { Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"

export const DialogPreReadLimit: Component<{
  title: string
  description: string
  cancel: string
  confirm: string
  onConfirm: VoidFunction
}> = (props) => {
  const dialog = useDialog()

  const close = () => {
    dialog.close()
  }

  const confirm = () => {
    dialog.close()
    props.onConfirm()
  }

  return (
    <Dialog title={props.title} fit class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">{props.description}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {props.cancel}
          </Button>
          <Button onClick={confirm}>{props.confirm}</Button>
        </div>
      </div>
    </Dialog>
  )
}
