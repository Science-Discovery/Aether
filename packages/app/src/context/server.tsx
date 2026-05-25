import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { disconnectSsh } from "@/utils/remote-ssh"
import { useCheckServerHealth } from "@/utils/server-health"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer =
  | string
  | ServerConnection.HttpBase
  | ServerConnection.Http
  | ServerConnection.Sidecar
  | ServerConnection.Ssh
const HEALTH_POLL_INTERVAL_MS = 10_000

function ident() {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  if (conn.type === "ssh") return conn.host
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function projectsKey(key: ServerConnection.Key) {
  if (!key) return ""
  if (key === "sidecar") return "local"
  if (isLocalHost(key)) return "local"
  return key
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    id: string
    host: string
    command: string
    installDir: string
    password?: string
    owner?: HttpBase
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.id}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultServer: ServerConnection.Key; servers?: Array<ServerConnection.Any> }) => {
    const checkServerHealth = useCheckServerHealth()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as StoredServer[],
        active: undefined as ServerConnection.Key | undefined,
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const normalize = (value: StoredServer): ServerConnection.Any => {
      if (typeof value === "string") {
        return {
          type: "http",
          http: { url: value },
        }
      }
      if (!("type" in value)) {
        return {
          type: "http",
          http: value,
        }
      }
      if (value.type !== "ssh") return value
      return {
        ...value,
        id: value.id || ident(),
      }
    }

    const keyOf = (value: StoredServer) => ServerConnection.key(normalize(value))

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      const servers = [
        ...(props.servers ?? []),
        ...store.list.map(normalize),
      ]

      const deduped = new Map(
        servers.map((value) => {
          return [ServerConnection.key(value), value]
        }),
      )

      return [...deduped.values()]
    })

    createEffect(() => {
      if (!ready()) return
      const next = store.list.map((value) => normalize(value))
      if (next.every((value, idx) => JSON.stringify(value) === JSON.stringify(store.list[idx]))) return
      setStore("list", next)
    })

    const [state, setState] = createStore({
      healthy: undefined as boolean | undefined,
      checkedAt: 0,
    })

    const active = createMemo<ServerConnection.Key>(() => {
      const saved = store.active ?? props.defaultServer
      if (allServers().some((item) => ServerConnection.key(item) === saved)) return saved
      const first = allServers()[0]
      if (first) return ServerConnection.key(first)
      return props.defaultServer
    })

    const healthy = () => state.healthy
    const checkedAt = () => state.checkedAt

    function startHealthPolling(conn: ServerConnection.Any) {
      let alive = true
      let busy = false

      const run = () => {
        if (busy) return
        busy = true
        void check(conn)
          .then((next) => {
            if (!alive) return
            setState({
              healthy: next,
              checkedAt: Date.now(),
            })
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, HEALTH_POLL_INTERVAL_MS)
      return () => {
        alive = false
        clearInterval(interval)
      }
    }

    function setActive(input: ServerConnection.Key) {
      const prev = current()
      if (prev?.type === "ssh" && active() !== input && prev.owner) {
        void disconnectSsh(prev.owner, prev.id).catch(() => undefined)
      }
      if (store.active !== input) setStore("active", input)
    }

    function upsert(input: ServerConnection.Any, options?: { active?: boolean }) {
      const conn =
        input.type === "http" || input.type === "sidecar"
          ? ({ ...input, http: { ...input.http, url: normalizeServerUrl(input.http.url) ?? input.http.url } } as ServerConnection.Any)
          : ({
              ...input,
              id: input.id || ident(),
              http: { ...input.http, url: normalizeServerUrl(input.http.url) ?? input.http.url },
            } as ServerConnection.Any)
      if ((conn.type === "http" || conn.type === "sidecar") && !conn.http.url) return
      return batch(() => {
        const key = ServerConnection.key(conn)
        const existing = store.list.findIndex((x) => keyOf(x) === key)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        if (options?.active !== false) {
          setStore("active", key)
        }
        return conn
      })
    }

    function add(input: ServerConnection.Http) {
      return upsert(input)
    }

    function remove(key: ServerConnection.Key) {
      const list = store.list.filter((x) => keyOf(x) !== key)
      batch(() => {
        setStore("list", list)
        if (active() === key) {
          const next = list[0]
          setStore("active", next ? keyOf(next) : props.defaultServer)
        }
      })
    }

    const isReady = createMemo(() => ready() && !!active())

    const check = (conn: ServerConnection.Any) => checkServerHealth(conn.http).then((x) => x.healthy)

    createEffect(() => {
      const current_ = current()
      if (!current_) return

      setState({
        healthy: undefined,
        checkedAt: Date.now(),
      })
      onCleanup(startHealthPolling(current_))
    })

    createEffect(() => {
      if (!ready()) return
      const next = active()
      if (store.active === next) return
      setStore("active", next)
    })

    const origin = createMemo(() => projectsKey(active()))
    const projectsList = createMemo(() => store.projects[origin()] ?? [])
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === active()) ?? allServers()[0],
    )
    const isLocal = createMemo(() => {
      const c = current()
      return (c?.type === "sidecar" && c.variant === "base") || (c?.type === "http" && isLocalHost(c.http.url))
    })

    return {
      ready: isReady,
      healthy,
      checkedAt,
      isLocal,
      get key() {
        return active()
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      upsert,
      remove,
      projects: {
        list: projectsList,
        open(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        expand(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
