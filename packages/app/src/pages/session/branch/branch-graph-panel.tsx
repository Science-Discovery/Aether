import { useNavigate, useParams } from "@solidjs/router"
import type { Session, SessionGraphNode, SessionGraphResult } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { produce } from "solid-js/store"
import { extractPromptFromParts } from "@/utils/prompt"
import { base64Encode } from "@opencode-ai/util/encode"
import { buildConversationGraphView, type ConversationGraph, type ConversationGraphNode as ViewNode } from "./conversation-graph-model"
import { ConversationGraphList } from "./conversation-graph-list"

const FONT_SIZE_CLASS_MAP = {
  xs: "text-12-medium",
  sm: "text-12-medium",
  md: "text-12-medium",
  lg: "text-12-medium",
  xl: "text-12-medium",
} as const

const FONT_SIZE_STYLE_MAP = {
  xs: { "font-size": "10px", "line-height": "14px" },
  sm: { "font-size": "11px", "line-height": "16px" },
  md: { "font-size": "12px", "line-height": "18px" },
  lg: { "font-size": "14px", "line-height": "21px" },
  xl: { "font-size": "16px", "line-height": "24px" },
} as const

const ROW_DENSITY_HEIGHT_MAP = {
  xcompact: 24,
  compact: 36,
  normal: 44,
  relaxed: 52,
  xrelaxed: 60,
} as const

function mergeSessionsByID(existing: Session[], incoming: Session[]) {
  const merged = new Map(existing.map((session) => [session.id, session] as const))
  for (const session of incoming) merged.set(session.id, session)
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function BranchGraphPanel(props: { sessionID: string }) {
  const params = useParams()
  const navigate = useNavigate()
  const language = useLanguage()
  const sdk = useSDK()
  const prompt = usePrompt()
  const settings = useSettings()
  const sync = useSync()
  const dialog = useDialog()
  const zh = createMemo(() => language.locale() === "zh" || language.locale() === "zht")
  const [loading, setLoading] = createSignal(false)
  const [compact, setCompact] = createSignal(false)
  const [graph, setGraph] = createSignal<SessionGraphResult>()
  const [errorMessage, setErrorMessage] = createSignal<string>()
  const fontSize = createMemo(() => settings.general.branchGraphFontSize())
  const rowDensity = createMemo(() => settings.general.branchGraphRowDensity())
  const orderMode = createMemo(() => settings.general.branchGraphOrderMode())
  const rowHeight = createMemo(() => ROW_DENSITY_HEIGHT_MAP[rowDensity()])
  const labelClass = createMemo(() => FONT_SIZE_CLASS_MAP[fontSize()])
  const labelStyle = createMemo(() => FONT_SIZE_STYLE_MAP[fontSize()])
  const graphContentSignature = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return ""
    const messages = sync.data.message[sessionID] ?? []
    if (messages.length === 0) return `${sessionID}|empty`

    const messageSignature = messages
      .map((message) =>
        message.role === "assistant"
          ? `${message.id}:${message.time.created}:${message.time.completed ?? ""}:${message.finish ?? ""}:${message.error ? "err" : "ok"}`
          : `${message.id}:${message.time.created}`,
      )
      .join(",")
    const partSignature = messages
      .map((message) =>
        `${message.id}:${(sync.data.part[message.id] ?? [])
          .map((part) => {
            const textLength =
              "text" in part && typeof part.text === "string"
                ? part.text.length
                : "snapshot" in part && typeof part.snapshot === "string"
                  ? part.snapshot.length
                  : 0
            const status =
              "state" in part &&
              part.state &&
              typeof part.state === "object" &&
              "status" in part.state &&
              typeof part.state.status === "string"
                ? part.state.status
                : ""
            const timeEnd =
              "time" in part &&
              part.time &&
              typeof part.time === "object" &&
              "end" in part.time &&
              typeof part.time.end === "number"
                ? part.time.end
                : ""
            return `${part.id}:${part.type}:${textLength}:${status}:${timeEnd}`
          })
          .join(".")}`,
      )
      .join("|")

    return `${sessionID}|${messageSignature}|${partSignature}`
  })

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let lastLoadedSignature = ""
  let requestVersion = 0

  const clearRefreshTimer = () => {
    if (!refreshTimer) return
    clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  const loadGraph = async (input: { sessionID: string; syncSessions: boolean; silent: boolean }) => {
    const version = ++requestVersion

    if (!input.silent) {
      setLoading(true)
      setErrorMessage(undefined)
    }

    try {
      const result = await sdk.client.session.graph({ sessionID: input.sessionID })
      const payload = result.data as SessionGraphResult | undefined
      if (!payload) throw new Error("Missing conversation graph response")
      if (version !== requestVersion) return

      setGraph(payload)
      lastLoadedSignature = untrack(() => graphContentSignature())

      if (payload.kind === "graph" && input.syncSessions) {
        const sessionIDs = [...new Set(payload.nodes.map((node) => node.sessionID))]
        const loadedSessions = (
          await Promise.all(
            sessionIDs.map((targetSessionID) => sdk.client.session.get({ sessionID: targetSessionID }).catch(() => undefined)),
          )
        )
          .map((item) => item?.data)
          .filter(Boolean) as Session[]

        if (loadedSessions.length > 0) {
          sync.set("session", mergeSessionsByID(untrack(() => sync.data.session), loadedSessions))
        }

        await Promise.all(sessionIDs.map((targetSessionID) => sync.session.sync(targetSessionID).catch(() => undefined)))
      }
    } catch (error) {
      console.error("Failed to load conversation graph", error)
      if (version !== requestVersion) return
      if (!input.silent) {
        setGraph(undefined)
        setErrorMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (version === requestVersion && !input.silent) {
        setLoading(false)
      }
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return

    lastLoadedSignature = ""
    clearRefreshTimer()
    void loadGraph({ sessionID, syncSessions: true, silent: false })

    onCleanup(() => {
      requestVersion += 1
      clearRefreshTimer()
    })
  })

  createEffect(() => {
    const sessionID = props.sessionID
    const signature = graphContentSignature()
    const payload = graph()
    if (!sessionID || !signature) return
    if (!payload || payload.kind !== "graph") return
    if (payload.current.sessionID !== sessionID) return
    if (signature === lastLoadedSignature) return

    clearRefreshTimer()
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void loadGraph({ sessionID, syncSessions: false, silent: true })
    }, 220)

    onCleanup(() => {
      clearRefreshTimer()
    })
  })

  const view = createMemo(() => {
    const payload = graph()
    if (!payload || payload.kind !== "graph") return
    return buildConversationGraphView({
      graph: payload as ConversationGraph,
      compact: compact(),
      orderMode: orderMode(),
    })
  })

  const hint = createMemo(() =>
    zh() ? "节点按消息完成顺序展示，点击可跳回对应对话。" : "Turns are ordered by completion time. Click a node to jump back to that turn.",
  )

  const fullHint = createMemo(() =>
    zh() ? "按消息顺序展示当前对话图。" : "This conversation graph is ordered by turn time.",
  )

  const graphHint = createMemo(() =>
    orderMode() === "sequence"
      ? zh()
        ? "节点按对话序列优先排序，同序列按时间；点击可跳回对应对话。"
        : "Turns are ordered by sequence first, then time. Click a node to jump back to that turn."
      : hint(),
  )

  const graphFullHint = createMemo(() =>
    orderMode() === "sequence"
      ? zh()
        ? "当前对话图按序列优先展示。"
        : "This conversation graph is ordered by sequence first."
      : fullHint(),
  )

  const legacyHint = createMemo(() =>
    zh()
      ? "这个会话属于旧体系，不提供新的对话图视图。你仍然可以正常使用 Aether 原有的 fork。"
      : "This is a legacy session. The new conversation graph is unavailable, but the existing fork flow still works.",
  )

  const renameTitle = (node: Pick<ViewNode, "sessionID">) => {
    const session = sync.session.get(node.sessionID)
    const initial = session?.title ?? ""

    dialog.show(() => {
      const [value, setValue] = createSignal(initial)
      const [saving, setSaving] = createSignal(false)

      const save = async () => {
        const next = value().trim()
        if (!next || next === initial || saving()) {
          dialog.close()
          return
        }

        setSaving(true)
        try {
          await sdk.client.session.update({ sessionID: node.sessionID, title: next })
          sync.set(
            produce((draft) => {
              const sessions = draft.session ?? []
              const index = sessions.findIndex((session) => session.id === node.sessionID)
              if (index !== -1) sessions[index].title = next
            }),
          )
          dialog.close()
        } catch (err) {
          const message =
            err && typeof err === "object" && "data" in err && typeof err.data === "object" && err.data && "message" in err.data
              ? String((err.data as { message?: string }).message ?? language.t("common.requestFailed"))
              : err instanceof Error
                ? err.message
                : language.t("common.requestFailed")

          showToast({
            title: language.t("common.requestFailed"),
            description: message,
          })
          setSaving(false)
        }
      }

      return (
        <Dialog
          title={language.t("common.rename")}
          action={
            <div class="flex gap-2">
              <button class="px-3 py-1.5" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </button>
              <button class="px-3 py-1.5 font-semibold" disabled={saving()} onClick={() => void save()}>
                {saving() ? `${language.t("common.loading")}${language.t("common.loading.ellipsis")}` : language.t("common.save")}
              </button>
            </div>
          }
        >
          <div class="py-3">
            <input
              autofocus
              type="text"
              value={value()}
              onInput={(event) => setValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save()
                if (event.key === "Escape") dialog.close()
              }}
              class="w-full rounded-md border border-border-base bg-background-stronger px-3 py-2 text-13-regular text-text-strong outline-none"
            />
          </div>
        </Dialog>
      )
    })
  }

  const openNode = (node: Pick<SessionGraphNode, "sessionID" | "userMessageID">) => {
    if (!params.dir || !node.sessionID) return
    const hash = node.userMessageID ? `#message-${node.userMessageID}` : ""
    navigate(`/${params.dir}/session/${node.sessionID}${hash}`)
  }

  const forkFromNode = async (node: Pick<SessionGraphNode, "sessionID" | "userMessageID">) => {
    if (!node.userMessageID || !params.dir) return

    await sync.session.sync(node.sessionID).catch(() => undefined)

    const parts = sync.data.part[node.userMessageID] ?? []
    const restored = extractPromptFromParts(parts, {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })
    const dir = base64Encode(sdk.directory)

    sdk.client.session
      .fork({ sessionID: node.sessionID, messageID: node.userMessageID })
      .then((forked) => {
        if (!forked.data) {
          showToast({ title: language.t("common.requestFailed") })
          return
        }
        prompt.set(restored, undefined, { dir, id: forked.data.id })
        navigate(`/${dir}/session/${forked.data.id}`)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  createEffect(() => {
    const payload = graph()
    const nextView = view()
    if (!payload || payload.kind !== "graph" || !nextView) return
    const targetID = payload.current.targetNodeID
    if (!targetID) return

    queueMicrotask(() => {
      const element = document.querySelector<HTMLElement>(`[data-graph-node-id="${targetID}"]`)
      element?.scrollIntoView({ block: "center", inline: "nearest" })
    })
  })

  return (
    <div class="h-full min-h-0 overflow-hidden bg-background-base">
      <div class="flex h-full min-h-0 flex-col">
        <div class="border-b border-border-weaker-base px-4 py-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0 text-12-regular text-text-weak">
              <Switch>
                <Match when={loading() && !graph()}>
                  {`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}
                </Match>
                <Match when={graph()?.kind === "legacy"}>{legacyHint()}</Match>
                <Match when={graph()?.kind === "graph" && (view()?.nodes.length ?? 0) > 1}>{graphFullHint()}</Match>
                <Match when={errorMessage()}>{errorMessage()}</Match>
                <Match when={true}>{graphHint()}</Match>
              </Switch>
            </div>

            <Show when={graph()?.kind === "graph"}>
              <div class="flex shrink-0 items-center gap-2">
                <button
                  class="rounded-md border border-border-weak-base px-2 py-1 text-[11px] text-text-weak transition-colors hover:bg-background-stronger"
                  onClick={() => setCompact((value) => !value)}
                >
                  {compact() ? (zh() ? "完整" : "Full") : zh() ? "简略" : "Compact"}
                </button>

                <div class="flex overflow-hidden rounded-md border border-border-weak-base">
                  <button
                    class="px-2 py-1 text-[11px] transition-colors"
                    classList={{
                      "bg-background-stronger text-text-strong": orderMode() === "sequence",
                      "text-text-weak hover:bg-background-stronger": orderMode() !== "sequence",
                    }}
                    onClick={() => settings.general.setBranchGraphOrderMode("sequence")}
                  >
                    {zh() ? "序列优先" : "Sequence"}
                  </button>
                  <button
                    class="border-l border-border-weak-base px-2 py-1 text-[11px] transition-colors"
                    classList={{
                      "bg-background-stronger text-text-strong": orderMode() === "time",
                      "text-text-weak hover:bg-background-stronger": orderMode() !== "time",
                    }}
                    onClick={() => settings.general.setBranchGraphOrderMode("time")}
                  >
                    {zh() ? "时间优先" : "Time"}
                  </button>
                </div>

                <DropdownMenu placement="bottom-end">
                  <DropdownMenu.Trigger class="rounded-md border border-border-weak-base px-2 py-1 text-[11px] text-text-weak transition-colors hover:bg-background-stronger">
                    {zh() ? "显示" : "Display"}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="min-w-40">
                      <DropdownMenu.Group>
                        <DropdownMenu.GroupLabel>{zh() ? "字号" : "Font size"}</DropdownMenu.GroupLabel>
                        <DropdownMenu.RadioGroup
                          value={fontSize()}
                          onChange={(value) => {
                            if (value === "xs" || value === "sm" || value === "md" || value === "lg" || value === "xl") {
                              settings.general.setBranchGraphFontSize(value)
                            }
                          }}
                        >
                          <For
                            each={[
                              { value: "xs", label: zh() ? "特小" : "X-Small" },
                              { value: "sm", label: zh() ? "小" : "Small" },
                              { value: "md", label: zh() ? "标准" : "Default" },
                              { value: "lg", label: zh() ? "大" : "Large" },
                              { value: "xl", label: zh() ? "特大" : "X-Large" },
                            ]}
                          >
                            {(item) => (
                              <DropdownMenu.RadioItem value={item.value}>
                                <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                                <DropdownMenu.ItemIndicator>
                                  <Icon name="check-small" size="small" class="text-icon-weak" />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.RadioItem>
                            )}
                          </For>
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.Group>

                      <DropdownMenu.Separator />

                      <DropdownMenu.Group>
                        <DropdownMenu.GroupLabel>{zh() ? "行距" : "Row spacing"}</DropdownMenu.GroupLabel>
                        <DropdownMenu.RadioGroup
                          value={rowDensity()}
                          onChange={(value) => {
                            if (
                              value === "xcompact" ||
                              value === "compact" ||
                              value === "normal" ||
                              value === "relaxed" ||
                              value === "xrelaxed"
                            ) {
                              settings.general.setBranchGraphRowDensity(value)
                            }
                          }}
                        >
                          <For
                            each={[
                              { value: "xcompact", label: zh() ? "极紧凑" : "Ultra compact" },
                              { value: "compact", label: zh() ? "紧凑" : "Compact" },
                              { value: "normal", label: zh() ? "标准" : "Default" },
                              { value: "relaxed", label: zh() ? "宽松" : "Relaxed" },
                              { value: "xrelaxed", label: zh() ? "极宽松" : "Ultra relaxed" },
                            ]}
                          >
                            {(item) => (
                              <DropdownMenu.RadioItem value={item.value}>
                                <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                                <DropdownMenu.ItemIndicator>
                                  <Icon name="check-small" size="small" class="text-icon-weak" />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.RadioItem>
                            )}
                          </For>
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
            </Show>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-hidden">
          <Switch>
            <Match when={graph()?.kind === "legacy"}>
              <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div class="text-13-medium text-text-base">{zh() ? "旧会话" : "Legacy session"}</div>
                <div class="max-w-72 text-12-regular text-text-weak">{legacyHint()}</div>
              </div>
            </Match>
            <Match when={(view()?.nodes.length ?? 0) > 0 && view()}>
              {(nextView) => (
                <ConversationGraphList
                  nodes={nextView().nodes}
                  edges={nextView().edges}
                  laneCount={nextView().laneCount}
                  rowHeight={rowHeight()}
                  labelClass={labelClass()}
                  labelStyle={labelStyle()}
                  onSelect={openNode}
                  onFork={(node) => void forkFromNode(node)}
                  onRename={(node) => renameTitle(node)}
                />
              )}
            </Match>
            <Match when={true}>
              <div class="flex h-full items-center justify-center px-6 text-center text-12-regular text-text-weak">
                <Show when={!loading()} fallback={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}>
                  {errorMessage() ?? graphHint()}
                </Show>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}
