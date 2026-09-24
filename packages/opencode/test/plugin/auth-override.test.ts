import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ProviderAuth } from "../../src/provider/auth"
import { ProviderID } from "../../src/provider/schema"
import { Global } from "../../src/global"
import { Config } from "../../src/config/config"

describe("plugin.auth-override", () => {
  test("user plugin overrides built-in github-copilot auth", async () => {
    await using tmp = await tmpdir<string>({
      init: async (dir) => {
        const pluginDir = path.join(dir, "plugin")
        await fs.mkdir(pluginDir, { recursive: true })

        await Bun.write(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default async () => ({",
            "  auth: {",
            '    provider: "github-copilot",',
            "    methods: [",
            '      { type: "api", label: "Test Override Auth" },',
            "    ],",
            "    loader: async () => ({ access: 'test-token' }),",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        return dir
      },
    })

    await using plain = await tmpdir()

    const prev = Global.Path.config
    ;(Global.Path as { config: string }).config = tmp.extra
    Config.global.reset()
    try {
      const methods = await Instance.provide({
        directory: plain.path,
        fn: async () => {
          return ProviderAuth.methods()
        },
      })

      const copilot = methods[ProviderID.make("github-copilot")]
      expect(copilot).toBeDefined()
      expect(copilot.length).toBe(1)
      expect(copilot[0].label).toBe("Test Override Auth")
    } finally {
      ;(Global.Path as { config: string }).config = prev
      Config.global.reset()
    }
  }, 30000) // Increased timeout for plugin installation
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.config-hook-error-isolation", () => {
  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()

    // The config hook try/catch lives in the InstanceState factory (layer definition),
    // not in init() which now just delegates to the Effect service.
    expect(src).toContain("plugin config hook failed")

    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?try\s*\{[\s\S]*?\.config\?\.\([\s\S]*?\}\s*catch\s*\(err\)\s*\{[\s\S]*?plugin config hook failed[\s\S]*?\}/
    expect(pattern.test(src)).toBe(true)
  })
})
