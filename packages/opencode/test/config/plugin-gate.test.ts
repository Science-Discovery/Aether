import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { ConfigPaths } from "../../src/config/paths"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { BunProc } from "../../src/bun"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

// Hermetic instance boot: redirects the global config dir to a fresh temp dir
// (globalDir overrides it), mocks bun so queued dependency installs never
// spawn, and flushes those fire-and-forget promises inside the instance so
// nothing bleeds into other tests running in the same process.
async function boot(directory: string, fn: () => Promise<void>, globalDir?: string) {
  await using fallback = globalDir ? undefined : await tmpdir()
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = globalDir ?? fallback!.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory,
      fn: async () => {
        const run = spyOn(BunProc, "run").mockResolvedValue({
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        })
        try {
          await fn()
          await Config.waitForDependencies()
        } finally {
          run.mockRestore()
        }
      },
    })
  } finally {
    ;(Global.Path as { config: string }).config = prev
    Config.global.reset()
  }
}

function collectErrors() {
  const messages: string[] = []
  const unsub = Bus.subscribe(Session.Event.Error, (evt) => {
    messages.push(JSON.stringify(evt.properties))
  })
  return { messages, unsub }
}

afterEach(async () => {
  await Instance.disposeAll()
  Config.global.reset()
})

describe("plugin trust gate", () => {
  test("blocks npm plugin from project opencode.json and reports it", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["evil-pkg"] }),
        )
      },
    })

    await boot(tmp.path, async () => {
      const { messages, unsub } = collectErrors()
      const config = await Config.get()
      await Bun.sleep(20)
      unsub()

      expect(config.plugin ?? []).not.toContain("evil-pkg")
      expect(config.plugin?.some((p) => p.includes("evil-pkg"))).toBe(false)
      expect(messages.some((m) => m.includes("evil-pkg"))).toBe(true)
    })
  }, 30000)

  test("blocks plugin files from project plugin directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const pluginDir = path.join(dir, ".opencode", "plugin")
        await fs.mkdir(pluginDir, { recursive: true })
        await Bun.write(path.join(pluginDir, "local.ts"), "export default async () => ({})\n")
      },
    })

    await boot(tmp.path, async () => {
      const config = await Config.get()
      expect(config.plugin?.some((p) => p.includes("local"))).toBe(false)
    })
  }, 30000)

  test("keeps plugins from global config", async () => {
    await using tmp = await tmpdir<string>({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["global-kept-plugin"] }),
        )
        return dir
      },
    })
    await using project = await tmpdir()

    await boot(
      project.path,
      async () => {
        const config = await Config.get()
        expect(config.plugin?.some((p) => p.includes("global-kept-plugin"))).toBe(true)
      },
      tmp.extra,
    )
  }, 30000)

  test("keeps plugins from OPENCODE_CONFIG_DIR", async () => {
    await using tmp = await tmpdir<string>({
      init: async (dir) => {
        const custom = path.join(dir, "configdir")
        await fs.mkdir(custom, { recursive: true })
        await Bun.write(
          path.join(custom, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["configdir-plugin"] }),
        )
        return custom
      },
    })
    await using project = await tmpdir()

    const prev = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = tmp.extra
    try {
      await boot(project.path, async () => {
        const config = await Config.get()
        expect(config.plugin?.some((p) => p.includes("configdir-plugin"))).toBe(true)
      })
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = prev
    }
  }, 30000)

  test("ignores plugins from remote well-known config while keeping other fields", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            config: { plugin: ["remote-evil-pkg"], username: "remote-user" },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    })
    const url = `http://127.0.0.1:${server.port}`
    const key = "OPENCODE_TEST_WELLKNOWN_KEY"
    const prevEnv = process.env[key]
    const authAll = spyOn(Auth, "all").mockResolvedValue({
      [url]: { type: "wellknown", key, token: "test-token" },
    } as never)

    try {
      await using tmp = await tmpdir()
      await boot(tmp.path, async () => {
        const config = await Config.get()
        expect(config.plugin?.some((p) => p.includes("remote-evil-pkg"))).toBe(false)
        expect(config.username).toBe("remote-user")
      })
    } finally {
      authAll.mockRestore()
      if (prevEnv === undefined) delete process.env[key]
      else process.env[key] = prevEnv
      server.stop(true)
    }
  }, 30000)

  test("reports each blocked plugin once across duplicate declarations", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const local = path.join(dir, ".opencode")
        await fs.mkdir(local, { recursive: true })
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["dup-pkg"] }),
        )
        await Bun.write(
          path.join(local, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["dup-pkg", "other-pkg"] }),
        )
      },
    })

    await boot(tmp.path, async () => {
      const { messages, unsub } = collectErrors()
      const config = await Config.get()
      await Bun.sleep(20)
      unsub()

      expect(config.plugin?.some((p) => p.includes("dup-pkg"))).toBe(false)
      expect(config.plugin?.some((p) => p.includes("other-pkg"))).toBe(false)
      expect(messages.filter((m) => m.includes("dup-pkg")).length).toBe(1)
      expect(messages.filter((m) => m.includes("other-pkg")).length).toBe(1)
    })
  }, 30000)

  test("project directories never overlap trusted config roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const scopes = await ConfigPaths.scopes(tmp.path, tmp.path)
    expect(scopes.directories).toContain(Global.Path.config)
    for (const dir of scopes.untrusted) {
      expect(dir.startsWith(tmp.path)).toBe(true)
    }
  }, 30000)
})
