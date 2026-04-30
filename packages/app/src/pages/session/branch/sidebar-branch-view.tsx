import { useNavigate, useParams } from "@solidjs/router"
import type { SessionGraphResult } from "@opencode-ai/sdk/v2"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { errorMessage as formatErrorMessage } from "@/pages/layout/helpers"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  buildConversationGraphView,
  type ConversationGraph,
  type ConversationGraphOrderMode,
} from "./conversation-graph-model"
import { ConversationGraphList } from "./conversation-graph-list"

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

const graphCache = new Map<string, SessionGraphResult>()
const DEFAULT_COMPACT = false
const DEFAULT_PANEL_MAX_HEIGHT = 480
const MIN_PANEL_HEIGHT = 240
const MAX_PANEL_HEIGHT = 720
const COMPACT_STORAGE_KEY = "aether.sidebar-branch-view.compact"
const HEIGHT_STORAGE_KEY = "aether.sidebar-branch-view.height"

export function SidebarBranchView(props: {
  sessionID: string
  currentSessionID: string
  directory: string
  refreshKey?: string
}) {
  const params = useParams()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const settings = useSettings()
  const language = useLanguage()
  const zh = createMemo(() => language.locale() === "zh" || language.locale() === "zht")
  const [controlsOpen, setControlsOpen] = createSignal(false)
  const [compact, setCompact] = createSignal(DEFAULT_COMPACT)
  const [loading, setLoading] = createSignal(false)
  const [graph, setGraph] = createSignal<SessionGraphResult>()
  const [errorMessage, setErrorMessage] = createSignal<string>()
  const [maxPanelHeight, setMaxPanelHeight] = createSignal(DEFAULT_PANEL_MAX_HEIGHT)
  const fontSize = createMemo(() => settings.general.branchGraphFontSize())
  const rowDensity = createMemo(() => settings.general.branchGraphRowDensity())
  const orderMode = createMemo(() => settings.general.branchGraphOrderMode())
  const rowHeight = createMemo(() => ROW_DENSITY_HEIGHT_MAP[rowDensity()])
  const labelClass = "text-12-medium"
  const labelStyle = createMemo(() => FONT_SIZE_STYLE_MAP[fontSize()])
  const sdk = createMemo(() =>
    globalSDK.createClient({
      directory: props.directory,
      throwOnError: true,
    }),
  )

  let requestVersion = 0
  let activePointerID: number | undefined
  let dragStartY = 0
  let dragStartHeight = DEFAULT_PANEL_MAX_HEIGHT
  let scrollContainer: HTMLDivElement | undefined

  const clampHeight = (height: number) => Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, Math.round(height)))

  const persistHeight = (height: number) => {
    try {
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(height))
    } catch {}
  }

  const stopDragging = () => {
    activePointerID = undefined
    document.body.style.removeProperty("cursor")
    document.body.style.removeProperty("user-select")
  }

  const onPointerMove = (event: PointerEvent) => {
    if (activePointerID !== event.pointerId) return
    const nextHeight = clampHeight(dragStartHeight + (event.clientY - dragStartY))
    setMaxPanelHeight(nextHeight)
  }

  const onPointerUp = (event: PointerEvent) => {
    if (activePointerID !== event.pointerId) return
    persistHeight(maxPanelHeight())
    stopDragging()
  }

  onMount(() => {
    try {
      const storedCompact = window.localStorage.getItem(COMPACT_STORAGE_KEY)
      if (storedCompact === "true") setCompact(true)
      if (storedCompact === "false") setCompact(false)
    } catch {}

    try {
      const stored = Number(window.localStorage.getItem(HEIGHT_STORAGE_KEY))
      if (Number.isFinite(stored) && stored > 0) {
        setMaxPanelHeight(clampHeight(stored))
      }
    } catch {}

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerUp)
  })

  onCleanup(() => {
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)
    window.removeEventListener("pointercancel", onPointerUp)
    stopDragging()
  })

  const loadGraph = async (sessionID: string) => {
    const version = ++requestVersion
    const refreshKey = props.refreshKey ?? ""
    const cacheKey = `${props.directory}:${sessionID}:${refreshKey}`
    const cached = graphCache.get(cacheKey)
    if (cached) {
      setGraph(cached)
      setErrorMessage(undefined)
    } else {
      setLoading(true)
      setErrorMessage(undefined)
    }

    try {
      const result = await sdk().session.graph({ sessionID })
      const payload = result.data as SessionGraphResult | undefined
      if (!payload) throw new Error("Missing conversation graph response")
      if (version !== requestVersion) return
      graphCache.set(cacheKey, payload)
      setGraph(payload)
      setErrorMessage(undefined)
    } catch (error) {
      if (version !== requestVersion) return
      setGraph(undefined)
      setErrorMessage(formatErrorMessage(error, zh() ? "暂无可展示的分支视图。" : "No branch view available."))
    } finally {
      if (version === requestVersion) setLoading(false)
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    props.refreshKey
    void loadGraph(sessionID)
  })

  createEffect(() => {
    try {
      window.localStorage.setItem(COMPACT_STORAGE_KEY, String(compact()))
    } catch {}
  })

  const view = createMemo(() => {
    const payload = graph()
    if (!payload || payload.kind !== "graph") return
    return buildConversationGraphView({
      graph: payload as ConversationGraph,
      compact: compact(),
      orderMode: orderMode() as ConversationGraphOrderMode,
    })
  })

  createEffect(() => {
    view()
    queueMicrotask(() => {
      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight
    })
  })

  const openNode = async (node: { sessionID: string; userMessageID?: string }) => {
    if (!params.dir || !node.sessionID) return
    const hash = node.userMessageID ? `#message-${node.userMessageID}` : ""
    navigate(`/${params.dir}/session/${node.sessionID}${hash}`)
  }

  const startResize = (event: PointerEvent) => {
    activePointerID = event.pointerId
    dragStartY = event.clientY
    dragStartHeight = maxPanelHeight()
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
  }

  return (
    <div class="overflow-hidden rounded-md border border-border-weaker-base bg-background-stronger">
      <div ref={scrollContainer} class="min-h-0 overflow-auto" style={{ "max-height": `${maxPanelHeight()}px` }}>
        <Switch>
          <Match when={graph()?.kind === "legacy"}>
            <div class="flex h-full items-center justify-center px-4 text-center text-11-regular text-text-weak">
              {zh() ? "旧会话不支持新的分支视图。" : "Legacy sessions do not support the new branch view."}
            </div>
          </Match>
          <Match when={(view()?.nodes.length ?? 0) > 0 && view()}>
            {(nextView) => (
              <div class="flex flex-col">
                <ConversationGraphList
                  currentSessionID={props.currentSessionID}
                  nodes={nextView().nodes}
                  edges={nextView().edges}
                  laneCount={nextView().laneCount}
                  rowHeight={rowHeight()}
                  labelClass={labelClass}
                  labelStyle={labelStyle()}
                  onSelect={openNode}
                  onFork={() => {}}
                  onRename={() => {}}
                  showRowActions={false}
                />
                <Show when={compact()}>
                  <button
                    type="button"
                    class="flex items-center justify-center border-t border-border-weaker-base px-3 py-2 text-text-weak transition-colors hover:bg-background-base hover:text-text-strong"
                    aria-label={zh() ? "切换到完整视图" : "Switch to full view"}
                    onClick={() => setCompact(false)}
                  >
                    <div class="flex flex-col items-center leading-none">
                      <Icon name="chevron-right" size="small" class="translate-y-[3px] rotate-90" />
                      <Icon name="chevron-right" size="small" class="-mt-2 translate-y-px rotate-90" />
                    </div>
                  </button>
                </Show>
              </div>
            )}
          </Match>
          <Match when={true}>
            <div class="flex h-full items-center justify-center px-4 text-center text-11-regular text-text-weak">
              <Show
                when={!loading()}
                fallback={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}
              >
                {errorMessage() ?? (zh() ? "暂无可展示的分支视图。" : "No branch view available.")}
              </Show>
            </div>
          </Match>
        </Switch>
      </div>

      <Show when={controlsOpen()}>
        <div class="flex flex-wrap items-center gap-2 border-t border-border-weaker-base px-2 py-2">
          <button
            class="rounded-md border border-border-weak-base px-2 py-px text-[11px] text-text-weak transition-colors hover:bg-background-base"
            onClick={() => setCompact((value) => !value)}
          >
            {compact() ? (zh() ? "完整" : "Full") : zh() ? "简略" : "Compact"}
          </button>

          <div class="flex overflow-hidden rounded-md border border-border-weak-base">
            <button
              class="px-2 py-px text-[11px] transition-colors"
              classList={{
                "bg-background-base text-text-strong": orderMode() === "sequence",
                "text-text-weak hover:bg-background-base": orderMode() !== "sequence",
              }}
              onClick={() => settings.general.setBranchGraphOrderMode("sequence")}
            >
              {zh() ? "序列优先" : "Sequence"}
            </button>
            <button
              class="border-l border-border-weak-base px-2 py-px text-[11px] transition-colors"
              classList={{
                "bg-background-base text-text-strong": orderMode() === "time",
                "text-text-weak hover:bg-background-base": orderMode() !== "time",
              }}
              onClick={() => settings.general.setBranchGraphOrderMode("time")}
            >
              {zh() ? "时间优先" : "Time"}
            </button>
          </div>

          <DropdownMenu placement="top-start">
            <DropdownMenu.Trigger class="rounded-md border border-border-weak-base px-2 py-px text-[11px] text-text-weak transition-colors hover:bg-background-base">
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

      <div class="border-t border-border-weaker-base px-2 py-1">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 text-left text-[11px] text-text-weak transition-colors hover:text-text-base"
          onClick={() => setControlsOpen((value) => !value)}
        >
          <span>{zh() ? "会话树" : "Conversation tree"}</span>
          <Icon name={controlsOpen() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-weak" />
        </button>
      </div>

      <div
        class="group flex h-3 cursor-row-resize items-center justify-center border-t border-border-weaker-base bg-background-base/30 transition-colors hover:bg-background-base/60"
        onPointerDown={startResize}
      >
        <div class="h-px w-10 bg-border-weak-base transition-colors group-hover:bg-border-base" />
      </div>
    </div>
  )
}
