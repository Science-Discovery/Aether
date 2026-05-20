import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { resolveNetworkOptions, type NetworkOptions } from "../../src/cli/network"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

const argv = process.argv.slice()
const env = process.env.AETHER_IDLE_TIMEOUT

const args: NetworkOptions = {
  port: 0,
  hostname: "127.0.0.1",
  mdns: false,
  "mdns-domain": "opencode.local",
  cors: [],
  "idle-timeout": undefined,
}

afterEach(() => {
  process.argv = argv.slice()
  if (env === undefined) delete process.env.AETHER_IDLE_TIMEOUT
  else process.env.AETHER_IDLE_TIMEOUT = env
  Config.global.reset()
})

async function run(cfg: object, fn: () => Promise<void>) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "aether.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...cfg }))
    },
  })
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path
  Config.global.reset()
  try {
    await fn()
  } finally {
    ;(Global.Path as { config: string }).config = prev
    Config.global.reset()
  }
}

describe("network options", () => {
  test("uses AETHER_IDLE_TIMEOUT before config", async () => {
    process.env.AETHER_IDLE_TIMEOUT = "15"
    await run({ server: { idleTimeout: 300 } }, async () => {
      expect((await resolveNetworkOptions(args)).idleTimeout).toBe(15)
    })
  })

  test("allows AETHER_IDLE_TIMEOUT to disable auto-exit", async () => {
    process.env.AETHER_IDLE_TIMEOUT = "0"
    await run({ server: { idleTimeout: 300 } }, async () => {
      expect((await resolveNetworkOptions(args)).idleTimeout).toBe(0)
    })
  })

  test("uses CLI idle timeout before AETHER_IDLE_TIMEOUT", async () => {
    process.argv = [...argv, "--idle-timeout"]
    process.env.AETHER_IDLE_TIMEOUT = "15"
    await run({ server: { idleTimeout: 300 } }, async () => {
      expect((await resolveNetworkOptions({ ...args, "idle-timeout": 30 })).idleTimeout).toBe(30)
    })
  })

  test("ignores invalid AETHER_IDLE_TIMEOUT", async () => {
    process.env.AETHER_IDLE_TIMEOUT = "nope"
    await run({ server: { idleTimeout: 300 } }, async () => {
      expect((await resolveNetworkOptions(args)).idleTimeout).toBe(300)
    })
  })
})
