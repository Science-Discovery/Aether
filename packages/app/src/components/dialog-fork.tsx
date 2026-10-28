import { Component, createMemo, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import type { TextPart as SDKTextPart } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSessionFork } from "@/pages/session/use-session-fork"

interface ForkableMessage {
  id: string
  text: string
  time: string
}

function formatTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const DialogFork: Component = () => {
  const params = useParams()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const fork = useSessionFork()
  const native = () => sync.data.session.find((item) => item.id === params.id)?.engine?.type === "codex"

  const messages = createMemo((): ForkableMessage[] => {
    const sessionID = params.id
    if (!sessionID) return []

    const msgs = sync.data.message[sessionID] ?? []
    const result: ForkableMessage[] = []

    for (const message of msgs) {
      if (message.role !== "user") continue

      const parts = sync.data.part[message.id] ?? []
      const textPart = parts.find((x): x is SDKTextPart => x.type === "text" && !x.synthetic && !x.ignored)
      if (!textPart) continue
      if (native() && /^\s*<send_user_message_question_reply>/.test(textPart.text)) continue

      result.push({
        id: message.id,
        text: textPart.text.replace(/\n/g, " ").slice(0, 200),
        time: formatTime(new Date(message.time.created)),
      })
    }

    return result.reverse()
  })

  const handleSelect = (item: ForkableMessage | undefined) => {
    if (!item) return

    const sessionID = params.id
    if (!sessionID) return

    void fork({ sessionID, messageID: item.id }, "fork", () => dialog.close())
  }

  return (
    <Dialog title={language.t("command.session.fork")}>
      <Show when={native()}>
        <p class="px-6 pb-3 text-12-regular text-text-weak">{language.t("dialog.fork.native")}</p>
      </Show>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.fork.empty")}
        key={(x) => x.id}
        items={messages}
        filterKeys={["text"]}
        onSelect={handleSelect}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span class="truncate flex-1 min-w-0 text-left font-normal">{item.text}</span>
            <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
