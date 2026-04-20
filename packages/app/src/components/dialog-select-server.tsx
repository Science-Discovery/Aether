import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { showPromiseToast, showToast } from "@opencode-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import { batch, createEffect, createMemo, createResource, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { remoteHref } from "@/pages/layout/remote-landing"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"
import { serverGroups, serverGroup, sortServers } from "@/utils/server-list"
import { bootstrapSsh } from "@/utils/remote-ssh"

const DEFAULT_USERNAME = "opencode"
const DEFAULT_INSTALL_DIR = "~/.opencode/bin"

function showSshToast(promise: Promise<Awaited<ReturnType<typeof bootstrapSsh>>>, host: string) {
  return showPromiseToast(promise, {
    loading: <span>正在连接 {host}，并准备远端服务…</span>,
    success: (data) => <span>已连接 {host}，远端版本 {data.version.chosen} 已就绪。</span>,
    error: (err) => <span>{err instanceof Error ? err.message : String(err)}</span>,
  })
}

interface ServerFormProps {
  kind: "http" | "ssh"
  value: string
  name: string
  host: string
  installDir: string
  username: string
  password: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  onChange: (value: string) => void
  onNameChange: (value: string) => void
  onHostChange: (value: string) => void
  onInstallDirChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
}

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultUrlActions] = createResource(
    async () => {
      try {
        const key = await platform.getDefaultServer?.()
        if (!key) return null
        return key
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  const setDefault = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultUrlActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return { defaultKey, canDefault, setDefault }
}

function useServerPreview() {
  const checkServerHealth = useCheckServerHealth()

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = async (
    value: string,
    username: string,
    password: string,
    setStatus: (value: boolean | undefined) => void,
  ) => {
    setStatus(undefined)
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const http: ServerConnection.HttpBase = { url: normalized }
    if (username) http.username = username
    if (password) http.password = password
    const result = await checkServerHealth(http)
    setStatus(result.healthy)
  }

  return { previewStatus }
}

function ServerForm(props: ServerFormProps) {
  const language = useLanguage()
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      props.onBack()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    props.onSubmit()
  }

  return (
    <div class="px-5">
      <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
        <div class="flex-1 min-w-0 [&_[data-slot=input-wrapper]]:relative">
          <TextField
            type="text"
            label={props.kind === "ssh" ? "SSH Command" : language.t("dialog.server.add.url")}
            placeholder={props.placeholder}
            value={props.value}
            autofocus
            validationState={props.error ? "invalid" : "valid"}
            error={props.error}
            disabled={props.busy}
            onChange={props.onChange}
            onKeyDown={keyDown}
          />
        </div>
        <TextField
          type="text"
          label={language.t("dialog.server.add.name")}
          placeholder={language.t("dialog.server.add.namePlaceholder")}
          value={props.name}
          disabled={props.busy}
          onChange={props.onNameChange}
          onKeyDown={keyDown}
        />
        <Show
          when={props.kind === "ssh"}
          fallback={
            <div class="grid grid-cols-2 gap-2 min-w-0">
              <TextField
                type="text"
                label={language.t("dialog.server.add.username")}
                placeholder={language.t("dialog.server.add.usernamePlaceholder")}
                value={props.username}
                disabled={props.busy}
                onChange={props.onUsernameChange}
                onKeyDown={keyDown}
              />
              <TextField
                type="password"
                label={language.t("dialog.server.add.password")}
                placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                value={props.password}
                disabled={props.busy}
                onChange={props.onPasswordChange}
                onKeyDown={keyDown}
              />
            </div>
          }
        >
          <div class="grid grid-cols-2 gap-2 min-w-0">
            <TextField
              type="text"
              label="Host"
              placeholder="user@host"
              value={props.host}
              disabled={props.busy}
              onChange={props.onHostChange}
              onKeyDown={keyDown}
            />
            <TextField
              type="text"
              label="Install Dir"
              placeholder={DEFAULT_INSTALL_DIR}
              value={props.installDir}
              disabled={props.busy}
              onChange={props.onInstallDirChange}
              onKeyDown={keyDown}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}

export function DialogSelectServer() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const { defaultKey, canDefault, setDefault } = useDefaultServer()
  const { previewStatus } = useServerPreview()
  const checkServerHealth = useCheckServerHealth()
  const [store, setStore] = createStore({
    status: {} as Record<ServerConnection.Key, ServerHealth | undefined>,
    addServer: {
      kind: "http" as "http" | "ssh",
      url: "",
      name: "",
      host: "",
      installDir: DEFAULT_INSTALL_DIR,
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
    },
    editServer: {
      kind: "http" as "http" | "ssh",
      id: undefined as string | undefined,
      value: "",
      name: "",
      host: "",
      installDir: DEFAULT_INSTALL_DIR,
      username: "",
      password: "",
      error: "",
      status: undefined as boolean | undefined,
    },
  })

  const resetAdd = () => {
    setStore("addServer", {
      kind: "http",
      url: "",
      name: "",
      host: "",
      installDir: DEFAULT_INSTALL_DIR,
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined,
    })
  }
  const resetEdit = () => {
    setStore("editServer", {
      kind: "http",
      id: undefined,
      value: "",
      name: "",
      host: "",
      installDir: DEFAULT_INSTALL_DIR,
      username: "",
      password: "",
      error: "",
      status: undefined,
    })
  }

  const addMutation = useMutation(() => ({
    mutationFn: async (value: string) => {
      if (store.addServer.kind === "ssh") {
        const conn: ServerConnection.Ssh = {
          type: "ssh",
          id: crypto.randomUUID(),
          displayName: store.addServer.name.trim() || undefined,
          host: store.addServer.host.trim() || value.trim(),
          command: value.trim(),
          installDir: store.addServer.installDir.trim() || DEFAULT_INSTALL_DIR,
          http: { url: "" },
        }
        await select(conn, true)
        return
      }
      const normalized = normalizeServerUrl(value)
      if (!normalized) {
        resetAdd()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        http: { url: normalized },
      }
      if (store.addServer.name.trim()) conn.displayName = store.addServer.name.trim()
      if (store.addServer.password) conn.http.password = store.addServer.password
      if (store.addServer.password && store.addServer.username) conn.http.username = store.addServer.username
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("addServer", { error: language.t("dialog.server.add.error") })
        return
      }

      resetAdd()
      await select(conn, true)
    },
  }))

  const editMutation = useMutation(() => ({
    mutationFn: async (input: { original: ServerConnection.Any; value: string }) => {
      if (input.original.type === "ssh") {
        const conn: ServerConnection.Ssh = {
          ...input.original,
          displayName: store.editServer.name.trim() || undefined,
          host: store.editServer.host.trim() || input.original.host,
          command: input.value.trim(),
          installDir: store.editServer.installDir.trim() || DEFAULT_INSTALL_DIR,
        }
        server.upsert(conn)
        resetEdit()
        return
      }
      if (input.original.type !== "http") return
      const normalized = normalizeServerUrl(input.value)
      if (!normalized) {
        resetEdit()
        return
      }

      const name = store.editServer.name.trim() || undefined
      const username = store.editServer.username || undefined
      const password = store.editServer.password || undefined
      const existingName = input.original.displayName
      if (
        normalized === input.original.http.url &&
        name === existingName &&
        username === input.original.http.username &&
        password === input.original.http.password
      ) {
        resetEdit()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        displayName: name,
        http: { url: normalized, username, password },
      }
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("editServer", { error: language.t("dialog.server.add.error") })
        return
      }
      if (normalized === input.original.http.url) {
        server.upsert(conn)
      } else {
        replaceServer(input.original, conn)
      }

      resetEdit()
    },
  }))

  const replaceServer = (original: ServerConnection.Http, next: ServerConnection.Http) => {
    const active = server.key
    const newConn = server.upsert(next)
    if (!newConn) return
    const nextActive = active === ServerConnection.key(original) ? ServerConnection.key(newConn) : active
    if (nextActive) server.setActive(nextActive)
    server.remove(ServerConnection.key(original))
  }

  const items = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const current = createMemo(() => items().find((x) => ServerConnection.key(x) === server.key) ?? items()[0])

  const sortedItems = createMemo(() => {
    current()
    return sortServers(items(), server.key, store.status)
  })

  async function refreshHealth() {
    const results: Record<ServerConnection.Key, ServerHealth> = {}
    await Promise.all(
      items().map(async (conn) => {
        if (!conn.http.url) return
        results[ServerConnection.key(conn)] = await checkServerHealth(conn.http)
      }),
    )
    setStore("status", reconcile(results))
  }

  createEffect(() => {
    items()
    refreshHealth()
    const interval = setInterval(refreshHealth, 10_000)
    onCleanup(() => clearInterval(interval))
  })

  async function select(conn: ServerConnection.Any, persist?: boolean) {
    if (!persist && conn.type !== "ssh" && store.status[ServerConnection.key(conn)]?.healthy === false) return
    if (conn.type === "ssh") {
      const current = server.current?.http
      if (!current?.url) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: "No active backend available for SSH bootstrap",
        })
        return
      }
      const task = bootstrapSsh(current, {
        savedHostID: conn.id,
        host: conn.host,
        command: conn.command,
        installDir: conn.installDir,
      })
      showSshToast(task, conn.host)
      const next = await task.catch((err) => {
        const text = err instanceof Error ? err.message : String(err)
        showToast({
          variant: "error",
          title: "SSH bootstrap failed",
          description: text,
        })
        return
      })
      if (!next) return
      const saved: ServerConnection.Ssh = {
        ...conn,
        owner: current,
        http: next.endpoint,
      }
      dialog.close()
      batch(() => {
        server.upsert(saved)
        server.projects.open(next.landing.rootDirectory)
        server.projects.touch(next.landing.directory)
      })
      navigate(remoteHref(next.landing))
      return
    }
    dialog.close()
    if (persist && conn.type === "http") {
      server.upsert(conn)
      navigate("/")
      return
    }
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(conn)))
  }

  const handleAddChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { url: value, error: "" })
    if (store.addServer.kind === "ssh") return
    void previewStatus(value, store.addServer.username, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddNameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { name: value, error: "" })
  }

  const handleAddHostChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { host: value, error: "" })
  }

  const handleAddInstallDirChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { installDir: value, error: "" })
  }

  const handleAddUsernameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { username: value, error: "" })
    void previewStatus(store.addServer.url, value, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddPasswordChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { password: value, error: "" })
    void previewStatus(store.addServer.url, store.addServer.username, value, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleEditChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { value, error: "" })
    if (store.editServer.kind === "ssh") return
    void previewStatus(value, store.editServer.username, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditNameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { name: value, error: "" })
  }

  const handleEditHostChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { host: value, error: "" })
  }

  const handleEditInstallDirChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { installDir: value, error: "" })
  }

  const handleEditUsernameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { username: value, error: "" })
    void previewStatus(store.editServer.value, value, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditPasswordChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { password: value, error: "" })
    void previewStatus(store.editServer.value, store.editServer.username, value, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const mode = createMemo<"list" | "add" | "edit">(() => {
    if (store.editServer.id) return "edit"
    if (store.addServer.showForm) return "add"
    return "list"
  })

  const editing = createMemo(() => {
    if (!store.editServer.id) return
    return items().find((x) => ServerConnection.key(x) === store.editServer.id)
  })

  const resetForm = () => {
    resetAdd()
    resetEdit()
  }

  const startAdd = (kind: "http" | "ssh" = "http") => {
    resetEdit()
    setStore("addServer", {
      kind,
      showForm: true,
      url: "",
      name: "",
      host: "",
      installDir: DEFAULT_INSTALL_DIR,
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      status: undefined,
    })
  }

  const startEdit = (conn: ServerConnection.Any) => {
    resetAdd()
    setStore("editServer", {
      kind: conn.type === "ssh" ? "ssh" : "http",
      id: ServerConnection.key(conn),
      value: conn.type === "ssh" ? conn.command : conn.http.url,
      name: conn.displayName ?? "",
      host: conn.type === "ssh" ? conn.host : "",
      installDir: conn.type === "ssh" ? conn.installDir : DEFAULT_INSTALL_DIR,
      username: conn.type === "http" ? conn.http.username ?? "" : "",
      password: conn.type === "http" ? conn.http.password ?? "" : "",
      error: "",
      status: store.status[ServerConnection.key(conn)]?.healthy,
    })
  }

  const submitForm = () => {
    if (mode() === "add") {
      if (addMutation.isPending) return
      setStore("addServer", { error: "" })
      addMutation.mutate(store.addServer.url)
      return
    }
    const original = editing()
    if (!original) return
    if (editMutation.isPending) return
    setStore("editServer", { error: "" })
    editMutation.mutate({ original, value: store.editServer.value })
  }

  const isFormMode = createMemo(() => mode() !== "list")
  const isAddMode = createMemo(() => mode() === "add")
  const formBusy = createMemo(() => (isAddMode() ? addMutation.isPending : editMutation.isPending))
  const formKind = createMemo(() => (isAddMode() ? store.addServer.kind : store.editServer.kind))

  const formTitle = createMemo(() => {
    if (!isFormMode()) return language.t("dialog.server.title")
    return (
      <div class="flex items-center gap-2 -ml-2">
        <IconButton icon="arrow-left" variant="ghost" onClick={resetForm} aria-label={language.t("common.goBack")} />
        <span>{isAddMode() ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")}</span>
      </div>
    )
  })

  createEffect(() => {
    if (!store.editServer.id) return
    if (editing()) return
    resetEdit()
  })

  async function handleRemove(url: ServerConnection.Key) {
    server.remove(url)
    if ((await platform.getDefaultServer?.()) === url) {
      platform.setDefaultServer?.(null)
    }
  }

  return (
    <Dialog title={formTitle()}>
      <div class="flex flex-col gap-2">
        <Show
          when={!isFormMode()}
          fallback={
            <ServerForm
              value={isAddMode() ? store.addServer.url : store.editServer.value}
              kind={formKind()}
              name={isAddMode() ? store.addServer.name : store.editServer.name}
              host={isAddMode() ? store.addServer.host : store.editServer.host}
              installDir={isAddMode() ? store.addServer.installDir : store.editServer.installDir}
              username={isAddMode() ? store.addServer.username : store.editServer.username}
              password={isAddMode() ? store.addServer.password : store.editServer.password}
              placeholder={formKind() === "ssh" ? `ssh -i "~/.ssh/id_ed25519" user@host` : language.t("dialog.server.add.placeholder")}
              busy={formBusy()}
              error={isAddMode() ? store.addServer.error : store.editServer.error}
              status={isAddMode() ? store.addServer.status : store.editServer.status}
              onChange={isAddMode() ? handleAddChange : handleEditChange}
              onNameChange={isAddMode() ? handleAddNameChange : handleEditNameChange}
              onHostChange={isAddMode() ? handleAddHostChange : handleEditHostChange}
              onInstallDirChange={isAddMode() ? handleAddInstallDirChange : handleEditInstallDirChange}
              onUsernameChange={isAddMode() ? handleAddUsernameChange : handleEditUsernameChange}
              onPasswordChange={isAddMode() ? handleAddPasswordChange : handleEditPasswordChange}
              onSubmit={submitForm}
              onBack={resetForm}
            />
          }
        >
          <List
            search={{
              placeholder: language.t("dialog.server.search.placeholder"),
              autofocus: false,
            }}
            noInitialSelection
            emptyMessage={language.t("dialog.server.empty")}
            items={sortedItems}
            key={(x) => ServerConnection.key(x)}
            groupBy={serverGroup}
            sortGroupsBy={(a, b) => serverGroups.indexOf(a.category as "other" | "ssh") - serverGroups.indexOf(b.category as "other" | "ssh")}
            groupHeader={(group) =>
              group.category === "ssh" ? language.t("dialog.server.group.ssh") : <div class="h-0" aria-hidden="true" />
            }
            onSelect={(x) => {
              if (x) select(x)
            }}
            divider={true}
            class="px-5 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-scroll]]h-[300px] [&_[data-slot=list-scroll]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
          >
            {(i) => {
              const key = ServerConnection.key(i)
              const blocked = () => i.type !== "ssh" && store.status[key]?.healthy === false
              return (
                <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
                  <div class="flex flex-col h-full items-start w-5">
                    <ServerHealthIndicator health={store.status[key]} />
                  </div>
                  <ServerRow
                    conn={i}
                    dimmed={blocked()}
                    status={store.status[key]}
                    class="flex items-center gap-3 min-w-0 flex-1"
                    badge={
                      <Show when={defaultKey() === ServerConnection.key(i)}>
                        <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs">
                          {language.t("dialog.server.status.default")}
                        </span>
                      </Show>
                    }
                    showCredentials
                  />
                  <div class="flex items-center justify-center gap-4 pl-4">
                    <Show when={ServerConnection.key(current()) === key}>
                      <Icon name="check" class="h-6" />
                    </Show>

                    <Show when={i.type === "http" || i.type === "ssh"}>
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
                          onClick={(e: MouseEvent) => e.stopPropagation()}
                          onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content class="mt-1">
                            <DropdownMenu.Item
                              onSelect={() => {
                                startEdit(i)
                              }}
                            >
                              <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <Show when={canDefault() && defaultKey() !== key}>
                              <DropdownMenu.Item onSelect={() => setDefault(key)}>
                                <DropdownMenu.ItemLabel>
                                  {language.t("dialog.server.menu.default")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <Show when={canDefault() && defaultKey() === key}>
                              <DropdownMenu.Item onSelect={() => setDefault(null)}>
                                <DropdownMenu.ItemLabel>
                                  {language.t("dialog.server.menu.defaultRemove")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item
                              onSelect={() => handleRemove(ServerConnection.key(i))}
                              class="text-text-on-critical-base hover:bg-surface-critical-weak"
                            >
                              <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </Show>
                  </div>
                </div>
              )
            }}
          </List>
        </Show>

        <div class="px-5 pb-5">
          <Show
            when={isFormMode()}
            fallback={
              <div class="flex items-center gap-2">
                <Button
                  variant="secondary"
                  icon="plus-small"
                  size="large"
                  onClick={() => startAdd("http")}
                  class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
                >
                  {language.t("dialog.server.add.button")}
                </Button>
                <Button variant="secondary" size="large" onClick={() => startAdd("ssh")} class="py-1.5 px-3">
                  SSH
                </Button>
              </div>
            }
          >
            <Button variant="primary" size="large" onClick={submitForm} disabled={formBusy()} class="px-3 py-1.5">
              {formBusy()
                ? language.t("dialog.server.add.checking")
                : isAddMode()
                  ? language.t("dialog.server.add.button")
                  : language.t("common.save")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
