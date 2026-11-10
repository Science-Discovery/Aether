import { TaskPermissions } from "./permissions"
import { Engine } from "./engine"
import { Aether, HttpError, type Message } from "./aether"
import { handler } from "./http"
import type { NativeCoordinator, NativeContext } from "./native"
import { removeIntegration, refreshInstallation, LifecycleError } from "./lifecycle"

export function baseURL(value: string) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Aether address must be an HTTP(S) base URL without credentials, query or fragment.")
  return url.href.replace(/\/$/, "")
}

export function controlHandler(engine: Engine, token: string, native?: NativeCoordinator, permissions = new TaskPermissions(engine)) {
  let uninstalling = false
  const api = handler(engine, token)
  const reader = new Aether(engine.aether.url, engine.aether.authorization, 8000)
  const json = (data: unknown, status = 200) => Response.json(data, { status })

  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const origin = request.headers.get("Origin")
    if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed." }, 403)
    if (request.method === "GET" && ["/", "/health"].includes(url.pathname))
      return json({ ok: true, service: "aether-superagent", ui: "Open Super-agent in the Aether sidebar." })
    if (request.headers.get("Authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401)
    if (request.method === "GET" && url.pathname === "/panel/state") {
      await refreshInstallation(engine)
      const { repo, workers, model } = engine.config
      return json({ tickets: engine.store.tickets().map((ticket) => ({ ...ticket, research: engine.store.research(ticket.id) })),
        events: engine.store.events(), inputs: engine.store.inputs(), native: native ? await native.state() : undefined, config: {
        repo, workers, model, aether: engine.aether.url,
      } })
    }
    if (request.method === "GET" && url.pathname === "/panel/connection") {
      try {
        const health = await reader.request<{ healthy?: boolean; version?: string }>(engine.config.repo, "/global/health")
        return json({ ok: health.healthy === true, version: health.version })
      } catch (error) {
        return json({ ok: false, error: error instanceof HttpError ? `Aether HTTP ${error.status}` : "无法连接 Aether，请检查地址和服务端认证。" })
      }
    }
    if (native && request.method === "POST" && (url.pathname.startsWith("/native/") || url.pathname === "/requests")) {
      const envelope = await request.clone().json() as Record<string, any>
      const operation = url.pathname === "/requests" ? envelope.native?.path : url.pathname
      const body = url.pathname === "/requests" ? envelope.native?.body : envelope
      if (operation) {
        if (uninstalling && ["/native/open", "/native/settings", "/native/uninstall", "/native/trust", "/native/permission"].includes(operation))
          throw new LifecycleError("正在卸载 Super-agent，请等待卸载结束。")
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Expected an object." }, 400)
        if (operation === "/native/permissions") return json(await permissions.list())
        if (operation === "/native/permission") return json(await permissions.reply(body.ticket, body.request, body.reply))
        if (operation === "/native/trust") return json(await permissions.trust(body.ticket, body.trusted, body.confirm))
        if (operation === "/native/open") return json(await native.open())
        if (operation === "/native/settings") {
          if (Object.keys(body).some((key) => !["enabled", "schedule"].includes(key))) return json({ error: "Unknown setting." }, 400)
          if (body.enabled !== undefined && typeof body.enabled !== "boolean") return json({ error: "enabled must be boolean." }, 400)
          if (body.schedule !== undefined && (!body.schedule || typeof body.schedule.enabled !== "boolean" ||
            !Number.isInteger(body.schedule.minutes) || body.schedule.minutes < 1 || body.schedule.minutes > 1440))
            return json({ error: "检查间隔须为 1–1440 分钟。" }, 400)
          native.settings({ ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.schedule === undefined ? {} : { checkinEnabled: body.schedule.enabled, checkinSeconds: body.schedule.minutes * 60 }) })
          return json(await native.state())
        }
        if (operation === "/native/uninstall") {
          if (body.confirm !== true) return json({ error: "卸载需要明确确认。" }, 400)
          // Freeze new claims before awaiting remote state; in-flight work is preserved.
          uninstalling = true
          try {
            native.settings({ enabled: false })
            permissions.assertUninstallable()
            try { await native.assertUninstallable() } catch (error) { throw new LifecycleError(String(error)) }
            return json(await removeIntegration(engine, (await native.state()).master))
          } finally { uninstalling = false }
        }
        // Tools are accepted only through the authenticated private coordinator,
        // not through the browser tunnel or frontend bridge allowlist.
        if (operation === "/native/tool" && url.pathname === "/native/tool") {
          const ctx = body.context as NativeContext
          if (!ctx || typeof ctx !== "object") return json({ error: "Tool context is required." }, 400)
          if (body.name === "dispatch") return json(await native.dispatch(ctx, body.args))
          if (body.name === "report") return json(await native.report(ctx, body.args))
          if (body.name === "status") return json(await native.state(ctx))
          if (body.name === "stop") return json(await native.stop(ctx, body.args?.ticket))
          return json({ error: "Unknown coordination tool." }, 400)
        }
        return json({ error: "Unsupported native operation." }, 400)
      }
    }
    const match = url.pathname.match(/^\/tickets\/([^/]+)\/(open|conversation)$/)
    if (request.method === "GET" && match) {
      if (url.search) return json({ error: "Session and directory are resolved from the ticket; query overrides are not accepted." }, 400)
      const ticket = engine.store.ticket(match[1]!)
      if (!ticket) return json({ error: "Unknown ticket." }, 404)
      try {
        const session = await reader.request<{ id: string; directory: string }>(ticket.directory, `/session/${ticket.session}`)
        if (session.id !== ticket.session || session.directory !== ticket.directory)
          return json({ error: "Aether session identity does not match this ticket." }, 409)
        if (match[2] === "open") return json({ directory: ticket.directory, session: ticket.session })
        const messages = await reader.request<Message[]>(ticket.directory, `/session/${ticket.session}/message`)
        return json({ session: ticket.session, messages: messages.map((message) => ({
          id: message.info.id, role: message.info.role, parentID: message.info.parentID,
          parts: message.parts.flatMap((part) => {
            if (part.type === "text") return [{ type: "text", text: part.text ?? "" }]
            // Tool arguments, raw outputs, reasoning and credentials stay in Aether.
            if (part.type === "tool") {
              const tool = part as unknown as { tool?: string; state?: { status?: string } }
              return [{ type: "tool", text: `${tool.tool ?? "tool"} · ${tool.state?.status ?? "running"}` }]
            }
            return []
          }),
        })) })
      } catch (error) {
        return json({ error: error instanceof HttpError && error.status === 404 ? "会话尚未建立，或已在 Aether 中删除。" : "无法读取 Aether 会话，请检查连接。" }, error instanceof HttpError && error.status === 404 ? 404 : 502)
      }
    }
    return api(request)
  }
  return async (request: Request) => {
    let response: Response
    try { response = await serve(request) }
    catch (error) { response = json({ error: error instanceof Error ? error.message : "请求无效。" }, error instanceof LifecycleError ? error.status : 400) }
    response.headers.set("Cache-Control", "no-store")
    response.headers.set("X-Content-Type-Options", "nosniff")
    response.headers.set("Referrer-Policy", "no-referrer")
    response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    return response
  }
}
