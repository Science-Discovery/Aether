import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { computeGraphLayout } from "./model"
import { GitGraphList } from "./render"

export function GitGraphTab() {
  const sdk = useSDK()
  const language = useLanguage()
  const { view } = useSessionLayout()

  const [data, setData] = createSignal<Awaited<ReturnType<typeof sdk.client.vcs.graph>> | null>(null)

  const load = async () => {
    try {
      const result = await sdk.client.vcs.graph({ max: 300 })
      setData(result)
    } catch {
      setData(null)
    }
  }

  onMount(() => {
    void load()
  })

  const graph = createMemo(() => {
    const raw = data()
    if (!raw?.data) return null
    return computeGraphLayout(raw.data.commits, raw.data.head)
  })

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const next = pending
      pending = undefined
      if (!next) return
      view().setScroll("git-graph", next)
    })
  }

  return (
    <div class="flex flex-col h-full overflow-hidden contain-strict">
      <Show
        when={graph()}
        fallback={
          <div class="flex-1 flex items-center justify-center">
            <div class="text-12-regular text-text-weak">
              {data() ? language.t("session.review.loadingChanges") : language.t("common.loading.ellipsis")}
            </div>
          </div>
        }
      >
        {(g) => (
          <ScrollView
            class="h-full"
            onScroll={handleScroll}
            viewportRef={(el) => {
              scroll = el
              const s = view().scroll("git-graph")
              if (s) {
                requestAnimationFrame(() => {
                  if (el.scrollTop !== s.y) el.scrollTop = s.y
                  if (el.scrollLeft !== s.x) el.scrollLeft = s.x
                })
              }
            }}
          >
            <GitGraphList nodes={g().nodes} edges={g().edges} lanes={g().lanes} />
          </ScrollView>
        )}
      </Show>
    </div>
  )
}
