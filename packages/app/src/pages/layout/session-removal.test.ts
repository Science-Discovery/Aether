import { afterEach, describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import {
  clearSessionPrefetchDirectory,
  getSessionPrefetch,
  setSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import type { State } from "@/context/global-sync/types"
import { remove } from "./session-removal"

const session = (id: string, parentID?: string) =>
  ({ id, parentID, directory: "/project", title: id, time: { created: 1, updated: 1 } }) as Session

function fixture() {
  const rows = [session("a"), session("b", "a"), session("c", "b"), session("z")]
  const [store, set] = createStore({
    session: rows,
    sessionTotal: 2,
    message: Object.fromEntries(rows.map((row) => [row.id, [{ id: `msg_${row.id}`, sessionID: row.id } as Message]])),
    part: Object.fromEntries(rows.map((row) => [row.id, [{ id: row.id, sessionID: row.id, type: "text" } as Part]])),
    session_status: { b: { type: "idle" }, c: { type: "idle" } },
    session_diff: { b: [], c: [] },
    todo: { b: [], c: [] },
    permission: {},
    question: {},
    preference: { b: { sessionID: "b" }, c: { sessionID: "c" } },
  } as unknown as State)
  const calls = { navigate: [] as (string | undefined)[], todo: [] as string[] }
  return {
    store,
    set,
    calls,
    session: rows[1],
    current: () => "b",
    send: async () => {},
    navigate: (id?: string) => calls.navigate.push(id),
    todo: (id: string) => calls.todo.push(id),
  }
}

afterEach(() => clearSessionPrefetchDirectory("/project"))

describe("branch removal", () => {
  test("waits for success, clears the whole subtree, and returns to its surviving parent", async () => {
    const data = fixture()
    const response = Promise.withResolvers<void>()
    setSessionPrefetch({ directory: "/project", sessionID: "c", limit: 10, complete: true })
    const pending = remove({ ...data, send: () => response.promise })
    expect(data.store.session.map((row) => row.id)).toEqual(["a", "b", "c", "z"])
    expect(data.calls.navigate).toEqual([])
    response.resolve()
    await pending
    expect(data.store.session.map((row) => row.id)).toEqual(["a", "z"])
    expect(data.calls.navigate).toEqual(["a"])
    expect(data.calls.todo.sort()).toEqual(["b", "c"])
    expect(data.store.message.b).toBeUndefined()
    expect(data.store.message.c).toBeUndefined()
    expect(data.store.message.a).toBeDefined()
    expect(data.store.part.b).toBeUndefined()
    expect(data.store.part.c).toBeUndefined()
    expect(data.store.part.z).toBeDefined()
    expect(data.store.session_status.c).toBeUndefined()
    expect(data.store.preference.c).toBeUndefined()
    expect(getSessionPrefetch("/project", "c")).toBeUndefined()
  })

  test("also navigates away when the current session is a deleted descendant", async () => {
    const data = fixture()
    await remove({ ...data, current: () => "c" })
    expect(data.calls.navigate).toEqual(["a"])
  })

  test("deleting the root never chooses a descendant as the next session", async () => {
    const data = fixture()
    await remove({ ...data, session: data.store.session[0], current: () => "a" })
    expect(data.store.session.map((row) => row.id)).toEqual(["z"])
    expect(data.calls.navigate).toEqual(["z"])
  })

  test("opens a new session if no active survivor remains", async () => {
    const data = fixture()
    data.set("session", (rows) => rows.filter((row) => row.id !== "z"))
    await remove({ ...data, session: data.store.session[0], current: () => "a" })
    expect(data.calls.navigate).toEqual([undefined])
  })

  test("a failed delete retains metadata, message caches, prefetch, and navigation", async () => {
    const data = fixture()
    setSessionPrefetch({ directory: "/project", sessionID: "c", limit: 10, complete: true })
    await expect(
      remove({
        ...data,
        send: async () => {
          throw new Error("delete failed")
        },
      }),
    ).rejects.toThrow("delete failed")
    expect(data.store.session.map((row) => row.id)).toEqual(["a", "b", "c", "z"])
    expect(data.store.message.c).toBeDefined()
    expect(getSessionPrefetch("/project", "c")).toBeDefined()
    expect(data.calls.navigate).toEqual([])
    expect(data.calls.todo).toEqual([])
  })

  test("keeps the user's new destination if they navigate while deletion is pending", async () => {
    const data = fixture()
    const response = Promise.withResolvers<void>()
    let current = "b"
    const pending = remove({ ...data, current: () => current, send: () => response.promise })
    current = "z"
    response.resolve()
    await pending
    expect(data.calls.navigate).toEqual([])
  })

  test("retains the captured subtree if deletion events remove metadata before the response", async () => {
    const data = fixture()
    const response = Promise.withResolvers<void>()
    const pending = remove({ ...data, current: () => "c", send: () => response.promise })
    data.set("session", (rows) => rows.filter((row) => row.id === "a" || row.id === "z"))
    response.resolve()
    await pending
    expect(data.calls.navigate).toEqual(["a"])
    expect(data.store.message.c).toBeUndefined()
  })

  test("spares a descendant already detached while deletion waits on the server", async () => {
    const data = fixture()
    const response = Promise.withResolvers<void>()
    const pending = remove({ ...data, current: () => "c", send: () => response.promise })
    data.set("session", 2, { parentID: undefined, treeID: "independent", time: { created: 1, updated: 2 } })
    response.resolve()
    await pending
    expect(data.store.session.map((row) => row.id)).toEqual(["a", "c", "z"])
    expect(data.store.message.c).toBeDefined()
    expect(data.calls.navigate).toEqual([])
  })
})
