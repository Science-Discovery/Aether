import path from "node:path"
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import { install, uninstall } from "../src/integration"

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  aether: { type: "string" }, config: { type: "string" }, "bridge-file": { type: "string" }, uninstall: { type: "boolean" },
} })
if (!values.aether) throw new Error("Use --aether /path/to/Aether --config config.local.json; add --uninstall to remove the integration.")
if (values.uninstall) {
  console.log(JSON.stringify(await uninstall(values.aether), null, 2))
} else {
  const config = await Bun.file(values.config ?? "config.local.json").json() as { state: string; port?: number }
  if (!path.isAbsolute(config.state)) throw new Error("Coordinator config.state must be an absolute path.")
  const bridge = values["bridge-file"] ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "aether", "superagent.json")
  console.log(JSON.stringify(await install({ root: values.aether, bridge, url: `http://127.0.0.1:${config.port ?? 19700}`, token: path.join(config.state, "token") }), null, 2))
  console.log("Native UI integration installed. Build Aether from this checkout; existing packaged binaries do not load source changes.")
  if (values["bridge-file"]) console.log(`Set AETHER_SUPERAGENT_CONFIG=${bridge} on the Aether backend.`)
}
