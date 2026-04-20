import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"
import { Global } from "../../global"
import { Database } from "../../storage/db"
import path from "path"
import { Lease } from "../../server/lease"

const LEASE_MS = 45_000
const EXIT_MS = 5_000

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("remote-runtime", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("remote-lease-ttl", {
        type: "number",
        hidden: true,
        default: LEASE_MS,
      })
      .option("remote-exit-grace", {
        type: "number",
        hidden: true,
        default: EXIT_MS,
      }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER ??= "true"
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    const portfile = path.join(Database.ensureChannelDir(), "serve-port")
    await Bun.write(portfile, String(server.port))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    if (args["remote-runtime"]) {
      const lease = Math.max(1_000, Math.trunc(args["remote-lease-ttl"] ?? LEASE_MS))
      const grace = Math.max(1_000, Math.trunc(args["remote-exit-grace"] ?? EXIT_MS))
      let seen = false
      let exit: ReturnType<typeof setTimeout> | undefined
      const clear = () => {
        if (!exit) return
        clearTimeout(exit)
        exit = undefined
      }
      const stop = setInterval(() => {
        const active = (server as any).pendingRequests as number
        const held = Lease.count() > 0
        if (active > 0 || held) {
          seen = true
          clear()
          return
        }
        if (!seen) return
        exit =
          exit ??
          setTimeout(() => {
            const pending = (server as any).pendingRequests as number
            if (pending > 0 || Lease.count() > 0) {
              exit = undefined
              return
            }
            console.log(`remote runtime lease expired after ${lease}ms; shutting down`)
            clearInterval(stop)
            process.exit(0)
          }, Math.min(grace, lease))
      }, 1_000)
      process.once("exit", () => {
        clearInterval(stop)
        clear()
      })
    }

    await new Promise(() => {})
    await server.stop()
  },
})
