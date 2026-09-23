import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Binary } from "@opencode-ai/util/binary"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Icon } from "@opencode-ai/ui/icon"
import { createSortable } from "@thisbeyond/solid-dnd"
import { useLayout, type LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { errorText, type Notification } from "@/context/notification-helpers"
import { ProjectIcon, SessionItem, type SessionItemProps } from "./sidebar-items"
import { childMapByParent, displayName, sortedRootSessions } from "./helpers"

export type ProjectSidebarContext = {
  currentDir: Accessor<string>
  currentProject: Accessor<LocalProject | undefined>
  sidebarOpened: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  hoverProject: Accessor<string | undefined>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  onHoverOpenChanged: (worktree: string, hovered: boolean) => void
  navigateToProject: (directory: string) => void
  openSidebar: () => void
  closeProject: (directory: string) => void
  deleteProject: (project: LocalProject) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  sessionProps: Omit<SessionItemProps, "session" | "list" | "slug" | "children" | "dense">
  setHoverSession: (id: string | undefined) => void
}

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((p) => p.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(p) => (
        <div class="bg-background-base rounded-xl p-1">
          <ProjectIcon project={p()} />
        </div>
      )}
    </Show>
  )
}

type Probe = { gone?: boolean; title?: string }

const stamp = (time: number) => {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const ProjectTile = (props: {
  project: LocalProject
  sidebarHovering: Accessor<boolean>
  selected: Accessor<boolean>
  active: Accessor<boolean>
  overlay: Accessor<boolean>
  suppressHover: Accessor<boolean>
  dirs: Accessor<string[]>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  navigateToProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  deleteProject: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  closeProject: (directory: string) => void
  setMenu: (value: boolean) => void
  setOpen: (value: boolean) => void
  setSuppressHover: (value: boolean) => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const notification = useNotification()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const unseenCount = createMemo(() =>
    props.dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const errors = createMemo(() =>
    props
      .dirs()
      .flatMap((directory) => notification.project.unseen(directory))
      .filter((n) => n.type === "error"),
  )
  const [checked, setChecked] = createSignal(new Map<string, Probe>())

  const key = (n: Notification) => `${n.directory}|${n.session}`

  const verify = () => {
    errors().forEach((n) => {
      if (!n.directory || !n.session || n.session === "global") return
      const id = key(n)
      if (checked().has(id)) return
      void notification.probe(n.directory, n.session).then((found) => {
        const next = new Map(checked())
        next.set(id, { gone: found === null, title: found?.title })
        setChecked(next)
      })
    })
  }

  const title = (n: Notification) => {
    if (!n.directory || !n.session || n.session === "global") return undefined
    const [store] = globalSync.child(n.directory, { bootstrap: false })
    const match = Binary.search(store.session, n.session, (s) => s.id)
    if (match.found) return store.session[match.index]?.title
    return checked().get(key(n))?.title
  }

  const label = (n: Notification) => {
    const summary = errorText(n)
    const time = stamp(n.time)
    const gone = checked().get(key(n))?.gone
    const head = gone ? props.language.t("sidebar.project.errorSessionDeleted") : (title(n) ?? summary)
    return head === summary ? `${head} · ${time}` : `${head} · ${time} · ${summary}`
  }

  const open = (n: Notification) => {
    const directory = n.directory
    if (!directory) return
    const sessionID = n.session
    if (!sessionID || sessionID === "global") {
      navigate(`/${base64Encode(directory)}`)
      return
    }
    void notification.probe(directory, sessionID).then((found) => {
      if (found === null) {
        notification.remove(n)
        return
      }
      navigate(`/${base64Encode(directory)}/session/${sessionID}`)
    })
  }

  const clear = () =>
    props
      .dirs()
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))

  return (
    <ContextMenu
      modal={!props.sidebarHovering()}
      onOpenChange={(value) => {
        props.setMenu(value)
        props.setSuppressHover(value)
        if (value) {
          props.setOpen(false)
          verify()
        }
      }}
    >
      <ContextMenu.Trigger
        as="button"
        type="button"
        aria-label={displayName(props.project)}
        data-action="project-switch"
        data-project={base64Encode(props.project.worktree)}
        classList={{
          "flex items-center justify-center size-10 p-1 rounded-lg overflow-hidden transition-colors cursor-default": true,
          "bg-transparent border-2 border-icon-strong-base hover:bg-surface-base-hover": props.selected(),
          "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base":
            !props.selected() && !props.active(),
          "bg-surface-base-hover border border-border-weak-base": !props.selected() && props.active(),
        }}
        onPointerDown={(event) => {
          if (event.button === 0 && !event.ctrlKey) {
            props.setOpen(false)
            props.setSuppressHover(true)
            return
          }
          if (!props.overlay()) return
          if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return
          props.setOpen(false)
          props.setSuppressHover(true)
          event.preventDefault()
        }}
        onMouseEnter={(event: MouseEvent) => {
          if (!props.overlay()) return
          if (props.suppressHover()) return
          props.onProjectMouseEnter(props.project.worktree, event)
        }}
        onMouseLeave={() => {
          if (props.suppressHover()) props.setSuppressHover(false)
          if (!props.overlay()) return
          props.onProjectMouseLeave(props.project.worktree)
        }}
        onFocus={() => {
          if (!props.overlay()) return
          if (props.suppressHover()) return
          props.onProjectFocus(props.project.worktree)
        }}
        onClick={() => {
          props.setOpen(false)
          if (props.selected()) {
            layout.sidebar.toggle()
            return
          }
          props.navigateToProject(props.project.worktree)
        }}
        onBlur={() => props.setOpen(false)}
      >
        <ProjectIcon project={props.project} notify />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => props.showEditProjectDialog(props.project)}>
            <ContextMenu.ItemLabel>{props.language.t("common.edit")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-delete-menu"
            data-project={base64Encode(props.project.worktree)}
            onSelect={() => props.deleteProject(props.project)}
          >
            <ContextMenu.ItemLabel>{props.language.t("common.delete")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-workspaces-toggle"
            data-project={base64Encode(props.project.worktree)}
            disabled={props.project.vcs !== "git" && !props.workspacesEnabled(props.project)}
            onSelect={() => props.toggleProjectWorkspaces(props.project)}
          >
            <ContextMenu.ItemLabel>
              {props.workspacesEnabled(props.project)
                ? props.language.t("sidebar.workspaces.disable")
                : props.language.t("sidebar.workspaces.enable")}
            </ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-error-session"
            data-project={base64Encode(props.project.worktree)}
            classList={{ hidden: errors().length !== 1 }}
            onSelect={() => {
              const target = errors()[0]
              if (target) open(target)
            }}
          >
            <ContextMenu.ItemLabel>{errors().length === 1 ? label(errors()[0]) : ""}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger
              data-action="project-error-sessions"
              data-project={base64Encode(props.project.worktree)}
              classList={{ hidden: errors().length <= 1 }}
            >
              {props.language.t("sidebar.project.errorSessions")}
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent>
                <For each={errors()}>
                  {(n) => (
                    <ContextMenu.Item
                      data-action="project-error-session-item"
                      data-session={n.session}
                      onSelect={() => open(n)}
                    >
                      <ContextMenu.ItemLabel>{label(n)}</ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                  )}
                </For>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            data-action="project-clear-notifications"
            data-project={base64Encode(props.project.worktree)}
            disabled={unseenCount() === 0}
            onSelect={clear}
          >
            <ContextMenu.ItemLabel>{props.language.t("sidebar.project.clearNotifications")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="project-close-menu"
            data-project={base64Encode(props.project.worktree)}
            onSelect={() => props.closeProject(props.project.worktree)}
          >
            <ContextMenu.ItemLabel>{props.language.t("common.close")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

const ProjectPreviewPanel = (props: {
  project: LocalProject
  selected: Accessor<boolean>
  workspaceEnabled: Accessor<boolean>
  workspaces: Accessor<string[]>
  label: (directory: string) => string
  projectSessions: Accessor<ReturnType<typeof sortedRootSessions>>
  projectChildren: Accessor<Map<string, string[]>>
  workspaceSessions: (directory: string) => ReturnType<typeof sortedRootSessions>
  workspaceChildren: (directory: string) => Map<string, string[]>
  ctx: ProjectSidebarContext
  language: ReturnType<typeof useLanguage>
}): JSX.Element => (
  <div class="-m-3 p-2 flex flex-col w-72">
    <div class="px-4 pt-2 pb-1 flex items-center gap-2">
      <div class="text-14-medium text-text-strong truncate grow">{displayName(props.project)}</div>
    </div>
    <div class="px-4 pb-2 text-12-medium text-text-weak">{props.language.t("sidebar.project.recentSessions")}</div>
    <div class="px-2 pb-2 flex flex-col gap-2">
      <Show
        when={props.workspaceEnabled()}
        fallback={
          <For each={props.projectSessions().slice(0, 2)}>
            {(session) => (
              <SessionItem
                {...props.ctx.sessionProps}
                session={session}
                list={props.projectSessions()}
                slug={base64Encode(props.project.worktree)}
                dense
                children={props.projectChildren()}
              />
            )}
          </For>
        }
      >
        <For each={props.workspaces()}>
          {(directory) => {
            const sessions = createMemo(() => props.workspaceSessions(directory))
            const children = createMemo(() => props.workspaceChildren(directory))
            return (
              <div class="flex flex-col gap-1">
                <div class="px-2 py-0.5 flex items-center gap-1 min-w-0">
                  <div class="shrink-0 size-6 flex items-center justify-center">
                    <Icon name="branch" size="small" class="text-icon-base" />
                  </div>
                  <span class="truncate text-14-medium text-text-base">{props.label(directory)}</span>
                </div>
                <For each={sessions().slice(0, 2)}>
                  {(session) => (
                    <SessionItem
                      {...props.ctx.sessionProps}
                      session={session}
                      list={sessions()}
                      slug={base64Encode(directory)}
                      dense
                      children={children()}
                    />
                  )}
                </For>
              </div>
            )
          }}
        </For>
      </Show>
    </div>
    <div class="px-2 py-2 border-t border-border-weak-base">
      <Button
        variant="ghost"
        class="flex w-full text-left justify-start text-text-base px-2 hover:bg-transparent active:bg-transparent"
        onClick={() => {
          props.ctx.openSidebar()
          props.ctx.onHoverOpenChanged(props.project.worktree, false)
          if (props.selected()) return
          props.ctx.navigateToProject(props.project.worktree)
        }}
      >
        {props.language.t("sidebar.project.viewAllSessions")}
      </Button>
    </div>
  </div>
)

export const SortableProject = (props: {
  project: LocalProject
  ctx: ProjectSidebarContext
  sortNow: Accessor<number>
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() => props.ctx.currentProject()?.worktree === props.project.worktree)
  const workspaces = createMemo(() => props.ctx.workspaceIds(props.project).slice(0, 2))
  const workspaceEnabled = createMemo(() => props.ctx.workspacesEnabled(props.project))
  const dirs = createMemo(() => props.ctx.workspaceIds(props.project))
  const [state, setState] = createStore({
    menu: false,
    suppressHover: false,
  })

  const isHoverProject = () => props.ctx.hoverProject() === props.project.worktree
  const preview = createMemo(() => props.ctx.sidebarOpened())
  const overlay = createMemo(() => !props.ctx.sidebarOpened())
  const active = createMemo(() => state.menu || (preview() ? isHoverProject() : overlay() && isHoverProject()))

  const hoverOpen = () => isHoverProject() && preview() && !selected() && !state.menu

  const label = (directory: string) => {
    const [data] = globalSync.child(directory, { bootstrap: false })
    const local = directory === props.project.worktree
    const displayName =
      data.projectMeta?.name ??
      props.ctx.workspaceName(directory) ??
      globalSync.project.recentFromDir(directory)?.name ??
      (local ? language.t("workspace.type.local") : language.t("workspace.type.sandbox"))
    const branch = data.vcs?.branch ?? getFilename(directory)
    return `${displayName} : ${branch}`
  }

  const projectStore = createMemo(() => globalSync.child(props.project.worktree, { bootstrap: false })[0])
  const projectSessions = createMemo(() => sortedRootSessions(projectStore(), props.sortNow()))
  const projectChildren = createMemo(() => childMapByParent(projectStore().session))
  const workspaceSessions = (directory: string) => {
    const [data] = globalSync.child(directory, { bootstrap: false })
    return sortedRootSessions(data, props.sortNow())
  }
  const workspaceChildren = (directory: string) => {
    const [data] = globalSync.child(directory, { bootstrap: false })
    return childMapByParent(data.session)
  }
  const tile = () => (
    <ProjectTile
      project={props.project}
      sidebarHovering={props.ctx.sidebarHovering}
      selected={selected}
      active={active}
      overlay={overlay}
      suppressHover={() => state.suppressHover}
      dirs={dirs}
      onProjectMouseEnter={props.ctx.onProjectMouseEnter}
      onProjectMouseLeave={props.ctx.onProjectMouseLeave}
      onProjectFocus={props.ctx.onProjectFocus}
      navigateToProject={props.ctx.navigateToProject}
      showEditProjectDialog={props.ctx.showEditProjectDialog}
      deleteProject={props.ctx.deleteProject}
      toggleProjectWorkspaces={props.ctx.toggleProjectWorkspaces}
      workspacesEnabled={props.ctx.workspacesEnabled}
      closeProject={props.ctx.closeProject}
      setMenu={(value) => setState("menu", value)}
      setOpen={(value) => props.ctx.onHoverOpenChanged(props.project.worktree, value)}
      setSuppressHover={(value) => setState("suppressHover", value)}
      language={language}
    />
  )

  return (
    // @ts-ignore
    <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <Show when={preview() && !selected()} fallback={tile()}>
        <HoverCard
          open={!state.suppressHover && hoverOpen() && !state.menu}
          openDelay={0}
          closeDelay={0}
          placement="right-start"
          gutter={6}
          trigger={tile()}
          onOpenChange={(value) => {
            if (state.menu) return
            if (value && state.suppressHover) return
            props.ctx.onHoverOpenChanged(props.project.worktree, value)
            if (value) props.ctx.setHoverSession(undefined)
          }}
        >
          <ProjectPreviewPanel
            project={props.project}
            selected={selected}
            workspaceEnabled={workspaceEnabled}
            workspaces={workspaces}
            label={label}
            projectSessions={projectSessions}
            projectChildren={projectChildren}
            workspaceSessions={workspaceSessions}
            workspaceChildren={workspaceChildren}
            ctx={props.ctx}
            language={language}
          />
        </HoverCard>
      </Show>
    </div>
  )
}
