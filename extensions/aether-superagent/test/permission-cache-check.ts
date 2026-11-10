// Run separately: bun test/permission-cache-check.ts
// Module mocks live only in this process, never in the normal bun test suite.
import assert from "node:assert/strict"
import { mock } from "bun:test"

type Preference = { sessionID: string; mode?: "full" | "off" | "safe"; autoAccept?: boolean }
type Task = { session: string; directory: string; available: boolean; managed: boolean; trusted: boolean }
type Event = { details: { type: string } }
type Child = { preference: Record<string, Preference | undefined> }
const full = (): Preference => ({ sessionID: "ses_a", mode: "full", autoAccept: true })
const off = (): Preference => ({ sessionID: "ses_a", mode: "off", autoAccept: false })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for cache hook")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
function fixture() {
  const f = {
    valid: true, mounts: [] as (() => void)[], cleanups: [] as (() => void)[],
    listeners: new Set<(event: Event) => void>(), reconnects: new Set<() => void>(),
    tasks: [{ session: "ses_a", directory: "/worker/a", available: true, managed: true, trusted: true }] as Task[],
    prefs: new Map<string, Preference | null>([["ses_a", full()]]), children: new Map<string, Child>(),
    writes: [] as { session: string; value: Preference | undefined }[], gets: 0, lists: 0,
    read: undefined as ((session: string) => Promise<{ data: Preference | null }>) | undefined,
    list: undefined as (() => Promise<{ tickets: Task[] }>) | undefined,
  }
  const sdk = {
    event: { listen(fn: (event: Event) => void) { f.listeners.add(fn); return () => { f.listeners.delete(fn) } } },
    createClient({ directory }: { directory: string }) {
      assert(f.tasks.some((task) => task.directory === directory), "only coordinator-provided directories may be read")
      return { session: { preference: { async get({ sessionID }: { sessionID: string }) {
        f.gets++
        return f.read ? f.read(sessionID) : { data: structuredClone(f.prefs.get(sessionID) ?? null) }
      } } } }
    },
  }
  const sync = {
    child(directory: string, options: { bootstrap: boolean }) {
      assert.equal(options.bootstrap, false)
      let child = f.children.get(directory)
      if (!child) { child = { preference: {} }; f.children.set(directory, child) }
      return [child, (field: string, session: string, value: Preference | undefined) => {
        assert.equal(field, "preference")
        child.preference[session] = value
        f.writes.push({ session, value: structuredClone(value) })
      }] as const
    },
    onReconnect(fn: () => void) { f.reconnects.add(fn); return () => { f.reconnects.delete(fn) } },
  }
  const client = { valid: () => f.valid, async request(route: string) {
    assert.equal(route, "/native/permissions"); f.lists++
    return f.list ? f.list() : { tickets: structuredClone(f.tasks) }
  } }
  return { ...f, state: f, sdk, sync, client }
}
type Fixture = ReturnType<typeof fixture>
let current: Fixture
mock.module("solid-js", () => ({
  onMount: (fn: () => void) => current.state.mounts.push(fn),
  onCleanup: (fn: () => void) => current.state.cleanups.push(fn),
}))
mock.module("solid-js/store", () => ({ reconcile: (value: unknown) => value }))
mock.module("@/context/global-sdk", () => ({ useGlobalSDK: () => current.sdk }))
mock.module("@/context/global-sync", () => ({ useGlobalSync: () => current.sync }))
mock.module(new URL("../integration/app/client.ts", import.meta.url).pathname, () => ({ createSuperagentClient: () => current.client }))
// Variable import deliberately avoids pulling app-only TS aliases into the module's typecheck.
const source = new URL("../integration/app/permission-cache.ts", import.meta.url).href
const { useTaskPermissionCache } = await import(source) as {
  useTaskPermissionCache(bootstrap?: boolean): { begin(task: Pick<Task, "session" | "directory">): () => void }
}
let passed = 0
async function check(name: string, run: (f: Fixture) => Promise<void>) {
  current = fixture()
  try { await run(current); passed++; console.log(`PASS ${name}`) }
  finally { current.state.valid = false; for (const cleanup of current.state.cleanups.toReversed()) cleanup() }
}
function mount() { for (const fn of current.state.mounts.splice(0)) fn() }
function preference(f: Fixture) { return f.state.children.get("/worker/a")?.preference.ses_a }
function reconnect(f: Fixture) { for (const fn of f.state.reconnects) fn() }

await check("late HTTP full cannot overwrite newer off SSE; invalidated bootstrap retries", async (f) => {
  const gate = deferred<{ data: Preference | null }>()
  f.state.read = async () => { f.state.read = undefined; return gate.promise }
  useTaskPermissionCache(true); mount(); await until(() => f.state.gets === 1)
  f.state.children.get("/worker/a")!.preference.ses_a = off()
  f.state.prefs.set("ses_a", off()); f.state.tasks[0]!.managed = false; f.state.tasks[0]!.trusted = false
  for (const fn of f.state.listeners) fn({ details: { type: "session.preference.updated" } })
  gate.resolve({ data: full() })
  await until(() => f.state.gets >= 2 && f.state.writes.length > 0)
  assert.equal(preference(f)?.mode, "off")
  assert(!f.state.writes.some((write) => write.value?.mode === "full"))
})

await check("reconnect corrects revoked unmanaged task after missed off SSE", async (f) => {
  useTaskPermissionCache(true); mount(); await until(() => preference(f)?.mode === "full")
  f.state.tasks[0]!.managed = false; f.state.tasks[0]!.trusted = false; f.state.prefs.set("ses_a", off())
  reconnect(f); await until(() => preference(f)?.mode === "off")
  assert.equal(preference(f)?.autoAccept, false)
})

await check("null native preference clears stale full cache after backend restart", async (f) => {
  useTaskPermissionCache(true); mount(); await until(() => preference(f)?.mode === "full")
  f.state.prefs.set("ses_a", null); f.state.tasks[0]!.trusted = false
  reconnect(f); await until(() => f.state.writes.length === 2)
  assert.equal(preference(f), undefined)
})

await check("unconfirmed managed full is held off without touching another session", async (f) => {
  f.state.tasks[0]!.trusted = false
  f.state.children.set("/worker/a", { preference: { ses_a: full(), ses_unrelated: { sessionID: "ses_unrelated", mode: "safe" } } })
  useTaskPermissionCache(true); mount(); await until(() => f.state.writes.length === 1)
  assert.equal(preference(f)?.mode, "off"); assert.equal(preference(f)?.autoAccept, false)
  assert.equal(f.state.children.get("/worker/a")!.preference.ses_unrelated?.mode, "safe")
  assert.deepEqual(f.state.writes.map((write) => write.session), ["ses_a"])
})

await check("external unmanaged full is neither adopted nor overwritten", async (f) => {
  f.state.tasks[0]!.managed = false; f.state.tasks[0]!.trusted = false
  f.state.children.set("/worker/a", { preference: { ses_a: full() } })
  useTaskPermissionCache(true); mount(); await until(() => f.state.gets === 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.state.writes.length, 0); assert.equal(preference(f)?.mode, "full")
})

await check("backend switch invalidates pending HTTP response", async (f) => {
  const gate = deferred<{ data: Preference | null }>()
  f.state.read = () => gate.promise
  useTaskPermissionCache(true); mount(); await until(() => f.state.gets === 1)
  f.state.valid = false; gate.resolve({ data: full() })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.state.writes.length, 0)
})

await check("begin invalidates old response and finish wakes bootstrap without an SSE event", async (f) => {
  const gate = deferred<{ data: Preference | null }>()
  f.state.read = async () => { f.state.read = undefined; return gate.promise }
  useTaskPermissionCache(true); const dialog = useTaskPermissionCache()
  mount(); await until(() => f.state.gets === 1)
  const finish = dialog.begin(f.state.tasks[0]!)
  f.state.prefs.set("ses_a", off()); f.state.tasks[0]!.managed = false; f.state.tasks[0]!.trusted = false
  gate.resolve({ data: full() })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.state.writes.length, 0)
  finish(); finish() // Idempotent finalization must not make changing negative.
  await until(() => preference(f)?.mode === "off")
  assert(!f.state.writes.some((write) => write.value?.mode === "full"))
})

await check("finish refreshes an already-settled bootstrap when revoke SSE is missing", async (f) => {
  useTaskPermissionCache(true); const dialog = useTaskPermissionCache()
  mount(); await until(() => preference(f)?.mode === "full")
  const initialReads = f.state.gets
  const finish = dialog.begin(f.state.tasks[0]!)
  f.state.prefs.set("ses_a", off()); f.state.tasks[0]!.managed = false; f.state.tasks[0]!.trusted = false
  finish()
  await until(() => preference(f)?.mode === "off")
  assert.equal(f.state.gets, initialReads + 1)
})

await check("cleanup removes listeners and prevents late cache writes", async (f) => {
  const gate = deferred<{ data: Preference | null }>()
  f.state.read = () => gate.promise
  useTaskPermissionCache(true); mount(); await until(() => f.state.gets === 1)
  f.state.valid = false
  for (const cleanup of f.state.cleanups.splice(0).toReversed()) cleanup()
  gate.resolve({ data: full() })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.state.listeners.size, 0); assert.equal(f.state.reconnects.size, 0)
  assert.equal(f.state.writes.length, 0)
})
console.log(`${passed} permission-cache checks passed (isolated process).`)
