import { expect, test } from "bun:test"
import { controlHandler } from "../src/control"
import { Aether } from "../src/aether"
import { Engine } from "../src/engine"
import { Store } from "../src/store"

test("headless control requires authentication, validates session identity and filters raw tools", async () => {
  const store = new Store(":memory:")
  let directory = "/fixture/work"
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/message")) return Response.json([
      { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "msg_reply", role: "assistant", parentID: "msg_user" }, parts: [
        { type: "text", text: "done" }, { type: "reasoning", text: "private reasoning" },
        { type: "tool", tool: "bash", state: { status: "completed", input: "secret input", output: "secret output" } },
      ] },
    ])
    return Response.json({ id: "ses_fixture", directory })
  } })
  store.save({ id: "ticket_fixture", title: "fixture", session: "ses_fixture", directory, state: "waiting", result: "done" })
  const engine = new Engine(store, new Aether(backend.url.origin), { repo: "/fixture", state: "/fixture/state", base: "HEAD", workers: 2 })
  const serve = controlHandler(engine, "fixture-token")
  const call = (route: string, headers: Record<string, string> = { Authorization: "Bearer fixture-token" }) => serve(new Request(`http://127.0.0.1:19700${route}`, { headers }))
  try {
    const root = await call("/", {})
    expect(root.headers.get("Content-Type")).toContain("application/json")
    expect(await root.json()).toMatchObject({ service: "aether-superagent" })
    expect((await call("/panel/state", {})).status).toBe(401)
    expect((await call("/panel/state", { Authorization: "Bearer fixture-token", Origin: "https://foreign.invalid" })).status).toBe(403)
    expect((await call("/panel/state", { Cookie: "aether_superagent=fixture-token" })).status).toBe(401)
    const state = await call("/panel/state").then((response) => response.json())
    expect(state.config.aether).toBe(backend.url.origin)
    expect(JSON.stringify(state)).not.toContain("fixture-token")
    expect(state.tokenPath).toBeUndefined()
    expect(await call("/tickets/ticket_fixture/open").then((response) => response.json())).toEqual({ directory, session: "ses_fixture" })
    expect((await call("/tickets/ticket_fixture/open?directory=/elsewhere")).status).toBe(400)
    const response = await call("/tickets/ticket_fixture/conversation")
    const history = await response.text()
    expect(history).toContain("bash · completed")
    expect(history).not.toContain("secret")
    expect(history).not.toContain("private reasoning")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    directory = "/other/backend"
    expect((await call("/tickets/ticket_fixture/open")).status).toBe(409)
    expect((await call("/tickets/ticket_fixture/conversation")).status).toBe(409)
    expect((await call("/tickets/missing/open")).status).toBe(404)
  } finally { backend.stop(true); store.db.close() }
})
