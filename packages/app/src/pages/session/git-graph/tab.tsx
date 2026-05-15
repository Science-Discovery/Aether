import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Select } from "@opencode-ai/ui/select"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "@/pages/session/session-layout"
import { computeGraphLayout, UNCOMMITTED, ROW_HEIGHT } from "./model"
import { GitGraphList } from "./render"
import { GitGraphMenu } from "./menu"
import type { Ref } from "./refs"

export function GitGraphTab() {
  const sdk = useSDK()
  const language = useLanguage()
  const { view } = useSessionLayout()
  const terminal = useTerminal()
  const dialog = useDialog()

  type Data = Awaited<ReturnType<typeof sdk.client.vcs.graph>>
  type Target =
    | { kind: "commit"; hash: string; x: number; y: number }
    | { kind: "ref"; hash: string; ref: Ref; x: number; y: number }
  const [data, setData] = createSignal<Data | null>(null)
  const [filter, setFilter] = createSignal("all")
  const [uncommittedFiles, setUncommittedFiles] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [selectedHash, setSelectedHash] = createSignal<string | null>(null)
  const [menu, setMenu] = createSignal<Target | null>(null)
  const [alwaysCheckout, setAlwaysCheckout] = createSignal(false)
  let version = 0

  const pendingGitPtyIds = new Set<string>()

  const runGit = async (command: string, args: string[], title: string) => {
    const id = await terminal.run(command, args, title)
    if (id) pendingGitPtyIds.add(id)
  }

  const branchArg = (b = filter()) => {
    const raw = data()
    if (b === "all") return undefined
    if (b === "current") return raw?.data?.branch ?? raw?.data?.head ?? undefined
    return b
  }

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
        if (result.data) {
          setData(result)
        } else {
          setData(null)
        }
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

  const unsubPty = sdk.event.on("pty.exited", (event) => {
    if (pendingGitPtyIds.has(event.properties.id)) {
      pendingGitPtyIds.delete(event.properties.id)
      void load(branchArg())
      void loadDiff()
    }
  })
  onCleanup(unsubPty)

  const branchOptions = createMemo(() => {
    const raw = data()
    if (!raw?.data) return ["all"]
    return ["all", "current", ...raw.data.branches]
  })

  const menuData = createMemo(() => {
    const raw = data()
    if (!raw?.data) return null
    return {
      commits: raw.data.commits,
      head: raw.data.head,
      branch: raw.data.branch,
      branches: raw.data.branches,
      tags: raw.data.tags,
      remotes: raw.data.remotes,
    }
  })

  const graph = createMemo(() => {
    const raw = data()
    if (!raw?.data) return null
    try {
      let commits = [...raw.data.commits]
      const files = uncommittedFiles()
      if (files.length > 0) {
        const headCommit = raw.data.commits.find((c) => c.hash === raw.data.head)
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
    } catch (e) {
      console.error("[git-graph] graph() memo threw:", e, {
        head: raw.data.head,
        commitsCount: raw.data.commits.length,
        uncommittedCount: uncommittedFiles().length,
      })
      return null
    }
  })

  const uncommitted = createMemo(() => {
    const files = uncommittedFiles()
    if (files.length === 0) return undefined
    return { count: files.length, files }
  })

  const parentHash = createMemo(() => {
    const hash = selectedHash()
    if (!hash) return null
    const raw = data()
    if (!raw?.data) return null
    const commit = raw.data.commits.find((c) => c.hash === hash)
    return commit?.parents[0] ?? null
  })

  const fetchable = createMemo(() => (data()?.data?.remotes.length ?? 0) > 0)

  const fetchRemotes = () => {
    if (!fetchable()) return
    void runGit("git", ["fetch", "--all"], "Fetching from Remote(s)")
  }

  const refresh = () => {
    if (loading()) return
    void load(branchArg())
    void loadDiff()
  }

  const handleCommitClick = (hash: string) => {
    if (hash === UNCOMMITTED) return
    setSelectedHash((prev) => (prev === hash ? null : hash))
  }

  const handleContextMenu = (hash: string, event: MouseEvent) => {
    if (hash === UNCOMMITTED) return
    event.preventDefault()
    setSelectedHash(hash)
    setMenu({
      kind: "commit",
      hash,
      x: event.clientX,
      y: event.clientY,
    })
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0)
  }

  const handleRefContextMenu = (hash: string, ref: Ref, event: MouseEvent) => {
    if (hash === UNCOMMITTED) return
    event.preventDefault()
    setSelectedHash(hash)
    setMenu({
      kind: "ref",
      hash,
      ref,
      x: event.clientX,
      y: event.clientY,
    })
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0)
  }

  const closeMenu = () => {
    document.removeEventListener("click", closeMenu)
    setMenu(null)
  }

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
        void load(branchArg(), nextSkip)
      }
    }
  }

  const scrollToHead = () => {
    const graphData = graph()
    if (!graphData || !scroll) return
    const head = data()?.data?.head
    const headNode = graphData.nodes.find((n) => n.hash === head)
    if (!headNode) return
    const y = headNode.row * ROW_HEIGHT - scroll.clientHeight / 2
    scroll.scrollTo({ top: Math.max(0, y), behavior: "smooth" })
  }

  const branchLabel = (b: string) => {
    if (b === "all") return language.t("session.tab.gitGraph.allBranches") ?? "All Branches"
    if (b === "current")
      return (
        (language.t("session.tab.gitGraph.currentBranch") ?? "Current Branch") +
        ` (${data()?.data?.branch ?? data()?.data?.head ?? "HEAD"})`
      )
    return b
  }

  const handleBranchSelect = (b: string | undefined) => {
    if (!b) return
    if (b === filter()) return
    setFilter(b)
    void load(branchArg(b))
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
          icon="download"
          variant="ghost"
          class="h-6 w-6"
          disabled={!fetchable()}
          title={fetchable() ? "Fetch from Remote(s)" : "No remotes configured"}
          onClick={fetchRemotes}
          aria-label="Fetch from Remote(s)"
        />
        <IconButton
          icon="refresh"
          variant="ghost"
          class="h-6 w-6"
          disabled={loading()}
          title={loading() ? "Refreshing" : "Refresh"}
          onClick={refresh}
          aria-label={loading() ? "Refreshing" : "Refresh"}
        />
        <IconButton
          icon="arrow-down-to-line"
          variant="ghost"
          class="h-6 w-6"
          onClick={scrollToHead}
          aria-label={language.t("session.tab.gitGraph.scrollToHead") ?? "Scroll to HEAD"}
        />
      </div>

      <div class="flex-1 min-h-0">
        <Show
          when={graph()}
          fallback={
            <div class="flex-1 flex items-center justify-center">
              <div class="text-12-regular text-text-weak">
                {data()?.data || loading()
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
                lines={g().lines}
                lanes={g().lanes}
                graphWidth={g().graphWidth}
                currentBranch={data()?.data?.branch}
                uncommitted={uncommitted()}
                selectedHash={selectedHash()}
                selectedParentHash={parentHash()}
                onCommitClick={handleCommitClick}
                onCloseDetail={() => setSelectedHash(null)}
                onContextMenu={handleContextMenu}
                onRefContextMenu={handleRefContextMenu}
              />
            </ScrollView>
          )}
        </Show>
      </div>
      <Show when={menu()}>
        {(target) => (
          <Show when={menuData()}>
            {(info) => (
              <GitGraphMenu
                target={target()}
                data={info()}
                alwaysCheckout={alwaysCheckout()}
                onAlwaysCheckout={setAlwaysCheckout}
                onClose={closeMenu}
                onRun={(cmd) => runGit("git", cmd.args, cmd.title)}
                onShow={(node) => {
                  closeMenu()
                  dialog.show(node)
                }}
              />
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}
