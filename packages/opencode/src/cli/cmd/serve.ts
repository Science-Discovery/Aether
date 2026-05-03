import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"
import { Global } from "../../global"
import path from "path"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const AETHER_PORT = 19527
    process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER ??= "true"
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    const portfile = path.join(Global.Path.data, "serve-port")
    await Bun.write(portfile, String(server.port))
    if (server.port !== AETHER_PORT && opts.port === 0) {
      console.warn(`Warning: Default port ${AETHER_PORT} is occupied, using fallback port ${server.port}.`)
    }
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    await new Promise(() => {})
    await server.stop()
  },
})
