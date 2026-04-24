import "@/index.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Splash } from "@opencode-ai/ui/logo"
import { Popover } from "@opencode-ai/ui/popover"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { showToast } from "@opencode-ai/ui/toast"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Duration, Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { KnowledgeProvider } from "@/context/knowledge"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { AuthProvider } from "@/context/auth"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth, type ServerHealth } from "./utils/server-health"
import { LegacyDBGuard } from "@/components/legacy-db-guard"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { bootstrapSsh } from "@/utils/remote-ssh"
import { sortServers, splitServers } from "@/utils/server-list"

const HomeRoute = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const ReadingSession = lazy(() => import("@/pages/reading-session"))
const Loading = () => <div class="size-full" />

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

const ReadingSessionRoute = () => <ReadingSession />

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
    }
  }
}

function MarkedProviderWithNativeParser(props: ParentProps) {
  const platform = usePlatform()
  return <MarkedProvider nativeParser={platform.parseMarkdown}>{props.children}</MarkedProvider>
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <AuthProvider>
      <SettingsProvider>
        <PermissionProvider>
          <LayoutProvider>
            <NotificationProvider>
              <ModelsProvider>
                <CommandProvider>
                  <HighlightsProvider>
                    <KnowledgeProvider>
                      <Layout>{props.children}</Layout>
                    </KnowledgeProvider>
                  </HighlightsProvider>
                </CommandProvider>
              </ModelsProvider>
            </NotificationProvider>
          </LayoutProvider>
        </PermissionProvider>
      </SettingsProvider>
    </AuthProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <LegacyDBGuard />
      <Suspense fallback={<Loading />}>
        {props.appChildren}
        {props.children}
      </Suspense>
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        defaultTheme="matrix"
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <QueryProvider>
                <DialogProvider>
                  <MarkedProviderWithNativeParser>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProviderWithNativeParser>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

const effectMinDuration =
  (duration: Duration.Input) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.all([e, Effect.sleep(duration)], { concurrency: "unbounded" }).pipe(Effect.map((v) => v[0]))

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()
  const language = useLanguage()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")
  let last = 0
  const SSH_MS = 10_000
  const SSH_BOOT_MS = "130 seconds"
  const SSH_FAILS = 2
  const SSH_RETRY = [2_000, 5_000, 10_000, 20_000, 30_000]
  const OFF = "disabled"
  const ready = new Set<ServerConnection.Key>()
  let sshKey = ""
  let sshFail = 0
  let sshTry = 0
  let sshBusy = false
  let sshTimer: ReturnType<typeof setTimeout> | undefined
  let sshShown = false

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(
    () => {
      const current = server.current
      const key = props.disableHealthCheck && current?.type !== "ssh" ? OFF : server.key
      return key
    },
    (key) => {
      if (key === OFF) return true
      return Effect.gen(function* () {
          if (!server.current) return true
          let conn = server.current

          if (conn.type === "ssh") {
            const ssh = conn
            const key = ServerConnection.key(ssh)
            if (!ready.has(key)) {
              const owner = ssh.owner ?? server.list.find((item) => item.type !== "ssh")?.http
              if (!owner?.url) return false
              const next = yield* Effect.promise(() =>
                bootstrapSsh(owner, {
                  savedHostID: ssh.id,
                  host: ssh.host,
                  command: ssh.command,
                  installDir: ssh.installDir,
                }).catch(() => undefined),
              )
              if (!next) return false
              const saved: ServerConnection.Ssh = {
                ...ssh,
                owner,
                http: next.endpoint,
              }
              ready.add(key)
              server.upsert(saved)
              server.projects.open(next.landing.rootDirectory)
              server.projects.touch(next.landing.directory)
              conn = saved
            } else {
              if (Date.now() - last < SSH_MS) return false
              last = Date.now()
            }
          }

          const { http, type } = conn

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          effectMinDuration(checkMode() === "blocking" ? "1.2 seconds" : 0),
          Effect.timeoutOrElse({
            duration: server.current?.type === "ssh" && !ready.has(ServerConnection.key(server.current)) ? SSH_BOOT_MS : "10 seconds",
            onTimeout: () => Effect.succeed(false),
          }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        )
    },
  )

  const clearSsh = () => {
    if (!sshTimer) return
    clearTimeout(sshTimer)
    sshTimer = undefined
  }

  const retrySsh = async (conn: ServerConnection.Ssh) => {
    if (sshBusy) return
    const active = ServerConnection.key(conn)
    const base = conn.owner ?? server.list.find((item) => item.type !== "ssh")?.http
    if (!base?.url) return
    sshBusy = true
    if (!sshShown) {
      sshShown = true
      showToast({
        title: language.t("app.server.sshReconnect.title", { host: conn.host }),
        description: language.t("app.server.sshReconnect.description"),
      })
    }
    try {
      const out = await bootstrapSsh(base, {
        savedHostID: conn.id,
        host: conn.host,
        command: conn.command,
        installDir: conn.installDir,
      }).catch(() => undefined)
      if (!out) return
      sshTry = 0
      sshFail = 0
      sshShown = false
      if (server.current && ServerConnection.key(server.current) !== active) return
      server.upsert({
        ...conn,
        owner: base,
        http: out.endpoint,
      })
      server.projects.open(out.landing.rootDirectory)
      server.projects.touch(out.landing.directory)
      healthCheckActions.refetch()
      showToast({
        variant: "success",
        title: language.t("app.server.sshReconnect.success.title", { host: conn.host }),
        description: language.t("app.server.sshReconnect.success.description", { version: out.version.chosen }),
      })
    } finally {
      sshBusy = false
    }
  }

  createEffect(() => {
    const conn = server.current
    const ok = server.healthy()
    const checked = server.checkedAt()
    const key = conn ? ServerConnection.key(conn) : ""

    void checked

    if (key !== sshKey) {
      sshKey = key
      sshFail = 0
      sshTry = 0
      sshBusy = false
      sshShown = false
      clearSsh()
    }

    if (conn?.type !== "ssh") {
      sshFail = 0
      sshTry = 0
      sshShown = false
      clearSsh()
      return
    }

    const active = ServerConnection.key(conn)
    if (ok === true) {
      ready.add(active)
    }
    if (!ready.has(active)) return

    if (ok === true) {
      sshFail = 0
      sshTry = 0
      sshShown = false
      clearSsh()
      return
    }

    if (ok !== false) return
    sshFail += 1
    if (sshFail < SSH_FAILS || sshBusy || sshTimer) return
    const wait = SSH_RETRY[Math.min(sshTry, SSH_RETRY.length - 1)]!
    showToast({
      title: language.t("app.server.sshReconnect.retry.title", { seconds: Math.ceil(wait / 1000) }),
      description: language.t("app.server.sshReconnect.retry.description", { host: conn.host }),
    })
    sshTimer = setTimeout(() => {
      sshTimer = undefined
      sshTry += 1
      void retrySsh(conn)
    }, wait)
  })

  createEffect(() => {
    const conn = server.current
    if (conn?.type !== "ssh") return
    if (checkMode() !== "background") return
    if (startupHealthCheck() !== false) return

    const timer = setInterval(() => healthCheckActions.refetch(), 1000)
    onCleanup(() => clearInterval(timer))
  })

  onCleanup(() => {
    clearSsh()
  })

  const ssh = createMemo(() => server.current?.type === "ssh")
  const done = createMemo(() =>
    checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending",
  )
  const selected = (key: ServerConnection.Key) => {
    setCheckMode("blocking")
    server.setActive(key)
    healthCheckActions.refetch()
  }

  return (
    <Show
      when={ssh() || done()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck()}
        fallback={
          <Show
            when={!ssh()}
            fallback={
              <SshStartupShell
                onServerSelected={selected}
              />
            }
          >
            <ConnectionError
              onRetry={() => {
                if (checkMode() === "background") healthCheckActions.refetch()
              }}
              onServerSelected={selected}
            />
          </Show>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function SshStartupShell(props: { onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const check = useCheckServerHealth()
  const current = createMemo(() => server.current)
  const conn = createMemo(() => {
    const value = current()
    if (value?.type !== "ssh") return
    return value
  })
  const title = createMemo(() => server.name || server.key)
  const [shown, setShown] = createSignal(false)
  const [status, setStatus] = createSignal({} as Record<ServerConnection.Key, ServerHealth | undefined>)
  const servers = createMemo(() => {
    const value = current()
    if (!value) return server.list
    if (server.list.every((item) => ServerConnection.key(item) !== ServerConnection.key(value))) {
      return [value, ...server.list]
    }
    return [value, ...server.list.filter((item) => ServerConnection.key(item) !== ServerConnection.key(value))]
  })
  const groups = createMemo(() => splitServers(sortServers(servers(), server.key, status())))
  const health = createMemo(() => status()[server.key]?.healthy ?? server.healthy())

  createEffect(() => {
    if (!shown()) {
      setStatus({})
      return
    }
    const list = servers()
    let dead = false
    const refresh = async () => {
      const next: Record<ServerConnection.Key, ServerHealth> = {}
      await Promise.all(
        list.map(async (item) => {
          next[ServerConnection.key(item)] = await check(item.http)
        }),
      )
      if (!dead) setStatus(next)
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10_000)
    onCleanup(() => {
      dead = true
      clearInterval(timer)
    })
  })

  return (
    <div class="h-dvh w-screen bg-background-base text-text-base flex flex-col overflow-hidden select-none">
      <header class="h-10 shrink-0 bg-background-base relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
        <div class="flex items-center min-w-0 pl-2">
          <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
            <Button variant="ghost" class="titlebar-icon rounded-md w-8 h-6 p-0 box-border">
              <Icon name="menu" size="small" />
            </Button>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <Button variant="ghost" class="hidden xl:flex titlebar-icon w-8 h-6 p-0 box-border">
              <Icon name="sidebar" size="small" />
            </Button>
            <div class="hidden xl:flex items-center shrink-0">
              <div class="flex items-center shrink-0 w-8 mr-1">
                <Button variant="ghost" class="titlebar-icon w-8 h-6 p-0 box-border opacity-60">
                  <Icon name="new-session" size="small" />
                </Button>
              </div>
              <div class="flex items-center gap-0 transition-transform">
                <Button variant="ghost" icon="chevron-left" class="titlebar-icon w-6 h-6 p-0 box-border" disabled />
                <Button variant="ghost" icon="chevron-right" class="titlebar-icon w-6 h-6 p-0 box-border" disabled />
              </div>
            </div>
          </div>
          <div class="flex items-center gap-3 min-w-0 px-2" />
        </div>

        <div class="min-w-0 flex items-center justify-center pointer-events-none">
          <div class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full">
            <Button
              type="button"
              variant="ghost"
              size="small"
              class="hidden md:flex w-[240px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default"
            >
              <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
                {conn()?.host ?? title()}
              </span>
              <span class="h-3 w-10 rounded-sm bg-surface-base animate-pulse shrink-0" />
            </Button>
          </div>
        </div>

        <div class="flex items-center min-w-0 justify-end pr-2">
          <div class="flex items-center gap-1 shrink-0 justify-end">
            <div class="hidden xl:flex items-center">
              <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                <Button
                  variant="ghost"
                  class="rounded-none h-full px-0.5 border-none shadow-none disabled:!cursor-default"
                  disabled
                >
                  <div class="flex size-5 shrink-0 items-center justify-center">
                    <Icon name="folder" size="small" class="text-icon-base" />
                  </div>
                </Button>
                <Button
                  variant="ghost"
                  icon="chevron-down"
                  class="rounded-none h-full w-[20px] p-0 border-none shadow-none"
                  disabled
                />
              </div>
            </div>
            <Popover
              open={shown()}
              onOpenChange={setShown}
              triggerAs={Button}
              triggerProps={{
                variant: "ghost",
                class: "titlebar-icon w-8 h-6 p-0 box-border",
                "aria-label": language.t("status.popover.trigger"),
                style: { scale: 1 },
              }}
              trigger={
                <div class="relative size-4">
                  <div class="badge-mask-tight size-4 flex items-center justify-center">
                    <Icon name={shown() ? "status-active" : "status"} size="small" />
                  </div>
                  <div
                    classList={{
                      "absolute -top-px -right-px size-1.5 rounded-full": true,
                      "bg-icon-success-base": health() === true,
                      "bg-icon-critical-base": health() === false,
                      "bg-border-weak-base": health() === undefined,
                    }}
                  />
                </div>
              }
              class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
              gutter={4}
              placement="bottom-end"
              shift={-168}
            >
              <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
                <div class="bg-background-strong rounded-xl overflow-hidden w-full pt-2">
                  <div class="px-4 pb-2 text-12-regular text-text-weak">
                    {groups().length > 0 ? `${servers().length} ` : ""}
                    {language.t("status.popover.tab.servers")}
                  </div>
                  <div class="flex flex-col px-2 pb-2">
                    <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                      <For each={groups()}>
                        {(group) => (
                          <div class="flex flex-col">
                            <Show when={group.category === "ssh"}>
                              <div class="px-3 py-1 text-11-medium text-text-weak uppercase tracking-wide">
                                {language.t("dialog.server.group.ssh")}
                              </div>
                            </Show>
                            <For each={group.items}>
                              {(item) => {
                                const key = ServerConnection.key(item)
                                const blocked = () => item.type !== "ssh" && status()[key]?.healthy === false
                                return (
                                  <button
                                    type="button"
                                    class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                                    classList={{
                                      "hover:bg-surface-raised-base-hover": !blocked(),
                                      "cursor-not-allowed": blocked(),
                                    }}
                                    aria-disabled={blocked()}
                                    onClick={() => {
                                      if (blocked()) return
                                      setShown(false)
                                      props.onServerSelected?.(key)
                                    }}
                                  >
                                    <ServerHealthIndicator health={status()[key]} />
                                    <ServerRow
                                      conn={item}
                                      dimmed={blocked()}
                                      status={status()[key]}
                                      class="flex items-center gap-2 w-full min-w-0"
                                      nameClass="text-14-regular text-text-base truncate"
                                      versionClass="text-12-regular text-text-weak truncate"
                                    >
                                      <div class="flex-1" />
                                      <Show when={key === server.key}>
                                        <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                                      </Show>
                                    </ServerRow>
                                  </button>
                                )
                              }}
                            </For>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </div>
            </Popover>
            <Button variant="ghost" class="titlebar-icon w-8 h-6 p-0 box-border shrink-0">
              <Icon size="small" name="terminal" />
            </Button>
            <div class="hidden md:flex items-center gap-1 shrink-0">
              <Button variant="ghost" class="titlebar-icon w-8 h-6 p-0 box-border">
                <Icon size="small" name="review" />
              </Button>
              <Button variant="ghost" class="titlebar-icon w-8 h-6 p-0 box-border">
                <Icon size="small" name="file-tree" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div class="flex-1 min-h-0 flex">
        <aside class="hidden xl:flex w-16 shrink-0 border-r border-border-weaker-base bg-background-base flex-col items-center py-3 gap-3">
          <For each={[0, 1, 2, 3]}>
            {() => <div class="size-9 rounded-lg bg-surface-base animate-pulse" />}
          </For>
        </aside>
        <aside class="hidden xl:flex w-72 shrink-0 border-r border-border-weaker-base bg-background-base flex-col p-4 gap-4">
          <div class="flex flex-col gap-2">
            <div class="h-4 w-32 rounded-sm bg-surface-base animate-pulse" />
            <div class="h-3 w-48 rounded-sm bg-surface-base animate-pulse" />
          </div>
          <div class="h-9 rounded-md bg-surface-base animate-pulse" />
          <div class="flex flex-col gap-2">
            <For each={[0, 1, 2, 3, 4]}>
              {() => <div class="h-8 rounded-md bg-surface-base animate-pulse" />}
            </For>
          </div>
        </aside>
        <main class="flex-1 min-w-0 min-h-0 bg-background-base border-t border-border-weak-base xl:rounded-tl-[12px] xl:border-l overflow-hidden">
          <div class="h-12 border-b border-border-weaker-base flex items-center justify-between px-4">
            <div class="min-w-0 flex flex-col gap-1">
              <div class="h-3 w-40 max-w-[45vw] rounded-sm bg-surface-base animate-pulse" />
              <Show when={conn()}>
                {(ssh) => <div class="text-12-regular text-text-weak truncate">{ssh().host}</div>}
              </Show>
            </div>
            <div class="text-12-regular text-text-weak">{language.t("app.server.retrying")}</div>
          </div>
          <div class="size-full flex items-center justify-center px-8 pb-24">
            <div class="w-full max-w-xl flex flex-col gap-3">
              <div class="h-4 w-1/2 rounded-sm bg-surface-base animate-pulse" />
              <div class="h-3 w-5/6 rounded-sm bg-surface-base animate-pulse" />
              <div class="h-3 w-2/3 rounded-sm bg-surface-base animate-pulse" />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {(_key) => <>{props.children}</>}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
  basePath?: string
}) {
  const routerBase = props.basePath && props.basePath !== "/" ? props.basePath : undefined
  return (
    <ServerProvider defaultServer={props.defaultServer} servers={props.servers}>
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <Dynamic
                component={props.router ?? Router}
                base={routerBase}
                root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
              >
                <Route path="/" component={HomeRoute} />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={SessionIndexRoute} />
                  <Route path="/session/:id?" component={SessionRoute} />
                  <Route path="/session/:id/reading" component={ReadingSessionRoute} />
                </Route>
              </Dynamic>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}
