import path from "path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { tmpdir } from "./fixture"

export async function features(config: Config.Info = {}) {
  const dir = await tmpdir({
    init: (root) => Bun.write(path.join(root, "aether.json"), JSON.stringify(config)).then(() => undefined),
  })
  const prev = Global.Path.config
  const local = process.env.LOCALAPPDATA
  Global.Path.config = dir.path
  process.env.LOCALAPPDATA = dir.path
  Config.global.reset()
  Config.state.reset()
  return {
    path: dir.path,
    async [Symbol.asyncDispose]() {
      Global.Path.config = prev
      if (local === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = local
      Config.global.reset()
      Config.state.reset()
      await dir[Symbol.asyncDispose]()
    },
  }
}
