import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { Global } from "../../global"
import { Database } from "../../storage/db"
import nodePath from "path"
import { Lease } from "../../server/lease"
import { Instance } from "../../project/instance"
import { FeishuManager } from "../../mobile/feishu"
import { QQManager } from "../../mobile/qq"
import { WeChatManager } from "../../mobile/wechat"
import { Cron } from "../../cron"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

function browserOpenFallbackMs() {
  const raw = process.env.AETHER_WEB_OPEN_FALLBACK_MS
  if (!raw) return
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return
  return Math.min(parsed, 3_000)
}

async function openBrowserWithFallback(input: { url: string; server: unknown; sse: () => number }) {
  const fallbackMs = browserOpenFallbackMs()
  if (fallbackMs === undefined || fallbackMs <= 0) {
    open(input.url).catch(() => {})
    return
  }
  const connected = () => {
    const pending = (input.server as any).pendingRequests as number
    return pending > 0 || input.sse() > 0 || Lease.count() > 0
  }
  const deadline = Date.now() + fallbackMs
  while (Date.now() < deadline) {
    if (connected()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (connected()) return
  open(input.url).catch(() => {})
}

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  handler: async (args) => {
    async function gracefulShutdown(server: { stop: (close?: boolean) => Promise<void> }) {
      const FORCE_EXIT_MS = 10_000
      const timer = setTimeout(() => {
        process.exit(0)
      }, FORCE_EXIT_MS).unref()
      await Promise.all([
        Instance.disposeAll().catch(() => {}),
        Cron.stop().catch(() => {}),
        FeishuManager.stop().catch(() => {}),
        QQManager.stop().catch(() => {}),
        WeChatManager.stop().catch(() => {}),
      ])
      await server.stop(true).catch(() => {})
      clearTimeout(timer)
      process.exit(0)
    }
    process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER ??= "true"
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const IDLE_TIMEOUT_MS = (opts.idleTimeout ?? 60) * 1_000
    let sse = 0
    const server = Server.listen({
      ...opts,
      onBrowserConnectionChange: (count) => {
        sse = count
      },
    })

    // Auto-exit when all browser connections close (after at least one was open).
    // Polling server.pendingRequests is more reliable than SSE onAbort, because
    // Bun only detects TCP close when it next tries to write to the socket.
    // Disable by setting idleTimeout to 0 (always-on daemon mode).
    if (IDLE_TIMEOUT_MS > 0) {
      let everConnected = false
      let exitTimer: ReturnType<typeof setTimeout> | null = null
      const connectionChecker = setInterval(() => {
        const active = (server as any).pendingRequests as number
        if (active > 0 || sse > 0 || Lease.count() > 0) {
          everConnected = true
          if (exitTimer !== null) {
            clearTimeout(exitTimer)
            exitTimer = null
          }
        } else if (everConnected) {
          exitTimer =
            exitTimer ??
            setTimeout(() => {
              const pending = (server as any).pendingRequests as number
              if (pending > 0 || sse > 0 || Lease.count() > 0) {
                exitTimer = null
                return
              }
              clearInterval(connectionChecker)
              void gracefulShutdown(server)
            }, IDLE_TIMEOUT_MS)
        }
      }, 1_000)
    }
    const portfile = nodePath.join(Database.ensureChannelDir(), "serve-port")
    await Bun.write(portfile, String(server.port))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      await openBrowserWithFallback({ url: localhostUrl.toString(), server, sse: () => sse })
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      await openBrowserWithFallback({ url: displayUrl, server, sse: () => sse })
    }

    await new Promise(() => {})
    await server.stop()
  },
})
