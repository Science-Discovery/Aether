import { useLocation, useNavigate, useParams } from "@solidjs/router"
import type { SessionGraphResult } from "@opencode-ai/sdk/v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { serverScopedKey } from "@/utils/server-scope"
import { errorMessage as formatErrorMessage } from "@/pages/layout/helpers"
import { Match, Show, Switch, createEffect, createMemo, createSignal, onMount } from "solid-js"
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
const DEFAULT_PANEL_MAX_HEIGHT = 480
const COMPACT_STORAGE_KEY = "aether.sidebar-branch-view.compact"

export function SidebarBranchView(props: {
  sessionID: string
  currentSessionID: string
  directory: string
  refreshKey?: string
}) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const server = useServer()
  const settings = useSettings()
  const language = useLanguage()
  const zh = createMemo(() => language.locale() === "zh" || language.locale() === "zht")
  const [loading, setLoading] = createSignal(false)
  const [graph, setGraph] = createSignal<SessionGraphResult>()
  const [errorMessage, setErrorMessage] = createSignal<string>()
  const compact = createMemo(() => settings.general.branchGraphCompact())
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
  let scrollContainer: HTMLDivElement | undefined

  onMount(() => {
    try {
      const storedCompact = window.localStorage.getItem(COMPACT_STORAGE_KEY)
      if (storedCompact === "true") settings.general.setBranchGraphCompact(true)
      if (storedCompact === "false") settings.general.setBranchGraphCompact(false)
      if (storedCompact === "true" || storedCompact === "false") {
        window.localStorage.removeItem(COMPACT_STORAGE_KEY)
      }
    } catch {}
  })

  const loadGraph = async (sessionID: string) => {
    const version = ++requestVersion
    const refreshKey = props.refreshKey ?? ""
    const cacheKey = `${serverScopedKey(props.directory, server.key)}:${sessionID}:${refreshKey}`
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
    if (!node.userMessageID) {
      navigate(`/${params.dir}/session/${node.sessionID}${hash}`)
      return
    }
    if (props.currentSessionID !== node.sessionID || location.hash !== hash) {
      navigate(`/${params.dir}/session/${node.sessionID}${hash}`)
      return
    }
    if (!document.getElementById(`message-${node.userMessageID}`)) {
      navigate(`/${params.dir}/session/${node.sessionID}${hash}`)
      return
    }
    layout.pendingToggle.set(`${params.dir}/${node.sessionID}`, node.userMessageID)
    return
  }

  return (
    <div class="overflow-hidden rounded-md border border-border-weaker-base bg-background-stronger">
      <div ref={scrollContainer} class="min-h-0 overflow-auto" style={{ "max-height": `${DEFAULT_PANEL_MAX_HEIGHT}px` }}>
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
                    onClick={() => settings.general.setBranchGraphCompact(false)}
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
    </div>
  )
}
