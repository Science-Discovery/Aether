import { Hono } from "hono"
import path from "node:path"
import { Global } from "@/global"

function canonical(value: string) {
  const url = new URL(value)
  return url.origin + url.pathname.replace(/\/+$/, "")
}

// Inherits Aether's authentication and origin guard. No browser-side sidecar
// token, arbitrary proxy destination, cookie forwarding or redirects.
export function SuperagentRoutes() {
  return new Hono().all("/*", async (c) => {
    const request = new URL(c.req.url)
    const index = request.pathname.lastIndexOf("/superagent")
    const route = request.pathname.slice(index + "/superagent".length)
    const method = c.req.method
    const readable = /^\/(panel\/(state|connection)|tickets(?:\/[a-zA-Z0-9_]+(?:\/(open|conversation))?)?|inputs(?:\/[a-zA-Z0-9_]+)?)$/.test(route)
    const writable = /^\/(native\/(open|settings|uninstall)|requests|tickets|tickets\/[a-zA-Z0-9_]+\/(messages|stop)|inputs\/[a-zA-Z0-9_]+\/(reconcile|dismiss))$/.test(route)
    if (!((method === "GET" && readable) || (method === "POST" && writable)) || request.search)
      return c.json({ error: "Unsupported super-agent operation." }, 400)
    try {
      const config = await Bun.file(process.env.AETHER_SUPERAGENT_CONFIG ?? path.join(Global.Path.config, "superagent.json")).json() as { url: string; tokenFile: string }
      const target = new URL(config.url)
      if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/" || target.username || target.password || target.search || target.hash || !path.isAbsolute(config.tokenFile))
        return c.json({ error: "Invalid super-agent bridge configuration." }, 503)
      const token = (await Bun.file(config.tokenFile).text()).trim()
      if (!token) return c.json({ error: "Super-agent access token is missing." }, 503)
      // A Unix socket keeps the local credential out of environment proxies,
      // including older Bun versions where proxy:false is not supported.
      const call = (suffix: string, body?: string) => fetch(new URL(suffix, target), {
        unix: path.join(path.dirname(config.tokenFile), "control.sock"),
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body, redirect: "error", signal: AbortSignal.timeout(12000),
      })
      const response = await call("/panel/state")
      if (!response.ok) return c.json({ error: "Super-agent is unavailable or its access token changed." }, 503)
      const state = await response.json() as { config?: { aether?: string }; tokenPath?: string }
      const backend = request.origin + request.pathname.slice(0, index)
      if (!state.config?.aether || canonical(state.config.aether) !== canonical(backend))
        return c.json({ error: "Super-agent connects to a different Aether backend. Check config.aether before submitting." }, 409)
      if (route === "/panel/state") {
        const { tokenPath: _, ...visible } = state
        c.header("Cache-Control", "no-store")
        return c.json(visible)
      }
      const body = method === "POST" ? await c.req.text() : undefined
      if (body !== undefined && Buffer.byteLength(body) > 256000) return c.json({ error: "Request too large." }, 413)
      const result = await call(route, body)
      // Return only JSON data and status; never forward upstream auth, cookies,
      // location or CORS headers into the host application.
      return new Response(await result.text(), { status: result.status, headers: {
        "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } })
    } catch {
      return c.json({ error: "无法连接 Super-agent。请启动协调器，并检查本机 bridge 配置及 token 文件。" }, 503)
    }
  })
}
