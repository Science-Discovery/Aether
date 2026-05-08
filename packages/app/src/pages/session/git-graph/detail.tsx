import { For, Show, createMemo, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { VcsCommitDetail, VcsFileChange } from "@opencode-ai/sdk/v2"

const abbrev = (hash: string) => hash.slice(0, 7)

const statusLabel = (status: string) => {
  if (status === "A") return "Added"
  if (status === "D") return "Deleted"
  if (status === "M") return "Modified"
  if (status === "R") return "Renamed"
  return status
}

const statusColor = (status: string) => {
  if (status === "A") return "text-green-500"
  if (status === "D") return "text-red-500"
  if (status === "M") return "text-yellow-500"
  return "text-text-weaker"
}

const isBinary = (f: VcsFileChange) => f.additions === null && f.deletions === null

const formatStat = (val: number | null, prefix: string) => (val !== null ? `${prefix}${val}` : "-")

export function CommitDetail(props: {
  hash: string
  parentHash: string | null
  height?: number
  class?: string
  onClose: () => void
  onResizeStart?: (event: MouseEvent) => void
}) {
  const sdk = useSDK()
  const lang = useLanguage()
  const fileComponent = useFileComponent()
  const [detail, setDetail] = createSignal<VcsCommitDetail | null>(null)
  const [selectedFile, setSelectedFile] = createSignal<VcsFileChange | null>(null)
  const [before, setBefore] = createSignal("")
  const [after, setAfter] = createSignal("")
  const [loadingDiff, setLoadingDiff] = createSignal(false)

  let loaded = false

  const t = (key: string) => lang.t(key)

  if (!loaded) {
    loaded = true
    sdk.client.vcs.commitDetail({ hash: props.hash }).then((res) => {
      if (res.data) setDetail(res.data)
    })
  }

  const sortedFiles = createMemo(() => {
    const d = detail()
    if (!d) return []
    return [...d.files].sort((a, b) => a.file.localeCompare(b.file))
  })

  const fileLabel = (f: VcsFileChange) => (f.status === "R" && f.oldFilePath ? `${f.oldFilePath} → ${f.file}` : f.file)
  const size = () => (props.height === undefined ? { "max-height": "40%" } : { height: `${props.height}px` })

  const onFileClick = async (f: VcsFileChange) => {
    setSelectedFile(f)
    setLoadingDiff(true)
    setBefore("")
    setAfter("")
    try {
      const beforePath = f.status === "R" && f.oldFilePath ? f.oldFilePath : f.file
      const [beforeRes, afterRes] = await Promise.all([
        props.parentHash
          ? sdk.client.vcs.fileContent({ hash: props.parentHash, path: beforePath })
          : Promise.resolve({ data: { content: "" } }),
        sdk.client.vcs.fileContent({ hash: props.hash, path: f.file }),
      ])
      setBefore(beforeRes.data?.content ?? "")
      setAfter(afterRes.data?.content ?? "")
    } finally {
      setLoadingDiff(false)
    }
  }

  return (
    <div
      class={`border-t border-border-weaker-base bg-surface-base flex flex-col min-h-0 overflow-hidden ${props.class ?? ""}`}
      style={size()}
    >
      <div class="flex items-center justify-between px-3 py-1.5 border-b border-border-weaker-base shrink-0">
        <span class="text-12-regular text-text-weaker">{t("session.tab.gitGraph.commitDetails")}</span>
        <IconButton icon="close-small" variant="ghost" class="h-5 w-5" onClick={props.onClose} />
      </div>

      <Show
        when={detail()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak p-4">
            {t("common.loading.ellipsis")}
          </div>
        }
      >
        {(d) => (
          <div class="flex flex-1 flex-col min-h-0 overflow-hidden">
            <div
              class="px-3 py-2 space-y-1.5 text-xs text-text-base overflow-y-auto shrink-0"
              style={{ "max-height": "40%" }}
            >
              <div class="grid grid-cols-[auto_1fr] gap-x-2">
                <span class="text-text-weaker">{t("session.tab.gitGraph.hash")}</span>
                <span class="font-mono text-text-base">{d().hash}</span>

                <Show when={d().parents.length > 0}>
                  <span class="text-text-weaker">{t("session.tab.gitGraph.parents")}</span>
                  <span class="font-mono text-text-base">
                    {d()
                      .parents.map((p: string) => abbrev(p))
                      .join(", ")}
                  </span>
                </Show>

                <span class="text-text-weaker">{t("session.tab.gitGraph.author")}</span>
                <span class="text-text-base">
                  {d().author} &lt;{d().authorEmail}&gt;
                </span>

                <Show when={d().committer !== d().author || d().committerEmail !== d().authorEmail}>
                  <span class="text-text-weaker">{t("session.tab.gitGraph.committer")}</span>
                  <span class="text-text-base">
                    {d().committer} &lt;{d().committerEmail}&gt;
                  </span>
                </Show>

                <span class="text-text-weaker">{t("session.tab.gitGraph.date")}</span>
                <span class="text-text-base">{new Date(d().authorDate * 1000).toLocaleString()}</span>
              </div>

              <Show when={d().body}>
                <pre class="text-text-base whitespace-pre-wrap font-sans text-xs mt-1">{d().body}</pre>
              </Show>
            </div>

            <Show
              when={!selectedFile()}
              fallback={
                <div class="flex flex-col flex-1 min-h-0 overflow-hidden">
                  <div class="flex items-center px-3 py-1 border-b border-border-weaker-base shrink-0">
                    <IconButton
                      icon="arrow-left"
                      variant="ghost"
                      class="h-5 w-5"
                      onClick={() => setSelectedFile(null)}
                    />
                    <span class="text-12-regular text-text-base ml-1 truncate">{fileLabel(selectedFile()!)}</span>
                    <span class="text-11-regular text-text-weaker ml-2">
                      <span class="text-green-500">{formatStat(selectedFile()!.additions, "+")}</span>
                      <span class="text-text-weaker"> / </span>
                      <span class="text-red-500">{formatStat(selectedFile()!.deletions, "-")}</span>
                    </span>
                  </div>
                  <div class="flex-1 min-h-0 overflow-auto">
                    <Show
                      when={!loadingDiff()}
                      fallback={<div class="p-4 text-12-regular text-text-weak">{t("common.loading")}...</div>}
                    >
                      <Show
                        when={!isBinary(selectedFile()!)}
                        fallback={
                          <div class="p-4 text-12-regular text-text-weak">
                            {t("session.tab.gitGraph.binaryFileDescription")}
                          </div>
                        }
                      >
                        <Dynamic
                          component={fileComponent}
                          mode="diff"
                          before={{ name: fileLabel(selectedFile()!), contents: before() }}
                          after={{ name: selectedFile()!.file, contents: after() }}
                        />
                      </Show>
                    </Show>
                  </div>
                </div>
              }
            >
              <div class="flex-1 min-h-0 overflow-y-auto">
                <div class="text-12-regular text-text-weaker px-3 py-1">
                  {t("session.tab.gitGraph.fileChanges")} ({d().files.length})
                </div>
                <Show
                  when={sortedFiles().length > 0}
                  fallback={
                    <div class="px-3 py-2 text-11-regular text-text-weak">
                      {t("session.tab.gitGraph.noFileChanges")}
                    </div>
                  }
                >
                  <For each={sortedFiles()}>
                    {(f) => (
                      <div
                        class="flex items-center gap-2 px-3 py-0.5 text-xs cursor-pointer hover:bg-surface-hover border-b border-border-weaker-base"
                        onClick={() => onFileClick(f)}
                      >
                        <span class={`text-11-regular w-14 shrink-0 ${statusColor(f.status)}`}>
                          {statusLabel(f.status)}
                        </span>
                        <span class="text-text-base truncate flex-1 font-mono text-11-regular">{fileLabel(f)}</span>
                        <span class="text-11-regular shrink-0">
                          <span class="text-green-500">{formatStat(f.additions, "+")}</span>
                          <span class="text-text-weaker"> / </span>
                          <span class="text-red-500">{formatStat(f.deletions, "-")}</span>
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.onResizeStart}>
        {(start) => (
          <div
            class="h-1 shrink-0 cursor-row-resize bg-border-weaker-base hover:bg-border-strong"
            onMouseDown={(event) => start()(event)}
          />
        )}
      </Show>
    </div>
  )
}
