import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { Global } from "../../global"
import nodePath from "path"

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

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)

    // Auto-exit when all browser connections close (after at least one was open).
    // Polling server.pendingRequests is more reliable than SSE onAbort, because
    // Bun only detects TCP close when it next tries to write to the socket.
    let everConnected = false
    let exitTimer: ReturnType<typeof setTimeout> | null = null
    const connectionChecker = setInterval(() => {
      const active = (server as any).pendingRequests as number
      if (active > 0) {
        everConnected = true
        if (exitTimer !== null) {
          clearTimeout(exitTimer)
          exitTimer = null
        }
      } else if (everConnected) {
        exitTimer =
          exitTimer ??
          setTimeout(() => {
            clearInterval(connectionChecker)
            process.exit(0)
          }, 3_000)
      }
    }, 1_000)
    const portfile = nodePath.join(Global.Path.data, "serve-port")
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
      open(localhostUrl.toString()).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

    await new Promise(() => {})
    await server.stop()
  },
})
