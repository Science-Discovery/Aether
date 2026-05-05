import { createMemo, createSignal, onMount, Show, batch } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Select } from "@opencode-ai/ui/select"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { computeGraphLayout, UNCOMMITTED, ROW_HEIGHT } from "./model"
import { GitGraphList } from "./render"

export function GitGraphTab() {
  const sdk = useSDK()
  const language = useLanguage()
  const { view } = useSessionLayout()

  type Data = Awaited<ReturnType<typeof sdk.client.vcs.graph>>
  const [data, setData] = createSignal<Data | null>(null)
  const [filter, setFilter] = createSignal("all")
  const [uncommittedFiles, setUncommittedFiles] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  let version = 0

  const load = async (b?: string, skip?: number) => {
    const v = ++version
    setLoading(true)
    try {
      const result = await sdk.client.vcs.graph({
        max: skip ? 100 : 300,
        branch: b,
        skip,
      })
      if (v !== version) return
      if (skip) {
        const current = data()
        if (!current?.data || !result.data) return
        setData({
          ...result,
          data: {
            ...result.data,
            commits: [...current.data.commits, ...result.data.commits],
          },
        })
      } else {
        setData(result)
      }
    } catch {
      if (v !== version) return
      if (!skip) setData(null)
    } finally {
      if (v === version) setLoading(false)
    }
  }

  const loadDiff = async () => {
    try {
      const result = await sdk.client.vcs.diff({ mode: "git" })
      if (result.data) {
        setUncommittedFiles(result.data.map((d) => d.file))
      }
    } catch {}
  }

  onMount(() => {
    void load()
    void loadDiff()
  })

  const branchOptions = createMemo(() => {
    const raw = data()
    if (!raw?.data) return ["all"]
    const seen = new Set<string>()
    for (const c of raw.data.commits) {
      for (const h of c.heads) seen.add(h)
    }
    return ["all", "current", ...seen]
  })

  const graph = createMemo(() => {
    const raw = data()
    if (!raw?.data) return null
    let commits = [...raw.data.commits]
    const files = uncommittedFiles()
    if (files.length > 0) {
      const headCommit = raw.data.commits.find((c) => c.heads.includes(raw.data.head ?? ""))
      commits = [
        {
          hash: UNCOMMITTED,
          parents: headCommit ? [headCommit.hash] : [],
          author: "",
          email: "",
          date: Math.floor(Date.now() / 1000),
          message: `Uncommitted Changes (${files.length})`,
          heads: [],
          tags: [],
          remotes: [],
        },
        ...commits,
      ]
    }
    return computeGraphLayout(commits, raw.data.head)
  })

  const uncommitted = createMemo(() => {
    const files = uncommittedFiles()
    if (files.length === 0) return undefined
    return { count: files.length, files }
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

    const el = event.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      const raw = data()
      if (raw?.data?.moreAvailable && !loading()) {
        const nextSkip = raw.data.commits.length
        void load(
          filter() === "all" ? undefined : filter() === "current" ? (raw.data.head ?? undefined) : filter(),
          nextSkip,
        )
      }
    }
  }

  const scrollToHead = () => {
    const graphData = graph()
    if (!graphData || !scroll) return
    const currentBranch = data()?.data?.head
    const headNode = graphData.nodes.find((n) => currentBranch && n.heads.includes(currentBranch))
    if (!headNode) return
    const y = headNode.row * ROW_HEIGHT - scroll.clientHeight / 2
    scroll.scrollTo({ top: Math.max(0, y), behavior: "smooth" })
  }

  const branchLabel = (b: string) => {
    if (b === "all") return language.t("session.tab.gitGraph.allBranches") ?? "All Branches"
    if (b === "current")
      return (
        (language.t("session.tab.gitGraph.currentBranch") ?? "Current Branch") + ` (${data()?.data?.head ?? "HEAD"})`
      )
    return b
  }

  const handleBranchSelect = (b: string | undefined) => {
    if (!b) return
    const apiBranch = b === "all" ? undefined : b === "current" ? data()?.data?.head : b
    batch(() => {
      setFilter(b)
      setData(null)
    })
    void load(apiBranch ?? undefined)
  }

  return (
    <div class="flex flex-col h-full overflow-hidden contain-strict">
      <div class="flex items-center gap-2 px-2 py-1 border-b border-border-weaker-base shrink-0">
        <Select
          options={branchOptions()}
          current={filter()}
          label={branchLabel}
          onSelect={handleBranchSelect}
          variant="ghost"
          size="small"
          valueClass="text-12-regular"
        />
        <div class="flex-1" />
        <IconButton
          icon="arrow-down-to-line"
          variant="ghost"
          class="h-6 w-6"
          onClick={scrollToHead}
          aria-label={language.t("session.tab.gitGraph.scrollToHead") ?? "Scroll to HEAD"}
        />
      </div>

      <Show
        when={graph()}
        fallback={
          <div class="flex-1 flex items-center justify-center">
            <div class="text-12-regular text-text-weak">
              {data() || loading()
                ? language.t("session.review.loadingChanges")
                : language.t("common.loading.ellipsis")}
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
            <GitGraphList
              nodes={g().nodes}
              edges={g().edges}
              lanes={g().lanes}
              currentBranch={data()?.data?.head}
              uncommitted={uncommitted()}
            />
          </ScrollView>
        )}
      </Show>
    </div>
  )
}
