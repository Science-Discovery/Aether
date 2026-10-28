import { createMemo, Show } from "solid-js"
import { A } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"

export function NativeForkSource(props: { session?: Session }) {
  const sync = useSync()
  const language = useLanguage()
  const source = createMemo(() =>
    props.session?.engine?.type === "codex" ? props.session.forkParentSessionID : undefined,
  )
  return (
    <Show when={source()}>
      {(id) => (
        <div class="px-4 py-1 text-12-regular text-text-weak" data-component="native-fork-source">
          <A
            href={`/${base64Encode(sync.session.get(id())?.directory ?? props.session!.directory)}/session/${id()}`}
            class="hover:text-text-strong underline underline-offset-2"
          >
            {language.t("native.fork.source", {
              title: sync.session.get(id())?.title || language.t("native.fork.original"),
            })}
          </A>
        </div>
      )}
    </Show>
  )
}
