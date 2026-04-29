import type { Message, Session, TextPart, UserMessage } from "@opencode-ai/sdk/v2/client"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { MessageNav } from "@opencode-ai/ui/message-nav"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { A, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { hasProjectPermissions } from "./helpers"

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

export const ProjectIcon = (props: { project: LocalProject; class?: string; notify?: boolean }): JSX.Element => {
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))
  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={
            props.project.id === OPENCODE_PROJECT_ID ? "https://opencode.ai/favicon.svg" : props.project.icon?.override
          }
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  targetSession?: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  popover?: boolean
  children: Map<string, string[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  unarchiveSession?: (session: Session) => Promise<void>
  deleteSession?: (session: Session) => Promise<void>
  renameSession?: (session: Session, title: string) => Promise<void>
  selectMode?: Accessor<boolean>
  selected?: Accessor<boolean>
  onToggleSelect?: (session: Session) => void
  hasChildren?: boolean
  expanded?: boolean
  onToggleChildren?: () => void
}

const sessionHref = (slug: string, session: Session, hash?: string) =>
  `/${slug}/session/${session.id}${session.readingMode ? "/reading" : ""}${hash ?? ""}`

const TreeToggle = (props: {
  expanded: boolean
  isWorking: boolean
  hasPermissions: boolean
  hasError: boolean
  unseenCount: number
  onToggle?: () => void
}) => (
  <button
    type="button"
    class="size-6 inline-flex items-center justify-center rounded-sm text-icon-weak hover:bg-surface-raised-base-hover"
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.preventDefault()
      event.stopPropagation()
      props.onToggle?.()
    }}
    aria-label={props.expanded ? "Collapse conversation tree" : "Expand conversation tree"}
    aria-expanded={props.expanded}
  >
    <Switch fallback={<Icon name={props.expanded ? "dash" : "plus-small"} size="small" class="text-icon-weak" />}>
      <Match when={props.isWorking}>
        <Spinner class="size-[15px]" />
      </Match>
      <Match when={props.hasPermissions}>
        <div class="size-1.5 rounded-full bg-surface-warning-strong" />
      </Match>
      <Match when={props.hasError}>
        <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
      </Match>
      <Match when={props.unseenCount > 0}>
        <div class="size-1.5 rounded-full bg-text-interactive-base" />
      </Match>
    </Switch>
  </button>
)

const SessionRow = (props: {
  session: Session
  targetSession: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmHover: () => void
  warmPress: () => void
  warmFocus: () => void
  cancelHoverPrefetch: () => void
  selectMode?: Accessor<boolean>
  selected?: Accessor<boolean>
  onToggleSelect?: () => void
  hasChildren: boolean
  expanded: boolean
  onToggleChildren?: () => void
}): JSX.Element => (
  <A
    href={sessionHref(props.slug, props.targetSession)}
    class={`flex items-center justify-between gap-3 min-w-0 text-left w-full focus:outline-none transition-[padding] ${props.mobile ? "pr-14" : ""} group-hover/session:pr-14 group-focus-within/session:pr-14 group-active/session:pr-14 ${props.dense ? "py-0.5" : "py-1"}`}
    onPointerDown={props.warmPress}
    onPointerEnter={props.warmHover}
    onPointerLeave={props.cancelHoverPrefetch}
    onFocus={props.warmFocus}
    onClick={(e) => {
      if (props.selectMode?.()) {
        e.preventDefault()
        props.onToggleSelect?.()
        return
      }
      props.setHoverSession(undefined)
      if (props.hasChildren) props.onToggleChildren?.()
      if (props.sidebarOpened()) return
      props.clearHoverProjectSoon()
    }}
  >
    <div
      class="shrink-0 size-6 flex items-center justify-center"
      style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
    >
      <Show
        when={props.selectMode?.()}
        fallback={
          <Show
            when={props.hasChildren}
            fallback={
              <Switch fallback={<Icon name="dash" size="small" class="text-icon-weak" />}>
                <Match when={props.isWorking()}>
                  <Spinner class="size-[15px]" />
                </Match>
                <Match when={props.hasPermissions()}>
                  <div class="size-1.5 rounded-full bg-surface-warning-strong" />
                </Match>
                <Match when={props.hasError()}>
                  <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
                </Match>
                <Match when={props.unseenCount() > 0}>
                  <div class="size-1.5 rounded-full bg-text-interactive-base" />
                </Match>
              </Switch>
            }
          >
            <TreeToggle
              expanded={props.expanded}
              isWorking={props.isWorking()}
              hasPermissions={props.hasPermissions()}
              hasError={props.hasError()}
              unseenCount={props.unseenCount()}
              onToggle={props.onToggleChildren}
            />
          </Show>
        }
      >
        <div
          class={`size-3.5 rounded-sm border flex items-center justify-center transition-colors ${
            props.selected?.()
              ? "bg-text-interactive-base border-text-interactive-base"
              : "border-icon-weak bg-transparent"
          }`}
        >
          <Show when={props.selected?.()}>
            <svg viewBox="0 0 12 12" fill="none" width="8" height="8" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M2 6.5L4.5 9L10 3"
                stroke="white"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </Show>
        </div>
      </Show>
    </div>
    <Show when={props.session.readingMode}>
      <span class="shrink-0 rounded bg-surface-raised-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
        PDF
      </span>
    </Show>
    <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{props.session.title}</span>
  </A>
)

const SessionHoverPreview = (props: {
  mobile?: boolean
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  session: Session
  sidebarHovering: Accessor<boolean>
  hoverReady: Accessor<boolean>
  hoverMessages: Accessor<UserMessage[] | undefined>
  language: ReturnType<typeof useLanguage>
  isActive: Accessor<boolean>
  slug: string
  setHoverSession: (id: string | undefined) => void
  messageLabel: (message: Message) => string | undefined
  onMessageSelect: (message: Message) => void
  trigger: JSX.Element
}): JSX.Element => {
  let ref: HTMLDivElement | undefined

  return (
    <HoverCard
      openDelay={1000}
      closeDelay={props.sidebarHovering() ? 600 : 0}
      placement="right-start"
      gutter={16}
      shift={-2}
      trigger={
        <div ref={ref} class="min-w-0 w-full">
          {props.trigger}
        </div>
      }
      open={props.hoverSession() === props.session.id}
      onOpenChange={(open) => {
        if (!open) {
          props.setHoverSession(undefined)
          return
        }
        if (!ref?.matches(":hover")) return
        props.setHoverSession(props.session.id)
      }}
    >
      <Show
        when={props.hoverReady()}
        fallback={<div class="text-12-regular text-text-weak">{props.language.t("session.messages.loading")}</div>}
      >
        <div class="overflow-y-auto overflow-x-hidden max-h-72 h-full">
          <MessageNav
            messages={props.hoverMessages() ?? []}
            current={undefined}
            getLabel={props.messageLabel}
            onMessageSelect={props.onMessageSelect}
            size="normal"
            class="w-60"
          />
        </div>
      </Show>
    </HoverCard>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const navigate = useNavigate()
  const layout = useLayout()
  const language = useLanguage()
  const dialog = useDialog()
  const notification = useNotification()
  const permission = usePermission()
  const globalSync = useGlobalSync()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = globalSync.child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    const status = sessionStore.session_status[props.session.id]
    if (!status || status.type === "idle") return false
    const pending = (sessionStore.message[props.session.id] ?? []).findLast(
      (message) =>
        message.role === "assistant" &&
        typeof (message as { time?: { completed?: unknown } }).time?.completed !== "number",
    )
    return pending !== undefined || status.type === "busy" || status.type === "retry"
  })

  const tint = createMemo(() => {
    return messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent)
  })

  const hoverMessages = createMemo(() =>
    sessionStore.message[props.session.id]?.filter((message): message is UserMessage => message.role === "user"),
  )
  const hoverReady = createMemo(() => hoverMessages() !== undefined)
  const hoverAllowed = createMemo(() => !props.mobile && props.sidebarExpanded())
  const hoverEnabled = createMemo(() => (props.popover ?? true) && hoverAllowed())
  const isActive = createMemo(() => props.session.id === params.id)

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const hoverPrefetch = {
    current: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const cancelHoverPrefetch = () => {
    if (hoverPrefetch.current === undefined) return
    clearTimeout(hoverPrefetch.current)
    hoverPrefetch.current = undefined
  }
  const scheduleHoverPrefetch = () => {
    warm(1, "high")
    if (hoverPrefetch.current !== undefined) return
    hoverPrefetch.current = setTimeout(() => {
      hoverPrefetch.current = undefined
      warm(2, "low")
    }, 80)
  }

  onCleanup(cancelHoverPrefetch)

  const [renaming, setRenaming] = createSignal(false)
  const [renameValue, setRenameValue] = createSignal("")
  let renameInputRef: HTMLInputElement | undefined
  let renameFrame: number | undefined

  const startRename = () => {
    setRenameValue(props.session.title ?? "")
    setRenaming(true)
    if (renameFrame !== undefined) cancelAnimationFrame(renameFrame)
    renameFrame = requestAnimationFrame(() => {
      renameFrame = undefined
      renameInputRef?.focus()
      renameInputRef?.select()
    })
  }

  const commitRename = async () => {
    const next = renameValue().trim()
    setRenaming(false)
    if (!next || next === props.session.title) return
    await props.renameSession?.(props.session, next)
  }

  onCleanup(() => {
    if (renameFrame !== undefined) cancelAnimationFrame(renameFrame)
  })

  const messageLabel = (message: Message) => {
    const parts = sessionStore.part[message.id] ?? []
    const text = parts.find((part): part is TextPart => part?.type === "text" && !part.synthetic && !part.ignored)
    return text?.text
  }

  const hasChildren = createMemo(() => props.hasChildren ?? (props.children.get(props.session.id)?.length ?? 0) > 0)
  const expanded = createMemo(() => props.expanded ?? true)

  const item = (
    <SessionRow
      session={props.session}
      targetSession={props.targetSession ?? props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      setHoverSession={props.setHoverSession}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      warmHover={scheduleHoverPrefetch}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      cancelHoverPrefetch={cancelHoverPrefetch}
      selectMode={props.selectMode}
      selected={props.selected}
      onToggleSelect={() => props.onToggleSelect?.(props.session)}
      hasChildren={hasChildren()}
      expanded={expanded()}
      onToggleChildren={props.onToggleChildren}
    />
  )

  return (
    <ContextMenu modal={!props.sidebarHovering()}>
      <ContextMenu.Trigger
        as="div"
        data-session-id={props.session.id}
        class="group/session relative w-full min-w-0 rounded-md cursor-default pl-2 pr-3 transition-colors
               hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
      >
        <div class="flex min-w-0 items-center gap-1">
          <div class="min-w-0 flex-1">
            <Show
              when={renaming()}
              fallback={
                <Show
                  when={hoverEnabled()}
                  fallback={
                    <Tooltip
                      placement={props.mobile ? "bottom" : "right"}
                      value={props.session.title}
                      gutter={10}
                      class="min-w-0 w-full"
                    >
                      {item}
                    </Tooltip>
                  }
                >
                  <SessionHoverPreview
                    mobile={props.mobile}
                    nav={props.nav}
                    hoverSession={props.hoverSession}
                    session={props.session}
                    sidebarHovering={props.sidebarHovering}
                    hoverReady={hoverReady}
                    hoverMessages={hoverMessages}
                    language={language}
                    isActive={isActive}
                    slug={props.slug}
                    setHoverSession={props.setHoverSession}
                    messageLabel={messageLabel}
                    onMessageSelect={(message) => {
                      if (!isActive())
                        layout.pendingMessage.set(
                          `${base64Encode(props.session.directory)}/${props.session.id}`,
                          message.id,
                        )

                      navigate(sessionHref(props.slug, props.session, `#message-${message.id}`))
                    }}
                    trigger={item}
                  />
                </Show>
              }
            >
              <div class={`flex items-center gap-3 min-w-0 ${props.dense ? "py-0.5" : "py-1"}`}>
                <div class="shrink-0 size-6 flex items-center justify-center">
                  <Show
                    when={props.selectMode?.()}
                    fallback={
                      <Show when={hasChildren()} fallback={<Icon name="dash" size="small" class="text-icon-weak" />}>
                        <TreeToggle
                          expanded={expanded()}
                          isWorking={isWorking()}
                          hasPermissions={hasPermissions()}
                          hasError={hasError()}
                          unseenCount={unseenCount()}
                          onToggle={props.onToggleChildren}
                        />
                      </Show>
                    }
                  >
                    <div
                      class={`size-3.5 rounded-sm border flex items-center justify-center transition-colors ${
                        props.selected?.()
                          ? "bg-text-interactive-base border-text-interactive-base"
                          : "border-icon-weak bg-transparent"
                      }`}
                    >
                      <Show when={props.selected?.()}>
                        <svg viewBox="0 0 12 12" fill="none" width="8" height="8" xmlns="http://www.w3.org/2000/svg">
                          <path
                            d="M2 6.5L4.5 9L10 3"
                            stroke="white"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </Show>
                    </div>
                  </Show>
                </div>
                <input
                  ref={renameInputRef}
                  value={renameValue()}
                  class="text-14-regular text-text-strong min-w-0 flex-1 bg-transparent outline-none border-b border-border-base"
                  onFocus={(e) => e.currentTarget.select()}
                  onInput={(e) => setRenameValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void commitRename()
                    }
                    if (e.key === "Escape") {
                      e.preventDefault()
                      setRenaming(false)
                    }
                  }}
                  onBlur={() => void commitRename()}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              </div>
            </Show>
          </div>

          <Show when={!renaming() && !props.selectMode?.()}>
            <div
              class={`absolute ${props.dense ? "top-0.5 right-0.5" : "top-1 right-1"} flex items-center gap-0.5 transition-opacity`}
              classList={{
                "opacity-100 pointer-events-auto": !!props.mobile,
                "opacity-0 pointer-events-none": !props.mobile,
                "group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                "group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
              }}
            >
              <Show when={props.deleteSession}>
                <Tooltip value={language.t("common.delete")} placement="top">
                  <IconButton
                    icon="trash"
                    variant="ghost"
                    class="size-6 rounded-md"
                    aria-label={language.t("common.delete")}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      const name = props.session.title ?? language.t("command.session.new")
                      dialog.show(() => (
                        <Dialog title={language.t("session.delete.title")} fit>
                          <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
                            <span class="text-14-regular text-text-strong">
                              {language.t("session.delete.confirm", { name })}
                            </span>
                            <div class="flex justify-end gap-2">
                              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                                {language.t("common.cancel")}
                              </Button>
                              <Button
                                variant="primary"
                                size="large"
                                onClick={async () => {
                                  await props.deleteSession!(props.session)
                                  dialog.close()
                                }}
                              >
                                {language.t("session.delete.button")}
                              </Button>
                            </div>
                          </div>
                        </Dialog>
                      ))
                    }}
                  />
                </Tooltip>
              </Show>
              <Show when={!props.unarchiveSession}>
                <Tooltip value={language.t("common.archive")} placement="top">
                  <IconButton
                    icon="archive"
                    variant="ghost"
                    class="size-6 rounded-md"
                    aria-label={language.t("common.archive")}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void props.archiveSession(props.session)
                    }}
                  />
                </Tooltip>
              </Show>
              <Show when={props.unarchiveSession}>
                <Tooltip value={language.t("common.unarchive")} placement="top">
                  <IconButton
                    icon="arrow-up"
                    variant="ghost"
                    class="size-6 rounded-md"
                    aria-label={language.t("common.unarchive")}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void props.unarchiveSession!(props.session)
                    }}
                  />
                </Tooltip>
              </Show>
            </div>
          </Show>
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content
          onCloseAutoFocus={(e) => {
            if (!renaming()) return
            e.preventDefault()
            renameInputRef?.focus()
            renameInputRef?.select()
          }}
        >
          <Show when={props.renameSession}>
            <ContextMenu.Item onSelect={startRename}>
              <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
          </Show>
          <Show when={!props.unarchiveSession}>
            <ContextMenu.Item onSelect={() => void props.archiveSession(props.session)}>
              <ContextMenu.ItemLabel>{language.t("common.archive")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </Show>
          <Show when={props.deleteSession}>
            <ContextMenu.Item
              onSelect={() => {
                const name = props.session.title ?? language.t("command.session.new")
                dialog.show(() => (
                  <Dialog title={language.t("session.delete.title")} fit>
                    <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
                      <span class="text-14-regular text-text-strong">
                        {language.t("session.delete.confirm", { name })}
                      </span>
                      <div class="flex justify-end gap-2">
                        <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                          {language.t("common.cancel")}
                        </Button>
                        <Button
                          variant="primary"
                          size="large"
                          onClick={async () => {
                            await props.deleteSession!(props.session)
                            dialog.close()
                          }}
                        >
                          {language.t("session.delete.button")}
                        </Button>
                      </div>
                    </div>
                  </Dialog>
                ))
              }}
            >
              <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </Show>
          <Show when={props.unarchiveSession}>
            <ContextMenu.Item onSelect={() => void props.unarchiveSession!(props.session)}>
              <ContextMenu.ItemLabel>{language.t("common.unarchive")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  setHoverSession: (id: string | undefined) => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-1 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        props.setHoverSession(undefined)
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <Icon name="new-session" size="small" class="text-icon-weak" />
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
