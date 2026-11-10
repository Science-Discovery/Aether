import { Engine } from "./engine"

function string(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string.`)
  return value
}

export function handler(engine: Engine, token: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true })
    if (request.headers.get("Authorization") !== `Bearer ${token}`) return Response.json({ error: "Unauthorized" }, { status: 401 })
    try {
      if (request.method === "GET") {
        if (url.pathname === "/tickets") return Response.json(engine.store.tickets())
        if (url.pathname === "/inputs") return Response.json(engine.store.inputs())
        const match = url.pathname.match(/^\/(tickets|inputs)\/([^/]+)$/)
        if (match) {
          const value = match[1] === "tickets" ? engine.store.ticket(match[2]!) : engine.store.input(match[2]!)
          return Response.json(value ?? { error: "Not found" }, { status: value ? 200 : 404 })
        }
      }
      if (request.method === "POST") {
        const body = await request.json() as Record<string, unknown>
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.")
        if (url.pathname === "/requests" || url.pathname === "/tickets") {
          const value = engine.submit(string(body.key, "key"), string(body.text, "text"), undefined,
            url.pathname === "/tickets" ? string(body.title, "title").slice(0, 200) : undefined,
            body.focus === undefined ? undefined : string(body.focus, "focus"))
          engine.tick()
          return Response.json(value, { status: 202 })
        }
        const match = url.pathname.match(/^\/tickets\/([^/]+)\/(messages|stop)$/)
        if (match) {
          if (match[2] === "stop") return Response.json(await engine.stop(match[1]!))
          const value = engine.submit(string(body.key, "key"), string(body.text, "text"), match[1])
          engine.tick()
          return Response.json(value, { status: 202 })
        }
        const input = url.pathname.match(/^\/inputs\/([^/]+)\/(reconcile|dismiss)$/)
        if (input) {
          if (input[2] === "dismiss" && body.confirm !== true) throw new Error("Dismiss requires confirm:true after checking the Aether session.")
          return Response.json(input[2] === "reconcile" ? await engine.reconcile(input[1]!) : await engine.dismiss(input[1]!))
        }
      }
      return Response.json({ error: "Not found" }, { status: 404 })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
    }
  }
}
