import { batch, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { base64Encode } from "@opencode-ai/util/encode"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import { isViewing } from "./global-sync/viewing"
import * as Status from "./global-sync/status"
import { useLanguage } from "./language"
import { formatServerError } from "@/utils/server-errors"
import { MessageOrder } from "@/utils/message-order"
import { waitSession } from "@/utils/session-pending"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const snapshot = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, JSON.stringify(item)]))

// A fetched page is authoritative except where the live store changed while
// it was in flight (including streamed text, new messages, and deletions).
function rebase<T extends { id: string }>(items: T[], before: Map<string, string>, current: T[]) {
  const next = new Map(items.map((item) => [item.id, item]))
  const ids = new Set(current.map((item) => item.id))
  for (const id of before.keys()) {
    if (!ids.has(id)) next.delete(id)
  }
  for (const item of current) {
    if (before.get(item.id) !== JSON.stringify(item)) next.set(item.id, item)
  }
  return [...next.values()]
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function scopeError(err: unknown) {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : ""
  return /project not registered|not registered|session not found|project not found|404/i.test(msg)
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const at = MessageOrder.index(session, item.message.id)
    const found = at >= 0
    if (!found) session.splice(MessageOrder.insert(session, item.message), 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    messages.splice(MessageOrder.insert(messages, input.message), 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const at = MessageOrder.index(messages, input.messageID)
    if (at >= 0) messages.splice(at, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const next = [...messages]
    next.splice(MessageOrder.insert(next, input.message), 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const at = MessageOrder.index(messages, input.messageID)
    if (at < 0) return messages
    const next = [...messages]
    next.splice(at, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export function invalidateSessionMessageCacheMeta(
  draft: {
    limit: Record<string, number>
    cursor: Record<string, string | undefined>
    complete: Record<string, boolean>
    loading: Record<string, boolean>
  },
  input: { directory: string; sessionID: string },
) {
  const key = keyFor(input.directory, input.sessionID)
  delete draft.limit[key]
  delete draft.cursor[key]
  delete draft.complete[key]
  delete draft.loading[key]
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()
    const navigate = useNavigate()
    const language = useLanguage()
    const downgraded = new Set<string>()
    let disposed = false
    onCleanup(() => (disposed = true))

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const current = createMemo(() => globalSync.child(sdk.directory))
    const target = (directory?: string) => {
      if (!directory || directory === sdk.directory) return current()
      return globalSync.child(directory)
    }
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const initialMessagePageSize = 80
    const historyMessagePageSize = 200
    const inflight = new Map<string, Promise<void>>()
    const loads = new Map<string, Promise<void>>()
    const revisions = new Map<string, number>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const optimistic = new Map<string, Map<string, OptimisticItem>>()
    const maxDirs = 30
    const seen = new Map<string, Set<string>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      cursor: {} as Record<string, string | undefined>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const downgrade = (directory: string, sessionID: string, err: unknown) => {
      if (!scopeError(err)) throw err
      const key = keyFor(directory, sessionID)
      if (!downgraded.has(key)) {
        downgraded.add(key)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
      }
      navigate(`/${base64Encode(directory)}/session`, { replace: true })
    }

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
      const key = keyFor(directory, sessionID)
      const list = optimistic.get(key)
      if (list) {
        list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
        return
      }
      optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
    }

    const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
      const key = keyFor(directory, sessionID)
      if (!messageID) {
        optimistic.delete(key)
        return
      }

      const list = optimistic.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.delete(key)
    }

    const getOptimistic = (directory: string, sessionID: string) => [
      ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
    ]

    const seenFor = (directory: string) => {
      const existing = seen.get(directory)
      if (existing) {
        seen.delete(directory)
        seen.set(directory, existing)
        return existing
      }
      const created = new Set<string>()
      seen.set(directory, created)
      while (seen.size > maxDirs) {
        const first = seen.keys().next().value
        if (!first) break
        const stale = [...(seen.get(first) ?? [])]
        seen.delete(first)
        const [, setStore] = globalSync.child(first, { bootstrap: false })
        evict(first, setStore, stale)
      }
      return created
    }

    const clearMeta = (directory: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      for (const sessionID of sessionIDs) {
        clearOptimistic(directory, sessionID)
      }
      setMeta(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            const key = keyFor(directory, sessionID)
            delete draft.limit[key]
            delete draft.cursor[key]
            delete draft.complete[key]
            delete draft.loading[key]
          }
        }),
      )
    }

    const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
      const ids = sessionIDs.filter((id) => !isViewing(id))
      if (ids.length === 0) return
      clearSessionPrefetch(directory, ids)
      for (const sessionID of ids) {
        globalSync.todo.set(sessionID, undefined)
      }
      setStore(
        produce((draft) => {
          dropSessionCaches(draft, ids)
        }),
      )
      clearMeta(directory, ids)
    }

    const touch = (directory: string, setStore: Setter, sessionID: string) => {
      const stale = pickSessionCacheEvictions({
        seen: seenFor(directory),
        keep: sessionID,
        limit: SESSION_CACHE_LIMIT,
      })
      evict(directory, setStore, stale)
    }

    const fetchMessages = async (input: {
      client: typeof sdk.client
      sessionID: string
      limit: number
      before?: string
    }) => {
      const messages = await retry(() =>
        input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
      )
      const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
      const session = MessageOrder.sort(items.map((x) => x.info))
      const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
      const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
      return {
        session,
        part,
        cursor,
        complete: !cursor,
      }
    }

    const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
      before?: string
      mode?: "replace" | "prepend"
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      return runInflight(loads, key, async () => {
        if (meta.loading[key]) return
        const server = sdk.url
        const revision = revisions.get(key)
        const [store] = globalSync.child(input.directory, { bootstrap: false })
        const messages = snapshot(store.message[input.sessionID] ?? [])
        const parts = new Map(
          (store.message[input.sessionID] ?? []).map((item) => [item.id, snapshot(store.part[item.id] ?? [])]),
        )
        const valid = () =>
          !disposed &&
          sdk.url === server &&
          revision === revisions.get(key) &&
          tracked(input.directory, input.sessionID)
        setMeta("loading", key, true)
        await fetchMessages(input)
          .then(async (page) => {
            if (!valid()) return
            const [store] = globalSync.child(input.directory, { bootstrap: false })
            const revert = store.session.find((item) => item.id === input.sessionID)?.revert?.messageID
            const known = store.message[input.sessionID]?.some((item) => item.id === revert)
            if (revert && !known && !page.session.some((item) => item.id === revert)) {
              const result = await input.client.session
                .message({ sessionID: input.sessionID, messageID: revert })
                .catch(() => undefined)
              const item = result?.data
              if (item?.info?.id) {
                page.session = MessageOrder.sort([...page.session, item.info])
                page.part.push({ id: item.info.id, part: sortParts(item.parts) })
              }
            }
            return page
          })
          .then((page) => {
            if (!page) return
            if (!valid()) return
            const next = mergeOptimisticPage(page, getOptimistic(input.directory, input.sessionID))
            for (const messageID of next.confirmed) {
              clearOptimistic(input.directory, input.sessionID, messageID)
            }
            const [store] = globalSync.child(input.directory, { bootstrap: false })
            const cached = input.mode === "prepend" ? (store.message[input.sessionID] ?? []) : []
            const message = MessageOrder.sort(
              rebase(
                input.mode === "prepend" ? MessageOrder.merge(cached, next.session) : next.session,
                messages,
                store.message[input.sessionID] ?? [],
              ),
            )
            batch(() => {
              input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
              for (const p of next.part) {
                if (!message.some((item) => item.id === p.id)) continue
                const filtered = rebase(p.part, parts.get(p.id) ?? new Map(), store.part[p.id] ?? []).filter(
                  (x) => !SKIP_PARTS.has(x.type),
                )
                input.setStore("part", p.id, sortParts(filtered))
              }
              setMeta("limit", key, message.length)
              setMeta("cursor", key, next.cursor)
              setMeta("complete", key, next.complete)
              setSessionPrefetch({
                directory: input.directory,
                sessionID: input.sessionID,
                limit: message.length,
                cursor: next.cursor,
                complete: next.complete,
              })
            })
          })
          .finally(() => {
            setMeta(
              produce((draft) => {
                if (!tracked(input.directory, input.sessionID)) {
                  delete draft.loading[key]
                  return
                }
                draft.loading[key] = false
              }),
            )
          })
      })
    }

    const api = {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        return globalSync.project.get(store.project)
      },
      session: {
        get: getSession,
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            setOptimistic(directory, input.sessionID, { message: input.message, parts: input.parts })
            setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            clearOptimistic(directory, input.sessionID, input.messageID)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
          },
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
          variant?: string
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
            variant: input.variant,
          }
          const [, setStore] = target()
          setOptimistic(sdk.directory, input.sessionID, { message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const server = sdk.url
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)

          if (!(await waitSession(sessionID))) return
          if (opts?.force) await Promise.allSettled([inflight.get(key), loads.get(key)])
          if (disposed || sdk.url !== server) return

          touch(directory, setStore, sessionID)

          const seeded = getSessionPrefetch(directory, sessionID)
          if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
            batch(() => {
              setMeta("limit", key, seeded.limit)
              setMeta("cursor", key, seeded.cursor)
              setMeta("complete", key, seeded.complete)
              setMeta("loading", key, false)
            })
          }

          return runInflight(inflight, key, async () => {
            const pending = getSessionPrefetchPromise(directory, sessionID)
            if (pending) {
              await pending
              const seeded = getSessionPrefetch(directory, sessionID)
              if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
                batch(() => {
                  setMeta("limit", key, seeded.limit)
                  setMeta("cursor", key, seeded.cursor)
                  setMeta("complete", key, seeded.complete)
                  setMeta("loading", key, false)
                })
              }
            }

            const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
            const cached = store.message[sessionID] !== undefined && meta.limit[key] !== undefined
            if (cached && hasSession && !opts?.force) return

            const revision = revisions.get(key)
            const valid = () =>
              !disposed && sdk.url === server && revision === revisions.get(key) && tracked(directory, sessionID)
            const limit = Math.max(meta.limit[key] ?? initialMessagePageSize, store.message[sessionID]?.length ?? 0)
            const sessionReq =
              hasSession && !opts?.force
                ? Promise.resolve()
                : retry(() => client.session.get({ sessionID })).then((session) => {
                    if (!valid()) return
                    const data = session.data
                    if (!data) return
                    setStore(
                      "session",
                      produce((draft) => {
                        const match = Binary.search(draft, sessionID, (s) => s.id)
                        if (match.found) {
                          if (draft[match.index].time.updated > data.time.updated) return
                          draft[match.index] = data
                          return
                        }
                        draft.splice(match.index, 0, data)
                      }),
                    )
                  })

            const messagesReq =
              cached && !opts?.force
                ? Promise.resolve()
                : loadMessages({
                    directory,
                    client,
                    setStore,
                    sessionID,
                    limit,
                  })

            const status = Status.capture(store)
            const statusReq = !opts?.force
              ? Promise.resolve()
              : retry(() => client.session.status()).then((response) => {
                  if (!valid()) return
                  const next = {
                    ...response.data,
                    [sessionID]: response.data?.[sessionID] ?? { type: "idle" as const },
                  }
                  setStore("session_status", reconcile(Status.rebase(next, status, store)))
                })
            await Promise.all([sessionReq, messagesReq, statusReq]).catch((err) => {
              if (disposed || sdk.url !== server || sdk.directory !== directory) return
              downgrade(directory, sessionID, err)
            })
          })
        },
        async diff(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (!(await waitSession(sessionID))) return
          touch(directory, setStore, sessionID)
          if (store.session_diff[sessionID] !== undefined && !opts?.force) return

          const key = keyFor(directory, sessionID)
          return runInflight(inflightDiff, key, () =>
            retry(() => client.session.diff({ sessionID }))
              .then((diff) => {
                if (!tracked(directory, sessionID)) return
                setStore("session_diff", sessionID, [...(Array.isArray(diff.data) ? diff.data : [])])
              })
              .catch((err) => downgrade(directory, sessionID, err)),
          )
        },
        async todo(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (!(await waitSession(sessionID))) return
          touch(directory, setStore, sessionID)
          const existing = store.todo[sessionID]
          const cached = globalSync.data.session_todo[sessionID]
          if (existing !== undefined) {
            if (cached === undefined) {
              globalSync.todo.set(sessionID, existing)
            }
            if (!opts?.force) return
          }

          if (cached !== undefined) {
            setStore("todo", sessionID, reconcile(cached))
          }

          const key = keyFor(directory, sessionID)
          return runInflight(inflightTodo, key, () =>
            retry(() => client.session.todo({ sessionID }))
              .then((todo) => {
                if (!tracked(directory, sessionID)) return
                const list = todo.data ?? []
                setStore("todo", sessionID, reconcile(list))
                globalSync.todo.set(sessionID, list)
              })
              .catch((err) => downgrade(directory, sessionID, err)),
          )
        },
        paged(sessionID: string) {
          return meta.limit[keyFor(sdk.directory, sessionID)] !== undefined
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return !!meta.cursor[key]
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count?: number) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            touch(directory, setStore, sessionID)
            const key = keyFor(directory, sessionID)
            const step = count ?? historyMessagePageSize
            if (meta.loading[key]) return
            if (meta.complete[key]) return
            const before = meta.cursor[key]
            if (!before) return

            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: step,
              before,
              mode: "prepend",
            }).catch((err) => downgrade(directory, sessionID, err))
          },
        },
        invalidate(sessionID: string, directory = sdk.directory) {
          clearSessionPrefetch(directory, [sessionID])
          clearOptimistic(directory, sessionID)
          setMeta(
            produce((draft) => {
              invalidateSessionMessageCacheMeta(draft, { directory, sessionID })
            }),
          )
        },
        evict(sessionID: string, directory = sdk.directory) {
          const [, setStore] = globalSync.child(directory)
          seenFor(directory).delete(sessionID)
          evict(directory, setStore, [sessionID])
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        archive: async (sessionID: string) => {
          await sdk.client.session.archive({ sessionID })
        },
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
    // A connection delivers no replay. Refresh viewed sessions even when an
    // older HTTP request started before the connection was established.
    onCleanup(
      globalSync.onReconnect(() => {
        const directory = sdk.directory
        const server = sdk.url
        for (const [directory, sessions] of seen) {
          clearSessionPrefetch(directory, sessions)
          for (const sessionID of sessions) {
            const key = keyFor(directory, sessionID)
            revisions.set(key, (revisions.get(key) ?? 0) + 1)
          }
          setMeta(
            produce((draft) => {
              for (const sessionID of sessions) invalidateSessionMessageCacheMeta(draft, { directory, sessionID })
            }),
          )
        }
        for (const sessionID of seen.get(directory) ?? []) {
          if (!isViewing(sessionID)) continue
          const key = keyFor(directory, sessionID)
          void Promise.allSettled([inflight.get(key), loads.get(key)])
            .then(() => {
              if (disposed || sdk.url !== server || sdk.directory !== directory || !isViewing(sessionID)) return
              return api.session.sync(sessionID, { force: true })
            })
            .catch((error: unknown) => console.error("Failed to recover session after reconnect", error))
        }
      }),
    )
    return api
  },
})
