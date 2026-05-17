import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onMount, Show, type Accessor, type JSX, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject, useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { loadDescendantsForRoots } from "@/context/global-sync/session-load"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { enqueueRun } from "@/context/terminal"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import { childMapByParent, errorMessage, sortedRootSessions, workspaceKey } from "./helpers"
import { SidebarBranchView } from "@/pages/session/branch/sidebar-branch-view"

function createBatchSelect(
  sessions: Accessor<Session[]>,
  archiveSession: (s: Session) => Promise<void>,
  deleteSession: (s: Session) => Promise<void>,
  dialog: ReturnType<typeof useDialog>,
  language: ReturnType<typeof useLanguage>,
) {
  const [selectMode, setSelectMode] = createSignal(false)
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set<string>())

  const enterSelect = () => setSelectMode(true)
  const cancelSelect = () => {
    setSelectMode(false)
    setSelectedIds(new Set<string>())
  }
  const toggleSelect = (session: Session) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(session.id)) next.delete(session.id)
      else next.add(session.id)
      return next
    })
  }
  const selectAll = () => setSelectedIds(new Set(sessions().map((s) => s.id)))
  const deselectAll = () => setSelectedIds(new Set<string>())

  const batchArchive = async () => {
    const ids = selectedIds()
    await Promise.all(
      sessions()
        .filter((s) => ids.has(s.id))
        .map((s) => archiveSession(s)),
    )
    cancelSelect()
  }

  const batchDelete = () => {
    const targets = sessions().filter((s) => selectedIds().has(s.id))
    const count = targets.length
    if (count === 0) return
    dialog.show(() => (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <span class="text-14-regular text-text-strong">{language.t("session.batch.delete.confirm", { count })}</span>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={async () => {
                await Promise.all(targets.map((s) => deleteSession(s)))
                dialog.close()
                cancelSelect()
              }}
            >
              {language.t("session.batch.delete", { count })}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  return {
    selectMode,
    selectedIds,
    enterSelect,
    cancelSelect,
    toggleSelect,
    selectAll,
    deselectAll,
    batchArchive,
    batchDelete,
  }
}

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  createSession: (directory: string) => Promise<void>
  deleteSession: (session: Session) => Promise<void>
  renameSession: (session: Session, title: string) => Promise<void>
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  sessionExpanded: (sessionID: string) => boolean
  setSessionExpanded: (sessionID: string, value: boolean) => void
  conversationTreeOpen: (rootSessionID: string) => boolean
  setConversationTreeOpen: (rootSessionID: string, value: boolean) => void
  conversationTreeLastFocus: (rootSessionID: string) => string | undefined
  setConversationTreeLastFocus: (rootSessionID: string, sessionID: string) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const [workspaceStore] = globalSync.child(directory, { bootstrap: false })
    const local = directory === project.worktree
    const displayName =
      props.workspaceName(directory) ??
      (local ? language.t("workspace.type.local") : language.t("workspace.type.sandbox"))
    const branch = workspaceStore.vcs?.branch ?? getFilename(directory)
    return `${displayName} : ${branch}`
  })

  return (
    <Show when={label()}>
      {(value) => (
        <div class="bg-background-base rounded-md border border-border-weak-base px-2 py-1 text-14-medium text-text-strong">
          {value()}
        </div>
      )}
    </Show>
  )
}

const RunScriptButton = (props: {
  directory: string
  slug: Accessor<string>
  sessions: Accessor<Session[]>
  createSession: (directory: string) => Promise<void>
}) => {
  const globalSdk = useGlobalSDK()
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const params = useParams()
  const [scripts, setScripts] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal<string | undefined>(undefined)

  const fetchScripts = async () => {
    const client = globalSdk.createClient({ directory: props.directory })
    try {
      const result = await client.file.list({ path: ".aether/.bin" })
      const names = (result.data ?? [])
        .filter((n) => n.type === "file")
        .map((n) => n.name)
        .sort()
      setScripts(names)
      const stored = localStorage.getItem(`aether:run-script:${props.directory}`)
      if (stored && names.includes(stored)) {
        setSelected(stored)
      } else if (names.length > 0) {
        setSelected(names[0])
      } else {
        setSelected(undefined)
      }
    } catch {
      setScripts([])
      setSelected(undefined)
    }
  }

  onMount(fetchScripts)

  createEffect(() => {
    const name = selected()
    if (name) localStorage.setItem(`aether:run-script:${props.directory}`, name)
  })

  const run = async () => {
    const name = selected()
    if (!name) return
    const scriptPath = `.aether/.bin/${name}`
    const slug = props.slug()
    enqueueRun(slug, "bash", ["-c", `${scriptPath}; exec bash --noediting`], scriptPath)
    if (params.dir !== slug || !params.id) {
      const s = props.sessions()
      if (s.length > 0) {
        navigate(`/${slug}/session/${s[0].id}`)
      } else {
        await props.createSession(props.directory)
      }
    }
    layout.terminal.open()
  }

  const disabled = createMemo(() => scripts().length === 0)
  const label = createMemo(() => {
    const name = selected()
    return name ? language.t("workspace.runScript", { name }) : language.t("workspace.run")
  })

  return (
    <ContextMenu onOpenChange={(open) => open && fetchScripts()}>
      <ContextMenu.Trigger as="div" class="shrink-0">
        <Button
          variant="ghost"
          size="small"
          icon="terminal"
          disabled={disabled()}
          onClick={run}
          class="h-6 px-1.5 text-12-regular text-text-weak gap-0.5"
        >
          {label()}
        </Button>
      </ContextMenu.Trigger>
      <Show when={scripts().length > 0}>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <ContextMenu.RadioGroup value={selected()} onChange={setSelected}>
              <For each={scripts()}>
                {(name) => (
                  <ContextMenu.RadioItem value={name}>
                    <ContextMenu.ItemIndicator>✓</ContextMenu.ItemIndicator>
                    <ContextMenu.ItemLabel>{name}</ContextMenu.ItemLabel>
                  </ContextMenu.RadioItem>
                )}
              </For>
            </ContextMenu.RadioGroup>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </Show>
    </ContextMenu>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <Show
      when={!props.local()}
      fallback={
        <>
          <span class="text-14-medium text-text-base shrink-0">{props.language.t("workspace.type.local")} :</span>
          <span class="text-14-medium text-text-base min-w-0 truncate">
            {props.branch() ?? getFilename(props.directory)}
          </span>
        </>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed)
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-14-medium text-text-base shrink-0"
        displayClass="text-14-medium text-text-base shrink-0"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
      <span class="text-14-medium text-text-base shrink-0">:</span>
      <span class="text-14-medium text-text-base min-w-0 truncate">
        {props.branch() ?? getFilename(props.directory)}
      </span>
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  sidebarHovering: Accessor<boolean>
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  setHoverSession: WorkspaceSidebarContext["setHoverSession"]
  clearHoverProjectSoon: WorkspaceSidebarContext["clearHoverProjectSoon"]
  navigateToNewSession: () => void
  onEnterSelect: () => void
  currentBranch: Accessor<string | undefined>
}): JSX.Element => {
  const globalSdk = useGlobalSDK()
  const language = useLanguage()
  const [branches, setBranches] = createSignal<string[]>([])
  const [branchLoading, setBranchLoading] = createSignal(false)

  const scopedClient = createMemo(() => globalSdk.createClient({ directory: props.directory }))

  const fetchBranches = async () => {
    if (branchLoading()) return
    setBranchLoading(true)
    try {
      const result = await scopedClient().vcs.graph({ max: 0 })
      setBranches(result.data?.branches ?? [])
    } catch {
      setBranches([])
    } finally {
      setBranchLoading(false)
    }
  }

  const checkout = async (name: string) => {
    props.setMenuOpen(false)
    try {
      const resp = await fetch(`${globalSdk.url}/vcs/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": props.directory },
        body: JSON.stringify({ branch: name }),
      })
      const result = await resp.json()
      if (!result.success) {
        showToast({ variant: "error", title: language.t("workspace.switchBranch"), description: result.error })
      }
    } catch (e) {
      showToast({ variant: "error", title: language.t("workspace.switchBranch"), description: String(e) })
    }
  }

  return (
    <div
      class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
      classList={{
        "opacity-100 pointer-events-auto": props.menuOpen(),
        "opacity-0 pointer-events-none": !props.menuOpen(),
        "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
        "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
      }}
    >
      <DropdownMenu
        modal={!props.sidebarHovering()}
        open={props.menuOpen()}
        onOpenChange={(open) => {
          props.setMenuOpen(open)
        }}
      >
        <Tooltip value={props.language.t("common.moreOptions")} placement="top">
          <DropdownMenu.Trigger
            as={IconButton}
            icon="dot-grid"
            variant="ghost"
            class="size-6 rounded-md"
            data-action="workspace-menu"
            data-workspace={base64Encode(props.directory)}
            aria-label={props.language.t("common.moreOptions")}
          />
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            onCloseAutoFocus={(event) => {
              if (!props.pendingRename()) return
              event.preventDefault()
              props.setPendingRename(false)
              props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
            }}
          >
            <DropdownMenu.Item
              disabled={props.local()}
              onSelect={() => {
                props.setPendingRename(true)
                props.setMenuOpen(false)
              }}
            >
              <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => {
                props.setMenuOpen(false)
                props.onEnterSelect()
              }}
            >
              <DropdownMenu.ItemLabel>{props.language.t("session.select")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Sub onOpenChange={(open) => open && fetchBranches()}>
              <DropdownMenu.SubTrigger>{props.language.t("workspace.switchBranch")}</DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent>
                  <Show
                    when={!branchLoading()}
                    fallback={
                      <DropdownMenu.Item disabled>
                        <DropdownMenu.ItemLabel>...</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    }
                  >
                    <For each={branches()}>
                      {(name) => (
                        <DropdownMenu.Item disabled={name === props.currentBranch()} onSelect={() => checkout(name)}>
                          <DropdownMenu.ItemLabel>{name}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      )}
                    </For>
                    <Show when={branches().length === 0 && !branchLoading()}>
                      <DropdownMenu.Item disabled>
                        <DropdownMenu.ItemLabel>—</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </Show>
                  </Show>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Item
              disabled={props.local() || props.busy()}
              onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
            >
              <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={props.local() || props.busy()}
              onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
            >
              <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

const sortByUpdatedDesc = (a: Session, b: Session) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)

const SessionTreeNodes = (props: {
  slug: Accessor<string>
  currentSessionID: Accessor<string | undefined>
  mobile?: boolean
  popover?: boolean
  ctx: WorkspaceSidebarContext
  rootSessions: Accessor<Session[]>
  allSessions: Accessor<Session[]>
  children: Accessor<Map<string, string[]>>
  archiveSession?: (session: Session) => Promise<void>
  unarchiveSession?: (session: Session) => Promise<void>
  deleteSession?: (session: Session) => Promise<void>
}) => {
  const settings = useSettings()
  const conversationTreeEnabled = createMemo(() => settings.general.branchesTab())
  const archiveSession = createMemo(() => props.archiveSession ?? props.ctx.archiveSession)
  const sessionByID = createMemo(() => {
    const map = new Map<string, Session>()
    for (const session of props.allSessions()) {
      if (!session?.id) continue
      map.set(session.id, session)
    }
    return map
  })

  const childrenFor = (sessionID: string) =>
    (props.children().get(sessionID) ?? [])
      .map((childID) => sessionByID().get(childID))
      .filter((session): session is Session => !!session)

  const rootSessionIDFor = (sessionID: string) => {
    let cursor = sessionByID().get(sessionID)
    if (!cursor) return
    while (cursor.parentID) {
      const parent = sessionByID().get(cursor.parentID)
      if (!parent) break
      cursor = parent
    }
    return cursor.id
  }

  createEffect(
    on(
      () => [props.currentSessionID(), sessionByID(), conversationTreeEnabled()] as const,
      ([currentSessionID, sessions, treeEnabled]) => {
        if (!currentSessionID) return
        const current = sessions.get(currentSessionID)
        if (!current) return

        if (treeEnabled) return

        const visited = new Set<string>()
        let cursor = current.parentID
        while (cursor && !visited.has(cursor)) {
          visited.add(cursor)
          const expanded = untrack(() => props.ctx.sessionExpanded(cursor!))
          if (!expanded) props.ctx.setSessionExpanded(cursor, true)
          cursor = sessions.get(cursor)?.parentID
        }
      },
    ),
  )

  createEffect(
    on(
      () => [props.currentSessionID(), conversationTreeEnabled(), sessionByID()] as const,
      ([currentSessionID, treeEnabled]) => {
        if (!treeEnabled || !currentSessionID) return
        const rootID = rootSessionIDFor(currentSessionID)
        if (!rootID) return
        props.ctx.setConversationTreeLastFocus(rootID, currentSessionID)
      },
    ),
  )

  function SessionNode(nodeProps: { session: Session; depth: number; chain: Set<string> }): JSX.Element {
    const nextChain = new Set(nodeProps.chain)
    nextChain.add(nodeProps.session.id)
    const childSessions = createMemo(() =>
      childrenFor(nodeProps.session.id).filter((child) => !nextChain.has(child.id)),
    )
    const hasChildren = createMemo(() => childSessions().length > 0)
    const hasBranchView = createMemo(() => {
      if (!conversationTreeEnabled()) return hasChildren()
      if (hasChildren()) return true
      if (nodeProps.session.id === props.currentSessionID()) return true
      return (nodeProps.session.time.updated ?? 0) > (nodeProps.session.time.created ?? 0)
    })
    const expanded = createMemo(() => {
      if (!(conversationTreeEnabled() ? hasBranchView() : hasChildren())) return true
      if (!conversationTreeEnabled()) return props.ctx.sessionExpanded(nodeProps.session.id)
      return props.ctx.conversationTreeOpen(nodeProps.session.id)
    })
    const graphSessionID = createMemo(() => {
      const currentSessionID = props.currentSessionID()
      const lastFocus = props.ctx.conversationTreeLastFocus(nodeProps.session.id)
      if (currentSessionID && rootSessionIDFor(currentSessionID) === nodeProps.session.id) {
        if (currentSessionID !== nodeProps.session.id) return currentSessionID
        if (lastFocus && rootSessionIDFor(lastFocus) === nodeProps.session.id) return lastFocus
        return currentSessionID
      }
      if (lastFocus && rootSessionIDFor(lastFocus) === nodeProps.session.id) return lastFocus
      return nodeProps.session.id
    })
    const graphRefreshKey = createMemo(() => {
      const rootID = nodeProps.session.id
      const rows = props
        .allSessions()
        .filter((session) => rootSessionIDFor(session.id) === rootID)
        .map((session) => `${session.id}:${session.time.updated ?? 0}`)
      return rows.sort().join("|")
    })

    const toggleBranchView = () => {
      const next = !expanded()
      if (next) {
        props.ctx.setConversationTreeOpen(nodeProps.session.id, true)
        return
      }
      props.ctx.setConversationTreeOpen(nodeProps.session.id, false)
    }

    return (
      <>
        <div class="relative min-w-0" style={{ "padding-left": `${nodeProps.depth * 12}px` }}>
          <Show when={nodeProps.depth > 0}>
            <div class="absolute left-0 top-1 bottom-1 w-px bg-border-weaker-base" />
          </Show>
          <SessionItem
            session={nodeProps.session}
            targetSession={
              conversationTreeEnabled() ? (sessionByID().get(graphSessionID()) ?? nodeProps.session) : nodeProps.session
            }
            list={props.allSessions()}
            navList={props.ctx.navList}
            slug={props.slug()}
            mobile={props.mobile}
            popover={props.popover}
            children={props.children()}
            sidebarExpanded={props.ctx.sidebarExpanded}
            sidebarHovering={props.ctx.sidebarHovering}
            nav={props.ctx.nav}
            hoverSession={props.ctx.hoverSession}
            setHoverSession={props.ctx.setHoverSession}
            clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
            prefetchSession={props.ctx.prefetchSession}
            archiveSession={archiveSession()}
            unarchiveSession={nodeProps.depth === 0 ? props.unarchiveSession : undefined}
            deleteSession={props.deleteSession ?? props.ctx.deleteSession}
            renameSession={props.ctx.renameSession}
            hasChildren={conversationTreeEnabled() ? hasBranchView() : hasChildren()}
            expanded={expanded()}
            onToggleChildren={
              conversationTreeEnabled()
                ? toggleBranchView
                : () => props.ctx.setSessionExpanded(nodeProps.session.id, !expanded())
            }
          />
        </div>
        <Show when={expanded() && conversationTreeEnabled() && hasBranchView()}>
          <div class="pl-2 pr-2 pb-2">
            <SidebarBranchView
              sessionID={graphSessionID()}
              currentSessionID={props.currentSessionID() ?? nodeProps.session.id}
              directory={nodeProps.session.directory}
              refreshKey={graphRefreshKey()}
            />
          </div>
        </Show>
        <Show when={expanded() && !conversationTreeEnabled()}>
          <For each={childSessions()}>
            {(child) => <SessionNode session={child} depth={nodeProps.depth + 1} chain={nextChain} />}
          </For>
        </Show>
      </>
    )
  }

  return (
    <For each={props.rootSessions()}>{(session) => <SessionNode session={session} depth={0} chain={new Set()} />}</For>
  )
}

const ArchivedSessionList = (props: {
  directory: string
  slug: Accessor<string>
  ctx: WorkspaceSidebarContext
  mobile?: boolean
  popover?: boolean
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const [open, setOpen] = createSignal(false)
  const [rootSessions, setRootSessions] = createSignal<Session[]>([])
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [loading, setLoading] = createSignal(false)
  const hasLoaded = createMemo(() => rootSessions().length > 0 || sessions().length > 0)
  const [workspaceStore] = globalSync.child(props.directory, { bootstrap: false })
  const children = createMemo(() => childMapByParent(sessions()))
  const archivedTreeCtx = {
    ...props.ctx,
    conversationTreeOpen: (rootSessionID: string) => props.ctx.conversationTreeOpen(`archived:${rootSessionID}`),
    setConversationTreeOpen: (rootSessionID: string, value: boolean) =>
      props.ctx.setConversationTreeOpen(`archived:${rootSessionID}`, value),
    conversationTreeLastFocus: (rootSessionID: string) =>
      props.ctx.conversationTreeLastFocus(`archived:${rootSessionID}`),
    setConversationTreeLastFocus: (rootSessionID: string, sessionID: string) =>
      props.ctx.setConversationTreeLastFocus(`archived:${rootSessionID}`, sessionID),
  } satisfies WorkspaceSidebarContext

  const removeSessionSubtree = (sessionID: string) => {
    const ids = new Set<string>()
    const queue = [sessionID]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (ids.has(current)) continue
      ids.add(current)
      for (const childID of children().get(current) ?? []) {
        queue.push(childID)
      }
    }
    if (ids.size === 0) return
    setRootSessions((prev) => prev.filter((session) => !ids.has(session.id)))
    setSessions((prev) => prev.filter((session) => !ids.has(session.id)))
  }

  const load = async () => {
    setLoading(true)
    try {
      const result = await globalSDK.client.experimental.session.list({
        directory: props.directory,
        archivedMode: "only",
        roots: true,
      } as any)
      const roots = ((result.data ?? []) as unknown as Session[]).sort(sortByUpdatedDesc)
      const descendants = await loadDescendantsForRoots({
        directory: props.directory,
        roots,
        includeArchived: true,
        tree: (query) => globalSDK.client.session.tree(query),
        children: (query) => globalSDK.client.session.children(query),
      })
      const all = [...roots, ...descendants].sort((a, b) => a.id.localeCompare(b.id))
      setRootSessions(roots)
      setSessions(all)
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const next = !open()
    setOpen(next)
    if (next) void load()
  }

  const refreshKey = createMemo(() =>
    (workspaceStore.session ?? [])
      .map(
        (session) => `${session.id}:${session.parentID ?? ""}:${session.treeID ?? ""}:${session.time?.archived ?? 0}`,
      )
      .sort()
      .join("|"),
  )

  createEffect(
    on(
      () => [open(), refreshKey()] as const,
      ([isOpen]) => {
        if (!isOpen) return
        void load()
      },
    ),
  )

  const unarchiveSession = async (session: Session) => {
    await globalSDK.client.session.unarchive({
      directory: session.directory,
      sessionID: session.id,
    })
    removeSessionSubtree(session.id)
    if (session.id === params.id) {
      props.ctx.setHoverSession(undefined)
    }
  }

  const deleteSession = async (session: Session) => {
    try {
      await props.ctx.deleteSession(session)
      removeSessionSubtree(session.id)
    } catch (err) {
      throw new Error(errorMessage(err, props.language.t("common.requestFailed")))
    }
  }

  return (
    <div>
      <Button
        variant="ghost"
        size="large"
        class="flex w-full text-left items-center gap-2 text-14-regular text-text-weak pl-2 pr-2"
        onClick={toggle}
      >
        <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" class="shrink-0" />
        <Icon name="archive" size="small" class="shrink-0" />
        <span class="truncate">{props.language.t("common.archive")}</span>
      </Button>
      <Show when={open()}>
        <Show when={loading() && !hasLoaded()}>
          <SessionSkeleton />
        </Show>
        <nav class="relative flex flex-col gap-1">
          <SessionTreeNodes
            slug={props.slug}
            currentSessionID={() => params.id}
            mobile={props.mobile}
            popover={props.popover}
            ctx={archivedTreeCtx}
            rootSessions={rootSessions}
            allSessions={sessions}
            children={children}
            archiveSession={async () => {}}
            unarchiveSession={unarchiveSession}
            deleteSession={deleteSession}
          />
          <Show when={loading() && hasLoaded()}>
            <div class="pointer-events-none absolute inset-0 bg-background-base/5" />
          </Show>
        </nav>
      </Show>
    </div>
  )
}

const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  currentSessionID: Accessor<string | undefined>
  mobile?: boolean
  popover?: boolean
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  rootSessions: Accessor<Session[]>
  allSessions: Accessor<Session[]>
  children: Accessor<Map<string, string[]>>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  language: ReturnType<typeof useLanguage>
  selectMode: Accessor<boolean>
  selectedIds: Accessor<Set<string>>
  onToggleSelect: (session: Session) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onBatchArchive: () => Promise<void>
  onBatchDelete: () => void
  onCancelSelect: () => void
  directory: string
  createSession: (directory: string) => Promise<void>
}) => {
  const selectedCount = createMemo(() => props.selectedIds().size)
  const allSelected = createMemo(
    () => props.rootSessions().length > 0 && props.selectedIds().size === props.rootSessions().length,
  )

  return (
    <div class="flex flex-col gap-1">
      <Show when={props.selectMode()}>
        <div class="flex items-center gap-1 pl-2 pr-1 py-0.5">
          <Button
            variant="ghost"
            size="small"
            class="text-12-regular text-text-weak px-1 h-6 shrink-0"
            onClick={() => (allSelected() ? props.onDeselectAll() : props.onSelectAll())}
          >
            {allSelected() ? props.language.t("session.deselectAll") : props.language.t("session.selectAll")}
          </Button>
          <div class="flex-1" />
          <Show when={selectedCount() > 0}>
            <Tooltip value={props.language.t("session.batch.delete", { count: selectedCount() })} placement="top">
              <IconButton
                icon="trash"
                variant="ghost"
                class="size-6 rounded-md"
                aria-label={props.language.t("session.batch.delete", { count: selectedCount() })}
                onClick={props.onBatchDelete}
              />
            </Tooltip>
            <Tooltip value={props.language.t("session.batch.archive", { count: selectedCount() })} placement="top">
              <IconButton
                icon="archive"
                variant="ghost"
                class="size-6 rounded-md"
                aria-label={props.language.t("session.batch.archive", { count: selectedCount() })}
                onClick={() => void props.onBatchArchive()}
              />
            </Tooltip>
          </Show>
          <Tooltip value={props.language.t("session.cancelSelect")} placement="top">
            <IconButton
              icon="close"
              variant="ghost"
              class="size-6 rounded-md"
              aria-label={props.language.t("session.cancelSelect")}
              onClick={props.onCancelSelect}
            />
          </Tooltip>
        </div>
      </Show>
      <nav class="flex flex-col gap-1">
        <Show when={props.showNew() && !props.selectMode()}>
          <div class="flex items-center gap-1 pl-2 pr-3">
            <NewSessionItem
              slug={props.slug()}
              mobile={props.mobile}
              sidebarExpanded={props.ctx.sidebarExpanded}
              clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
              setHoverSession={props.ctx.setHoverSession}
            />
            <div class="flex-1" />
            <RunScriptButton
              directory={props.directory}
              slug={props.slug}
              sessions={props.rootSessions}
              createSession={props.createSession}
            />
          </div>
        </Show>
        <Show when={props.loading()}>
          <SessionSkeleton />
        </Show>
        <Show
          when={!props.selectMode()}
          fallback={
            <For each={props.rootSessions()}>
              {(session) => (
                <SessionItem
                  session={session}
                  list={props.rootSessions()}
                  navList={props.ctx.navList}
                  slug={props.slug()}
                  mobile={props.mobile}
                  popover={props.popover}
                  children={props.children()}
                  sidebarExpanded={props.ctx.sidebarExpanded}
                  sidebarHovering={props.ctx.sidebarHovering}
                  nav={props.ctx.nav}
                  hoverSession={props.ctx.hoverSession}
                  setHoverSession={props.ctx.setHoverSession}
                  clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                  prefetchSession={props.ctx.prefetchSession}
                  archiveSession={props.ctx.archiveSession}
                  deleteSession={props.ctx.deleteSession}
                  renameSession={props.ctx.renameSession}
                  selectMode={props.selectMode}
                  selected={() => props.selectedIds().has(session.id)}
                  onToggleSelect={props.onToggleSelect}
                />
              )}
            </For>
          }
        >
          <SessionTreeNodes
            slug={props.slug}
            currentSessionID={props.currentSessionID}
            mobile={props.mobile}
            popover={props.popover}
            ctx={props.ctx}
            rootSessions={props.rootSessions}
            allSessions={props.allSessions}
            children={props.children}
          />
        </Show>
        <Show when={props.hasMore() && !props.selectMode()}>
          <div class="relative w-full py-1">
            <Button
              variant="ghost"
              class="flex w-full text-left justify-start text-14-regular text-text-weak pl-9 pr-10"
              size="large"
              onClick={(e: MouseEvent) => {
                props.loadMore()
                ;(e.currentTarget as HTMLButtonElement).blur()
              }}
            >
              {props.language.t("common.loadMore")}
            </Button>
          </div>
        </Show>
      </nav>
    </div>
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
  popover?: boolean
}): JSX.Element => {
  const params = useParams()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()
  const sortable = createSortable(props.directory)
  const [workspaceStore, setWorkspaceStore] = globalSync.child(props.directory, { bootstrap: false })
  const [menu, setMenu] = createStore({
    open: false,
    pendingRename: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const sessions = createMemo(() => sortedRootSessions(workspaceStore, props.sortNow()))
  const children = createMemo(() => childMapByParent(workspaceStore.session))
  const local = createMemo(() => props.directory === props.project.worktree)
  const currentBranch = createMemo(() => workspaceStore.vcs?.branch)
  const active = createMemo(() => workspaceKey(props.ctx.currentDir()) === workspaceKey(props.directory))
  const workspaceValue = createMemo(() => {
    const direct = props.ctx.workspaceName(props.directory)
    if (direct) return direct
    return local() ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const boot = createMemo(() => open() || active())
  const booted = createMemo((prev) => prev || workspaceStore.status === "complete", false)
  const count = createMemo(() => sessions()?.length ?? 0)
  const hasMore = createMemo(() => workspaceStore.sessionTotal > count())
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const wasBusy = createMemo((prev) => prev || busy(), false)
  const loading = createMemo(() => open() && !booted() && count() === 0 && !wasBusy())
  const touch = createMediaQuery("(hover: none)")
  const showNew = createMemo(() => !loading())
  const loadMore = async () => {
    setWorkspaceStore("limit", (limit) => (limit ?? 0) + 10)
    await globalSync.project.loadSessions(props.directory)
  }

  const {
    selectMode,
    selectedIds,
    enterSelect,
    cancelSelect,
    toggleSelect,
    selectAll,
    deselectAll,
    batchArchive,
    batchDelete,
  } = createBatchSelect(sessions, props.ctx.archiveSession, props.ctx.deleteSession, dialog, language)

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))
  const header = () => (
    <WorkspaceHeader
      local={local}
      busy={busy}
      open={open}
      directory={props.directory}
      language={language}
      branch={() => workspaceStore.vcs?.branch}
      workspaceValue={workspaceValue}
      workspaceEditActive={workspaceEditActive}
      InlineEditor={props.ctx.InlineEditor}
      renameWorkspace={props.ctx.renameWorkspace}
      setEditor={props.ctx.setEditor}
    />
  )

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
    if (value) return
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  createEffect(() => {
    if (!boot()) return
    globalSync.child(props.directory, { bootstrap: true })
  })

  return (
    <div
      // @ts-ignore
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        <div class="py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={base64Encode(props.directory)}
          >
            <div class="flex items-center gap-1">
              <Show
                when={workspaceEditActive()}
                fallback={
                  <Collapsible.Trigger
                    class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md border border-border-weak-base bg-surface-raised-base hover:bg-surface-raised-base-hover transition-[padding] duration-200 ${
                      menu.open ? "pr-16" : "pr-2"
                    } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                    data-action="workspace-toggle"
                    data-workspace={base64Encode(props.directory)}
                  >
                    {header()}
                  </Collapsible.Trigger>
                }
              >
                <div
                  class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md border border-border-weak-base bg-surface-raised-base transition-[padding] duration-200 ${
                    menu.open ? "pr-16" : "pr-2"
                  } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                >
                  {header()}
                </div>
              </Show>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menu.open}
                pendingRename={() => menu.pendingRename}
                setMenuOpen={(open) => setMenu("open", open)}
                setPendingRename={(value) => setMenu("pendingRename", value)}
                sidebarHovering={props.ctx.sidebarHovering}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                openEditor={props.ctx.openEditor}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                setHoverSession={props.ctx.setHoverSession}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                navigateToNewSession={() => props.ctx.createSession(props.directory)}
                onEnterSelect={enterSelect}
                currentBranch={currentBranch}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content>
          <WorkspaceSessionList
            slug={slug}
            currentSessionID={() => params.id}
            mobile={props.mobile}
            popover={props.popover}
            ctx={props.ctx}
            showNew={showNew}
            loading={loading}
            rootSessions={sessions}
            allSessions={() => workspaceStore.session}
            children={children}
            hasMore={hasMore}
            loadMore={loadMore}
            language={language}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onBatchArchive={batchArchive}
            onBatchDelete={batchDelete}
            onCancelSelect={cancelSelect}
            directory={props.directory}
            createSession={props.ctx.createSession}
          />
          <ArchivedSessionList
            directory={props.directory}
            slug={slug}
            ctx={props.ctx}
            mobile={props.mobile}
            popover={props.popover}
            language={language}
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
  popover?: boolean
}): JSX.Element => {
  const params = useParams()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()
  const workspace = createMemo(() => {
    const [store, setStore] = globalSync.child(props.project.worktree)
    return { store, setStore }
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => sortedRootSessions(workspace().store, props.sortNow()))
  const children = createMemo(() => childMapByParent(workspace().store.session))
  const booted = createMemo((prev) => prev || workspace().store.status === "complete", false)
  const count = createMemo(() => sessions()?.length ?? 0)
  const loading = createMemo(() => !booted() && count() === 0)
  const hasMore = createMemo(() => workspace().store.sessionTotal > count())
  const loadMore = async () => {
    workspace().setStore("limit", (limit) => (limit ?? 0) + 10)
    await globalSync.project.loadSessions(props.project.worktree)
  }

  const { selectMode, selectedIds, cancelSelect, toggleSelect, selectAll, deselectAll, batchArchive, batchDelete } =
    createBatchSelect(sessions, props.ctx.archiveSession, props.ctx.deleteSession, dialog, language)

  return (
    <div
      ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
      class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
    >
      <WorkspaceSessionList
        slug={slug}
        currentSessionID={() => params.id}
        mobile={props.mobile}
        popover={props.popover}
        ctx={props.ctx}
        showNew={() => false}
        loading={loading}
        rootSessions={sessions}
        allSessions={() => workspace().store.session}
        children={children}
        hasMore={hasMore}
        loadMore={loadMore}
        language={language}
        selectMode={selectMode}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onSelectAll={selectAll}
        onDeselectAll={deselectAll}
        onBatchArchive={batchArchive}
        onBatchDelete={batchDelete}
        onCancelSelect={cancelSelect}
        directory={props.project.worktree}
        createSession={props.ctx.createSession}
      />
      <ArchivedSessionList
        directory={props.project.worktree}
        slug={slug}
        ctx={props.ctx}
        mobile={props.mobile}
        popover={props.popover}
        language={language}
      />
    </div>
  )
}
