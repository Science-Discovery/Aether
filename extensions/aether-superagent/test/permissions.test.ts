import { expect, test } from "bun:test"
import { Aether } from "../src/aether"
import { Engine } from "../src/engine"
import { Store } from "../src/store"
import { TaskPermissions } from "../src/permissions"

function fixture() {
  const store = new Store(":memory:")
  store.save({ id: "ticket", title: "Task", directory: "/work", session: "ses_work", state: "running", result: "" })
  const state = { rules: [] as { permission: string; pattern: string; action: string }[], mode: undefined as string | undefined,
    directory: "/work", busy: true, aborts: 0, patches: [] as string[], replies: [] as { id: string; reply: string }[], fail: false, pendingReads: 0, onPending: undefined as (() => void) | undefined, onPatch: undefined as (() => void) | undefined,
    pending: [{ id: "ask1", sessionID: "ses_work", permission: "external_read", patterns: ["/data/a"] },
      { id: "other", sessionID: "ses_other", permission: "external_read", patterns: ["/data/a"] }] }
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/permission") { state.pendingReads++; state.onPending?.(); return Response.json(state.pending) }
    if (path.startsWith("/permission/")) {
      const body = await request.json() as { reply: string }
      const id = path.split("/")[2]!
      state.replies.push({ id, reply: body.reply }); state.pending = state.pending.filter((item) => item.id !== id)
      return Response.json(true)
    }
    if (path === "/session/status") return Response.json({ ses_work: { type: state.busy ? "busy" : "idle" } })
    if (path.endsWith("/abort")) { state.aborts++; state.busy = false; return Response.json(true) }
    if (path.endsWith("/preference")) {
      if (request.method === "PATCH") {
        const body = await request.json() as { mode: string }
        state.patches.push(body.mode); state.mode = body.mode
        state.onPatch?.()
        state.rules = body.mode === "full" ? [{ permission: "*", pattern: "*", action: "allow" }] : []
        if (state.fail) { state.fail = false; return Response.json({ error: "lost response" }, { status: 503 }) }
      }
      return Response.json(state.mode ? { mode: state.mode } : null)
    }
    return Response.json({ id: "ses_work", directory: state.directory, permission: state.rules })
  } })
  const engine = new Engine(store, new Aether(backend.url.origin), { repo: "/repo", state: "/state", base: "HEAD", workers: 1 })
  const permissions = new TaskPermissions(engine)
  return { state, store, permissions, engine, close() { backend.stop(true); store.db.close() } }
}

test("task grant is explicit, pending approvals scoped, cached active turn stopped on revoke", async () => {
  const f = fixture()
  try {
    await expect(f.permissions.trust("ticket", true, false)).rejects.toThrow("明确确认")
    await expect(f.permissions.reply("ticket", "other", "once")).rejects.toThrow("不属于")
    await expect(f.permissions.reply("ticket", "ask1", "always")).rejects.toThrow("仅支持")
    expect((await f.permissions.trust("ticket", true, true)).trusted).toBe(true)
    expect(f.state.replies).toEqual([{ id: "ask1", reply: "once" }])
    f.state.pending.push({ id: "ask2", sessionID: "ses_work", permission: "bash", patterns: ["ls /data"] })
    await f.permissions.tick()
    expect(f.state.replies.at(-1)?.id).toBe("ask2")
    expect(() => f.permissions.assertUninstallable()).toThrow("撤销")
    expect((await f.permissions.trust("ticket", false, true)).trusted).toBe(false)
    expect(f.state.aborts).toBe(1)
    expect(f.state.patches).toEqual(["full", "off"])
    expect(f.state.pending.map((x) => x.id)).toEqual(["other"])
    f.permissions.assertUninstallable()
  } finally { f.close() }
})

test("unknown remote response is recovered by readback, restart preserves grant and does not replay", async () => {
  const f = fixture()
  try {
    f.state.fail = true
    await expect(f.permissions.trust("ticket", true, true)).rejects.toThrow("503")
    const restarted = new TaskPermissions(f.engine)
    expect((await restarted.list()).tickets[0]?.trusted).toBe(true)
    await restarted.trust("ticket", true, true)
    expect(f.state.patches).toEqual(["full"])
    f.state.mode = undefined // Backend preference map is ephemeral; full rules persist.
    await restarted.trust("ticket", false, true)
    expect(f.state.rules).toEqual([])
  } finally { f.close() }
})

test("custom policy and external drift are never overwritten, disabled permits revoke only", async () => {
  const f = fixture()
  try {
    f.state.mode = "safe"
    await expect(f.permissions.trust("ticket", true, true)).rejects.toThrow("默认逐项")
    f.state.mode = undefined
    await f.permissions.trust("ticket", true, true)
    f.state.rules = [{ permission: "bash", pattern: "*", action: "deny" }]
    await expect(f.permissions.trust("ticket", false, true)).rejects.toThrow("手动修改")
    await f.permissions.tick()
    expect(f.state.patches).toEqual(["full"])
    f.state.rules = []; f.state.mode = "off"
    await f.permissions.trust("ticket", false, true)
    f.store.setting("native:settings", JSON.stringify({ enabled: false }))
    await expect(f.permissions.trust("ticket", true, true)).rejects.toThrow("不能新增")
    expect(f.state.patches).toEqual(["full"])
  } finally { f.close() }
})

test("session mismatch blocks reads and grants; concurrent grant only sends one PATCH", async () => {
  const f = fixture()
  try {
    f.state.directory = "/other"
    expect((await f.permissions.list()).tickets[0]?.available).toBe(false)
    await expect(f.permissions.trust("ticket", true, true)).rejects.toThrow("身份")
    f.state.directory = "/work"
    await Promise.all([f.permissions.trust("ticket", true, true), f.permissions.trust("ticket", true, true)])
    expect(f.state.patches).toEqual(["full"])
  } finally { f.close() }
})

test("granting and revoking journal pause new engine claims until settled", async () => {
  const f = fixture()
  try {
    const input = { id: "input", key: "key", text: "continue", mode: "work" as const, ticket: "ticket", message: "msg_input", state: "pending" as const, result: "" }
    f.store.put(input)
    let claims = 0
    f.engine.run = async () => { claims++ }
    for (const phase of ["granting", "revoking"]) {
      f.store.setting("permission:task:ticket", JSON.stringify({ session: "ses_work", directory: "/work", phase, rules: [] }))
      f.engine.tick()
      expect(f.store.input(input.id)?.state).toBe("pending")
      expect(claims).toBe(0)
    }
    f.store.setting("permission:task:ticket", JSON.stringify({ session: "ses_work", directory: "/work", phase: "revoked", rules: [] }))
    f.engine.tick()
    expect(claims).toBe(1)
    await Promise.all(f.engine.active.values())
  } finally { f.close() }
})


test("once rechecks stopped after pending read; reject and disabled approval remain available", async () => {
  const f = fixture()
  try {
    f.state.onPending = () => f.store.save({ ...f.store.ticket("ticket")!, state: "stopped" })
    await expect(f.permissions.reply("ticket", "ask1", "once")).rejects.toThrow("已停止")
    expect(f.state.replies).toEqual([])
    f.state.onPending = undefined
    await f.permissions.reply("ticket", "ask1", "reject")
    expect(f.state.replies).toEqual([{ id: "ask1", reply: "reject" }])
    f.store.save({ ...f.store.ticket("ticket")!, state: "running" })
    f.state.pending.push({ id: "ask2", sessionID: "ses_work", permission: "bash", patterns: ["ls"] })
    f.engine.closed = true
    await expect(f.permissions.reply("ticket", "ask2", "once")).rejects.toThrow("已停止")
    f.engine.closed = false
    f.store.setting("native:settings", JSON.stringify({ enabled: false }))
    await f.permissions.reply("ticket", "ask2", "once")
    expect(f.state.replies.at(-1)).toEqual({ id: "ask2", reply: "once" })
  } finally { f.close() }
})


test("grant response lost after commit is settled by polling without replay or permanent dispatch pause", async () => {
  const f = fixture()
  try {
    f.state.fail = true
    await expect(f.permissions.trust("ticket", true, true)).rejects.toThrow("503")
    await f.permissions.tick()
    expect(JSON.parse(f.store.setting("permission:task:ticket")!).phase).toBe("trusted")
    expect(f.state.patches).toEqual(["full"])
  } finally { f.close() }
})

test("malformed journal isolates its task without breaking list or periodic polling", async () => {
  const f = fixture()
  try {
    f.store.setting("permission:task:ticket", "{broken")
    const result = await f.permissions.list()
    expect(result.tickets).toHaveLength(1)
    expect(result.tickets[0]).toMatchObject({ available: false, managed: true, trusted: false })
    await f.permissions.tick()
    expect(f.state.replies).toEqual([])
  } finally { f.close() }
})

test("stop while grant PATCH is in flight restores original policy and never approves a pending action", async () => {
  const f = fixture()
  try {
    f.state.onPatch = () => f.store.save({ ...f.store.ticket("ticket")!, state: "stopped" })
    await expect(f.permissions.trust("ticket", true, true)).rejects.toThrow("停止")
    expect(f.state.rules).toEqual([])
    expect(f.state.replies).toEqual([])
    expect(JSON.parse(f.store.setting("permission:task:ticket")!).phase).toBe("revoked")
  } finally { f.close() }
})


test("unconfirmed grants never approve pending actions; revoking polling does not query pending", async () => {
  const f = fixture()
  try {
    for (const phase of ["granting", "revoking"]) {
      f.store.setting("permission:task:ticket", JSON.stringify({ session: "ses_work", directory: "/work", phase, rules: [] }))
      await f.permissions.tick()
      expect(f.state.replies).toEqual([])
      expect(f.state.pendingReads).toBe(0)
      expect(f.state.patches).toEqual([])
      expect(JSON.parse(f.store.setting("permission:task:ticket")!).phase).toBe(phase)
    }
  } finally { f.close() }
})

test("stop and a lost grant response do not leave automatic permissions behind", async () => {
  const f = fixture()
  try {
    f.state.fail = true
    f.state.onPatch = () => f.store.save({ ...f.store.ticket("ticket")!, state: "stopped" })
    await expect(f.permissions.trust("ticket", true, true)).rejects.toThrow("503")
    expect(f.state.rules).toEqual([])
    expect(f.state.replies).toEqual([])
    expect(JSON.parse(f.store.setting("permission:task:ticket")!).phase).toBe("revoked")
  } finally { f.close() }
})
