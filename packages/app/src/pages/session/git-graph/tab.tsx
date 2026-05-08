import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Select } from "@opencode-ai/ui/select"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "@/pages/session/session-layout"
import { DialogSelect } from "@/components/dialog-select"
import { DialogMerge } from "@/components/git-graph/dialog-merge"
import { DialogRebase } from "@/components/git-graph/dialog-rebase"
import { DialogCreateBranch } from "@/components/git-graph/dialog-create-branch"
import { DialogAddTag } from "@/components/git-graph/dialog-add-tag"
import { DialogCherryPick } from "@/components/git-graph/dialog-cherry-pick"
import { computeGraphLayout, UNCOMMITTED, ROW_HEIGHT } from "./model"
import { GitGraphList } from "./render"
import { CommitDetail } from "./detail"

export function GitGraphTab() {
  const sdk = useSDK()
  const language = useLanguage()
  const { view } = useSessionLayout()
  const terminal = useTerminal()
  const dialog = useDialog()

  type Data = Awaited<ReturnType<typeof sdk.client.vcs.graph>>
  const [data, setData] = createSignal<Data | null>(null)
  const [filter, setFilter] = createSignal("all")
  const [uncommittedFiles, setUncommittedFiles] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [selectedHash, setSelectedHash] = createSignal<string | null>(null)
  const [menu, setMenu] = createSignal<{
    hash: string
    message: string
    heads: string[]
    parents: string[]
    x: number
    y: number
  } | null>(null)
  let version = 0

  const pendingGitPtyIds = new Set<string>()

  const runGit = async (command: string, args: string[], title: string) => {
    const id = await terminal.run(command, args, title)
    if (id) pendingGitPtyIds.add(id)
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
      void load()
      void loadDiff()
    }
  })
  onCleanup(unsubPty)

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

  const handleCommitClick = (hash: string) => {
    if (hash === UNCOMMITTED) return
    setSelectedHash((prev) => (prev === hash ? null : hash))
  }

  const handleContextMenu = (hash: string, event: MouseEvent) => {
    if (hash === UNCOMMITTED) return
    event.preventDefault()
    setSelectedHash(hash)
    const raw = data()
    const commit = raw?.data?.commits.find((c) => c.hash === hash)
    setMenu({
      hash,
      message: commit?.message ?? "",
      heads: commit?.heads ?? [],
      parents: commit?.parents ?? [],
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
        const current = raw.data.branch ?? raw.data.head ?? undefined
        void load(filter() === "all" ? undefined : filter() === "current" ? current : filter(), nextSkip)
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
    const raw = data()
    const apiBranch = b === "all" ? undefined : b === "current" ? (raw?.data?.branch ?? raw?.data?.head) : b
    setFilter(b)
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
                onCommitClick={handleCommitClick}
                onContextMenu={handleContextMenu}
              />
            </ScrollView>
          )}
        </Show>
      </div>
      <Show when={selectedHash()}>
        {(hash) => <CommitDetail hash={hash()} parentHash={parentHash()} onClose={() => setSelectedHash(null)} />}
      </Show>
      <Show when={menu()}>
        {(m) => {
          const item = "px-2 py-1 text-xs cursor-pointer hover:bg-surface-hover text-text-base"
          const sep = "h-px bg-border-weaker-base my-1"
          const copyHash = () => {
            navigator.clipboard.writeText(m().hash)
            showToast({ variant: "success", title: language.t("session.tab.gitGraph.copiedHash") })
            closeMenu()
          }
          const copyMessage = () => {
            navigator.clipboard.writeText(m().message)
            showToast({ variant: "success", title: language.t("session.tab.gitGraph.copiedMessage") })
            closeMenu()
          }
          const checkout = () => {
            closeMenu()
            dialog.show(() => (
              <Dialog
                title={language.t("session.tab.gitGraph.checkoutCommitTitle")}
                fit
                persistent
                class="w-full max-w-[480px] mx-auto"
              >
                <div class="flex flex-col gap-4 p-4">
                  <p class="text-sm text-text-base">{language.t("session.tab.gitGraph.checkoutCommitDescription")}</p>
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => dialog.close()}>
                      {language.t("common.cancel")}
                    </Button>
                    <Button
                      onClick={() => {
                        dialog.close()
                        runGit("git", ["checkout", m().hash], `Checkout ${m().hash.slice(0, 7)}`)
                      }}
                    >
                      {language.t("session.tab.gitGraph.checkout")}
                    </Button>
                  </div>
                </div>
              </Dialog>
            ))
          }
          const checkoutBranch = () => {
            const heads = m().heads
            if (heads.length === 0) return
            closeMenu()
            if (heads.length === 1) {
              runGit("git", ["checkout", heads[0]], `Checkout ${heads[0]}`)
              return
            }
            dialog.show(() => (
              <DialogSelect
                title={language.t("session.tab.gitGraph.checkoutBranch")}
                options={heads}
                value={(h) => h}
                label={(h) => h}
                actionLabel={language.t("session.tab.gitGraph.checkoutBranch")}
                onAction={(h) => {
                  runGit("git", ["checkout", h], `Checkout ${h}`)
                }}
              />
            ))
          }
          const createBranch = () => {
            closeMenu()
            dialog.show(() => (
              <DialogCreateBranch
                hash={m().hash}
                onAction={(opts) => {
                  const args = opts.checkout ? ["checkout", "-b", opts.name, m().hash] : ["branch", opts.name, m().hash]
                  runGit("git", args, `Create branch ${opts.name}`)
                }}
              />
            ))
          }
          const merge = () => {
            closeMenu()
            dialog.show(() => (
              <DialogMerge
                hash={m().hash}
                branch={data()?.data?.branch ?? ""}
                onAction={(opts) => {
                  const args = ["merge", m().hash]
                  if (opts.squash) args.push("--squash")
                  else if (opts.noFastForward) args.push("--no-ff")
                  if (opts.noCommit) args.push("--no-commit")
                  runGit("git", args, `Merge ${m().hash.slice(0, 7)}`)
                }}
              />
            ))
          }
          const rebase = () => {
            closeMenu()
            dialog.show(() => (
              <DialogRebase
                hash={m().hash}
                branch={data()?.data?.branch ?? ""}
                onAction={(opts) => {
                  const args = ["rebase", m().hash]
                  if (opts.ignoreDate) args.push("--ignore-date")
                  runGit("git", args, `Rebase onto ${m().hash.slice(0, 7)}`)
                }}
              />
            ))
          }
          const reset = () => {
            closeMenu()
            dialog.show(() => (
              <DialogSelect
                title={language.t("session.tab.gitGraph.resetToThis")}
                description={language.t("session.tab.gitGraph.resetDescription")}
                options={[
                  { mode: "soft", label: language.t("session.tab.gitGraph.resetSoft") },
                  { mode: "mixed", label: language.t("session.tab.gitGraph.resetMixed") },
                  { mode: "hard", label: language.t("session.tab.gitGraph.resetHard") },
                ]}
                value={(o) => o.mode}
                label={(o) => o.label}
                defaultValue="mixed"
                actionLabel={language.t("session.tab.gitGraph.resetToThis")}
                onAction={(o) => {
                  runGit("git", ["reset", `--${o.mode}`, m().hash], `Reset --${o.mode} ${m().hash.slice(0, 7)}`)
                }}
              />
            ))
          }
          const revert = () => {
            closeMenu()
            if (m().parents.length > 1) {
              const raw = data()
              const opts = m().parents.map((p, i) => {
                const pc = raw?.data?.commits.find((c) => c.hash === p)
                return { hash: p, message: pc?.message ?? "", index: i + 1 }
              })
              dialog.show(() => (
                <DialogSelect
                  title={language.t("session.tab.gitGraph.revertMergeTitle")}
                  description={language.t("session.tab.gitGraph.revertMergeDescription")}
                  options={opts}
                  value={(o) => String(o.index)}
                  label={(o) => `${o.hash.slice(0, 7)}: ${o.message}`}
                  actionLabel={language.t("session.tab.gitGraph.revertThis")}
                  onAction={(v) => {
                    runGit(
                      "git",
                      ["revert", "--no-edit", "-m", String(v.index), m().hash],
                      `Revert ${m().hash.slice(0, 7)}`,
                    )
                  }}
                />
              ))
            } else {
              dialog.show(() => (
                <Dialog
                  title={language.t("session.tab.gitGraph.revertThis")}
                  fit
                  persistent
                  class="w-full max-w-[480px] mx-auto"
                >
                  <div class="flex flex-col gap-4 p-4">
                    <p class="text-sm text-text-base">{language.t("session.tab.gitGraph.revertConfirmDescription")}</p>
                    <div class="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => dialog.close()}>
                        {language.t("common.cancel")}
                      </Button>
                      <Button
                        onClick={() => {
                          dialog.close()
                          runGit("git", ["revert", "--no-edit", m().hash], `Revert ${m().hash.slice(0, 7)}`)
                        }}
                      >
                        {language.t("session.tab.gitGraph.revertThis")}
                      </Button>
                    </div>
                  </div>
                </Dialog>
              ))
            }
          }
          const cherryPick = () => {
            closeMenu()
            const raw = data()
            const parentOpts = m().parents.map((p, i) => {
              const pc = raw?.data?.commits.find((c) => c.hash === p)
              return { hash: p, message: pc?.message ?? "", index: i + 1 }
            })
            dialog.show(() => (
              <DialogCherryPick
                hash={m().hash}
                parents={parentOpts}
                onAction={(opts) => {
                  const args = ["cherry-pick"]
                  if (opts.noCommit) args.push("--no-commit")
                  if (opts.recordOrigin) args.push("-x")
                  if (opts.parentIndex) args.push("-m", String(opts.parentIndex))
                  args.push(m().hash)
                  runGit("git", args, `Cherry-pick ${m().hash.slice(0, 7)}`)
                }}
              />
            ))
          }
          const addTag = () => {
            closeMenu()
            dialog.show(() => (
              <DialogAddTag
                hash={m().hash}
                onAction={(opts) => {
                  const args = ["tag"]
                  if (opts.type === "annotated") {
                    args.push("-a", opts.name, "-m", opts.message || "")
                  } else {
                    args.push(opts.name)
                  }
                  args.push(m().hash)
                  runGit("git", args, `Add tag ${opts.name}`)
                }}
              />
            ))
          }
          return (
            <div
              class="fixed z-[1001] rounded shadow-lg border border-border-weaker-base bg-surface-base min-w-[200px]"
              style={{ left: `${m().x}px`, top: `${m().y}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <div class={item} onClick={checkout}>
                {language.t("session.tab.gitGraph.checkout")}
              </div>
              <Show when={m().heads.length > 0}>
                <div class={item} onClick={checkoutBranch}>
                  {language.t("session.tab.gitGraph.checkoutBranch")}
                </div>
              </Show>
              <div class={item} onClick={createBranch}>
                {language.t("session.tab.gitGraph.createBranch")}
              </div>
              <div class={sep} />
              <div class={item} onClick={merge}>
                {language.t("session.tab.gitGraph.mergeIntoCurrent")}
              </div>
              <div class={item} onClick={rebase}>
                {language.t("session.tab.gitGraph.rebaseCurrent")}
              </div>
              <div class={sep} />
              <div class={item} onClick={reset}>
                {language.t("session.tab.gitGraph.resetToThis")}
              </div>
              <div class={item} onClick={revert}>
                {language.t("session.tab.gitGraph.revertThis")}
              </div>
              <div class={item} onClick={cherryPick}>
                {language.t("session.tab.gitGraph.cherryPick")}
              </div>
              <div class={item} onClick={addTag}>
                {language.t("session.tab.gitGraph.addTag")}
              </div>
              <div class={sep} />
              <div class={item} onClick={copyHash}>
                {language.t("session.tab.gitGraph.copyHash")}
              </div>
              <div class={item} onClick={copyMessage}>
                {language.t("session.tab.gitGraph.copyMessage")}
              </div>
            </div>
          )
        }}
      </Show>
    </div>
  )
}
