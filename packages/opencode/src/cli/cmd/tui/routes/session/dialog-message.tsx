import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { Clipboard } from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import { useDialog } from "../../ui/dialog"

function DialogBusyWarning(props: { onFork: () => void }) {
  const dialog = useDialog()

  return (
    <DialogSelect
      title="Task is running"
      options={[
        {
          title: "Cancel",
          value: "cancel",
          description: "close this dialog",
          onSelect: () => dialog.clear(),
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session from this point",
          onSelect: props.onFork,
        },
      ]}
      skipFilter
    />
  )
}

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID] ?? ({ type: "idle" } as const))
  const pending = createMemo(() =>
    (sync.data.message[props.sessionID] ?? []).findLast(
      (msg) => msg.role === "assistant" && typeof msg.time?.completed !== "number",
    ),
  )
  const working = createMemo(() => status().type !== "idle" || !!pending())

  async function fork() {
    const result = await sdk.client.session.fork({
      sessionID: props.sessionID,
      messageID: props.messageID,
    })
    const msg = message()
    const initialPrompt = msg
      ? (sync.data.part[msg.id] ?? []).reduce(
          (agg, part) => {
            if (part.type === "text") {
              if (!part.synthetic) agg.input += part.text
            }
            if (part.type === "file") agg.parts.push(part)
            return agg
          },
          { input: "", parts: [] as PromptInfo["parts"] },
        )
      : undefined
    route.navigate({
      sessionID: result.data!.id,
      type: "session",
      initialPrompt,
    })
    dialog.clear()
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: working() ? "task is running - stop first or fork instead" : "undo messages and file changes",
          onSelect: () => {
            if (working()) {
              dialog.replace(() => <DialogBusyWarning onFork={fork} />)
              return
            }
            const msg = message()
            if (!msg) return

            sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            if (props.setPrompt) {
              const parts = sync.data.part[msg.id]
              const promptInfo = parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(strip(part))
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              props.setPrompt(promptInfo)
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: fork,
        },
      ]}
    />
  )
}
