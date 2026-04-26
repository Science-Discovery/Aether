import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { Global } from "../../global"
import nodePath from "path"
import { Lease } from "../../server/lease"
import { Instance } from "../../project/instance"
import { FeishuManager } from "../../mobile/feishu"
import { QQManager } from "../../mobile/qq"
import { WeChatManager } from "../../mobile/wechat"
import { Cron } from "../../cron"
import { Registry } from "../../instance/registry"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      if (netInfo.internal || netInfo.family !== "IPv4") continue
      if (netInfo.address.startsWith("172.")) continue
      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  handler: async (args) => {
    async function gracefulShutdown(server: { stop: (close?: boolean) => Promise<void> }, entryId: string) {
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
        Registry.remove(entryId).catch(() => {}),
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
    const IDLE_TIMEOUT_MS = (opts.idleTimeout ?? 30) * 1_000

    const { kept } = await Registry.prune()
    for (const old of kept) {
      const status = await Registry.queryStatus(old.url)
      if (!status) continue
      const c = status.connections
      if (c.sse === 0 && c.globalSse === 0 && c.leaseActive === 0) {
        await Registry.accelerate(old.url)
      }
    }

    let sse = 0
    let globalSse = 0
    const server = Server.listen({
      ...opts,
      onBrowserConnectionChange: (count, globalCount) => {
        sse = count
        globalSse = globalCount ?? 0
      },
    })

    const entry = Registry.create(process.pid, server.url.toString())
    await Registry.write(entry)

    process.on("exit", () => {
      void Registry.remove(entry.id)
    })

    // Auto-exit when all browser connections close (after at least one was open).
    // Lease closing state protects against pagehide false positives (tab switching).
    // After closing entries expire, the idle timeout (configurable) provides a final
    // confirmation window before graceful shutdown.
    // Disable by setting idleTimeout to 0 (always-on daemon mode).
    if (IDLE_TIMEOUT_MS > 0) {
      let everConnected = false
      let exitTimer: ReturnType<typeof setTimeout> | null = null
      const connectionChecker = setInterval(() => {
        const active = (server as any).pendingRequests as number
        const hasActive = active > 0 || sse > 0 || globalSse > 0 || Lease.activeCount() > 0
        const hasClosing = !Server.accelerateExit && Lease.closingCount() > 0

        if (hasActive || hasClosing) {
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
              const stillActive = pending > 0 || sse > 0 || globalSse > 0 || Lease.activeCount() > 0
              const stillClosing = !Server.accelerateExit && Lease.closingCount() > 0
              if (stillActive || stillClosing) {
                exitTimer = null
                return
              }
              clearInterval(connectionChecker)
              void gracefulShutdown(server, entry.id)
            }, IDLE_TIMEOUT_MS)
        }
      }, 1_000)
    }

    const portfile = nodePath.join(Global.Path.data, "serve-port")
    await Bun.write(portfile, String(server.port))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    const hashParams = new URLSearchParams({
      local: server.url.toString(),
      instance: entry.id,
    })
    const launchHash = `#${hashParams.toString()}`

    if (opts.hostname === "0.0.0.0") {
      const localhostUrl = `http://localhost:${server.port}${launchHash}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}${launchHash}`,
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

      open(localhostUrl).catch(() => {})
    } else {
      const displayUrl = `${server.url.toString()}${launchHash}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

    await new Promise(() => {})
    await server.stop()
  },
})
