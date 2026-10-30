import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

const schema = "https://opencode.ai/config.json"

async function isolated(fn: (dir: string) => Promise<void>) {
  await using tmp = await tmpdir()
  const prev = Global.Path.config
  Global.Path.config = tmp.path
  Config.global.reset()
  try {
    await fn(tmp.path)
  } finally {
    Global.Path.config = prev
    Config.global.reset()
  }
}

async function save(dir: string, name: string, config: Config.Info & { native?: unknown }) {
  await Bun.write(path.join(dir, name), JSON.stringify({ $schema: schema, ...config }, null, 2))
}

async function read(dir: string, name: string): Promise<Config.Info & { native?: unknown }> {
  return parse(await Bun.file(path.join(dir, name)).text())
}

test("integrations override legacy global settings without migrating during reads", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.json", {
      latex: { tectonic: { path: "legacy" }, latexmk: { path: "latexmk" } },
      model: "test/model",
    })
    await save(dir, "aether.integrations.jsonc", { latex: { tectonic: { path: "managed" } } })
    const before = await Bun.file(path.join(dir, "aether.json")).text()
    expect((await Config.getGlobal()).latex).toEqual({ tectonic: { path: "managed" }, latexmk: { path: "latexmk" } })
    expect((await Config.getGlobal()).model).toBe("test/model")
    expect(await Bun.file(path.join(dir, "aether.json")).text()).toBe(before)
  })
})

test("integrations reject unrelated global settings", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.integrations.jsonc", { model: "unexpected/model" })
    await expect(Config.getGlobal()).rejects.toMatchObject({ name: "ConfigInvalidError" })
  })
})

test("shared integrations resolve only latex placeholders and preserve opaque sibling text", async () => {
  await isolated(async (dir) => {
    await Bun.write(path.join(dir, "tectonic-path"), "tectonic-fixture")
    const sibling = `"native": {
      // This build must not resolve or validate another feature's settings.
      "codex": { "path": "{file:missing-codex-path}" },
      "future": ["{env:AETHER_UNSET_SIBLING}", 42]
    }`
    const source = `{
      ${sibling},
      "latex": { "tectonic": { "path": "{file:tectonic-path}" }, "latexmk": { "path": "latexmk" } }
    }`
    const file = path.join(dir, "aether.integrations.jsonc")
    await Bun.write(file, source)
    const current = await Config.getGlobal()
    expect(current.latex).toEqual({ tectonic: { path: "tectonic-fixture" }, latexmk: { path: "latexmk" } })
    expect(current).not.toHaveProperty("native")
    expect(await Bun.file(file).text()).toBe(source)
    const result = await Config.updateGlobal({ latex: { latexmk: { path: "new-latexmk" } } })
    expect(result.latex).toEqual({ tectonic: { path: "tectonic-fixture" }, latexmk: { path: "new-latexmk" } })
    expect(result).not.toHaveProperty("native")
    expect(await Config.getGlobal()).not.toHaveProperty("native")
    expect(await Bun.file(file).text()).toContain(sibling)
    expect((await read(dir, "aether.integrations.jsonc")).latex?.tectonic?.path).toBe("{file:tectonic-path}")
    expect(await Bun.file(path.join(dir, "aether.json")).exists()).toBe(false)
  })
})

test("sibling-only integrations stay byte-identical during ordinary config saves", async () => {
  await isolated(async (dir) => {
    const file = path.join(dir, "aether.integrations.jsonc")
    const source = '{\n  // Opaque sibling data.\n  "native": ["{file:missing}", null]\n}\n'
    await Bun.write(file, source)
    expect(await Config.getGlobal()).toEqual({})
    const result = await Config.updateGlobal({ model: "test/model" })
    expect(result.model).toBe("test/model")
    expect(result).not.toHaveProperty("native")
    expect(await Bun.file(file).text()).toBe(source)
    expect(await read(dir, "aether.json")).toEqual({ $schema: schema, model: "test/model" })
  })
})

test("latex validation still rejects invalid settings in the shared envelope", async () => {
  await isolated(async (dir) => {
    const file = path.join(dir, "aether.integrations.jsonc")
    await Bun.write(file, JSON.stringify({ latex: { tectonic: { path: 17 } }, native: { path: "{file:missing}" } }))
    const before = await Bun.file(file).text()
    await expect(Config.getGlobal()).rejects.toMatchObject({ name: "ConfigInvalidError" })
    expect(await Bun.file(file).text()).toBe(before)
  })
})

test("unmigrated mixed standard config is rejected without removing sibling fields", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.jsonc", {
      latex: { tectonic: { path: "tectonic" } },
      native: { codex: { enabled: false } },
    })
    const file = path.join(dir, "aether.jsonc")
    const before = await Bun.file(file).text()
    await expect(Config.getGlobal()).rejects.toMatchObject({ name: "ConfigInvalidError" })
    await expect(Config.updateGlobal({ latex: { latexmk: { path: "latexmk" } } })).rejects.toMatchObject({
      name: "ConfigInvalidError",
    })
    expect(await Bun.file(file).text()).toBe(before)
    expect(await Bun.file(path.join(dir, "aether.integrations.jsonc")).exists()).toBe(false)
  })
})

test("integration-only saves create no standard config and merge latex settings", async () => {
  await isolated(async (dir) => {
    await Config.updateGlobal({ latex: { tectonic: { path: "tectonic" } } })
    const result = await Config.updateGlobal({ latex: { latexmk: { path: "latexmk" } } })
    expect(result.latex).toEqual({ tectonic: { path: "tectonic" }, latexmk: { path: "latexmk" } })
    expect(result).not.toHaveProperty("native")
    expect(await read(dir, "aether.integrations.jsonc")).toEqual(result)
    expect(await Bun.file(path.join(dir, "aether.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, "aether.jsonc")).exists()).toBe(false)
  })
})

test("ordinary saves never copy integrations into a newly created standard config", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.integrations.jsonc", {
      latex: { tectonic: { path: "tectonic" } },
      native: { codex: { enabled: false } },
    })
    const result = await Config.updateGlobal({ model: "test/model" })
    expect(result.latex?.tectonic?.path).toBe("tectonic")
    expect(result).not.toHaveProperty("native")
    expect(result.model).toBe("test/model")
    expect(await read(dir, "aether.json")).toEqual({ $schema: schema, model: "test/model" })
    expect((await read(dir, "aether.integrations.jsonc")).native).toEqual({ codex: { enabled: false } })
  })
})

test("saving migrates all active standard files, preserves comments and ignores shadowed legacy files", async () => {
  await isolated(async (dir) => {
    await save(dir, "config.json", { latex: { latexmk: { path: "latexmk-1" } } })
    await save(dir, "aether.json", { latex: { latexmk: { path: "latexmk-2" } }, model: "test/model" })
    await Bun.write(
      path.join(dir, "aether.jsonc"),
      `{
      "$schema": "${schema}",
      // Preserve this provider and its comment.
      "provider": { "openai": { "options": { "baseURL": "https://example.test" } } },
      "latex": { "latexmk": { "path": "latexmk-3" }, "tectonic": { "path": "{env:AETHER_INTEGRATION_TEST_PATH}" } }
    }`,
    )
    await save(dir, "opencode.json", { latex: { latexmk: { path: "shadowed" } } })
    await save(dir, "aether.integrations.jsonc", { latex: { latexmk: { path: "latexmk-4" } } })
    const inactive = await Bun.file(path.join(dir, "opencode.json")).text()
    const result = await Config.updateGlobal({ latex: { tectonic: {} } })
    expect(result.latex?.latexmk?.path).toBe("latexmk-4")
    expect(result).not.toHaveProperty("native")
    expect(result.provider?.openai?.options?.baseURL).toBe("https://example.test")
    for (const name of ["config.json", "aether.json", "aether.jsonc"]) {
      expect((await read(dir, name)).latex).toBeUndefined()
      expect((await read(dir, name)).native).toBeUndefined()
    }
    expect((await read(dir, "aether.integrations.jsonc")).latex?.tectonic?.path).toBe(
      "{env:AETHER_INTEGRATION_TEST_PATH}",
    )
    expect(await Bun.file(path.join(dir, "aether.jsonc")).text()).toContain(
      "// Preserve this provider and its comment.",
    )
    expect(await Bun.file(path.join(dir, "opencode.json")).text()).toBe(inactive)
  })
})

test("integration-only legacy migration keeps the existing standard config selection", async () => {
  await isolated(async (dir) => {
    await save(dir, "opencode.jsonc", { latex: { tectonic: { path: "tectonic" } }, model: "legacy/model" })
    const result = await Config.updateGlobal({ latex: { latexmk: { path: "latexmk" } } })
    expect(result.model).toBe("legacy/model")
    expect(result.latex).toEqual({ tectonic: { path: "tectonic" }, latexmk: { path: "latexmk" } })
    expect((await read(dir, "opencode.jsonc")).latex).toBeUndefined()
    expect(await Bun.file(path.join(dir, "aether.jsonc")).exists()).toBe(false)
  })
})

test("ordinary JSONC saves migrate integrations without deleting providers", async () => {
  await isolated(async (dir) => {
    const provider = { openai: { options: { baseURL: "https://example.test" } } }
    await save(dir, "aether.jsonc", { provider, latex: { tectonic: { path: "tectonic" } } })
    const result = await Config.updateGlobal({ model: "test/model" })
    expect(result.provider).toEqual(provider)
    expect(result.latex?.tectonic?.path).toBe("tectonic")
    expect((await read(dir, "aether.jsonc")).provider).toEqual(provider)
    expect((await read(dir, "aether.jsonc")).latex).toBeUndefined()
    expect((await read(dir, "aether.jsonc")).native).toBeUndefined()
  })
})

test("legacy ignored fields survive an integration-only migration", async () => {
  await isolated(async (dir) => {
    await Bun.write(
      path.join(dir, "aether.jsonc"),
      JSON.stringify({
        $schema: schema,
        theme: "legacy-theme",
        tui: { scroll_speed: 4 },
        latex: { tectonic: { path: "tectonic" } },
      }),
    )
    await Config.updateGlobal({ latex: { latexmk: { path: "latexmk" } } })
    const raw = parse(await Bun.file(path.join(dir, "aether.jsonc")).text())
    expect(raw.theme).toBe("legacy-theme")
    expect(raw.tui).toEqual({ scroll_speed: 4 })
    expect(raw.latex).toBeUndefined()
    expect((await Config.getGlobal()).latex).toEqual({ tectonic: { path: "tectonic" }, latexmk: { path: "latexmk" } })
  })
})

test("mixed saves preserve provider replacement and removal semantics", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.jsonc", {
      provider: {
        openai: { options: { baseURL: "https://old.test" }, name: "old" },
        retained: { name: "retained" },
        removed: { name: "removed" },
      },
    })
    const result = await Config.updateGlobal({
      latex: { tectonic: { path: "tectonic" } },
      provider: { openai: { name: "new" } },
      provider_remove: ["removed"],
    })
    expect(result.provider).toEqual({ openai: { name: "new" }, retained: { name: "retained" } })
    expect(result.latex?.tectonic?.path).toBe("tectonic")
    expect((await read(dir, "aether.jsonc")).latex).toBeUndefined()
    expect((await read(dir, "aether.jsonc")).provider_remove).toBeUndefined()
  })
})

test("concurrent saves merge integration fields without losing either update", async () => {
  await isolated(async (dir) => {
    await Promise.all([
      Config.updateGlobal({ latex: { tectonic: { path: "tectonic" } } }),
      Config.updateGlobal({ latex: { latexmk: { path: "latexmk" } } }),
    ])
    expect((await Config.getGlobal()).latex).toEqual({ tectonic: { path: "tectonic" }, latexmk: { path: "latexmk" } })
  })
})

test("invalid mixed saves are rejected before writing either file", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.json", { model: "original/model" })
    const before = await Bun.file(path.join(dir, "aether.json")).text()
    const config = JSON.parse('{"latex":{"tectonic":{"path":17}},"model":"new/model"}') as Config.Info
    await expect(Config.updateGlobal(config)).rejects.toBeDefined()
    expect(await Bun.file(path.join(dir, "aether.json")).text()).toBe(before)
    expect(await Bun.file(path.join(dir, "aether.integrations.jsonc")).exists()).toBe(false)
  })
})

for (const exists of [false, true]) {
  test(`a failed standard-file replacement rolls back ${exists ? "existing" : "new"} integrations`, async () => {
    await isolated(async (dir) => {
      await save(dir, "aether.jsonc", { latex: { tectonic: { path: "legacy" } }, model: "original/model" })
      if (exists) await save(dir, "aether.integrations.jsonc", { latex: { tectonic: { path: "managed" } } })
      const main = path.join(dir, "aether.jsonc")
      const extra = path.join(dir, "aether.integrations.jsonc")
      const before = await Bun.file(main).text()
      const prior = exists ? await Bun.file(extra).text() : undefined
      const rename = fs.rename
      const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === main) throw new Error("Injected config replacement failure")
        return rename(from, to)
      })
      try {
        await expect(Config.updateGlobal({ latex: { tectonic: { path: "new" } }, model: "new/model" })).rejects.toThrow(
          "Injected config replacement failure",
        )
      } finally {
        fault.mockRestore()
      }
      expect(await Bun.file(main).text()).toBe(before)
      if (prior !== undefined) expect(await Bun.file(extra).text()).toBe(prior)
      if (!exists) expect(await Bun.file(extra).exists()).toBe(false)
      expect((await Config.getGlobal()).latex?.tectonic?.path).toBe(exists ? "managed" : "legacy")
      expect((await fs.readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false)
    })
  })
}

test("a failed legacy rollback retains integrations as the surviving settings copy", async () => {
  await isolated(async (dir) => {
    await save(dir, "config.json", { latex: { tectonic: { path: "tectonic" } } })
    await save(dir, "aether.json", { latex: { latexmk: { path: "latexmk" } } })
    const base = path.join(dir, "config.json")
    const main = path.join(dir, "aether.json")
    const rename = fs.rename
    let written = false
    const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === main || (to === base && written)) throw new Error("Injected replacement and rollback failure")
      await rename(from, to)
      if (to === base) written = true
    })
    try {
      await expect(Config.updateGlobal({ latex: { latexmk: { path: "new-latexmk" } } })).rejects.toThrow(
        "Config update and rollback failed",
      )
    } finally {
      fault.mockRestore()
    }
    expect((await read(dir, "config.json")).latex).toBeUndefined()
    expect((await read(dir, "aether.integrations.jsonc")).latex).toEqual({
      tectonic: { path: "tectonic" },
      latexmk: { path: "new-latexmk" },
    })
    expect((await Config.getGlobal()).latex?.tectonic?.path).toBe("tectonic")
    expect((await Config.getGlobal()).latex?.latexmk?.path).toBe("new-latexmk")
  })
})

test("a concurrent external edit is preserved and the integration update is rolled back", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.jsonc", { latex: { tectonic: { path: "tectonic" } }, model: "original/model" })
    const main = path.join(dir, "aether.jsonc")
    const extra = path.join(dir, "aether.integrations.jsonc")
    const rename = fs.rename
    const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === extra)
        await save(dir, "aether.jsonc", { latex: { tectonic: { path: "tectonic" } }, model: "external/model" })
    })
    try {
      await expect(Config.updateGlobal({ latex: { tectonic: { path: "new" } } })).rejects.toThrow(
        "Config changed during save",
      )
    } finally {
      fault.mockRestore()
    }
    expect((await read(dir, "aether.jsonc")).model).toBe("external/model")
    expect((await Config.getGlobal()).latex?.tectonic?.path).toBe("tectonic")
    expect(await Bun.file(extra).exists()).toBe(false)
  })
})

test("rollback preserves an external edit to the already replaced integrations file", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.jsonc", { latex: { tectonic: { path: "tectonic" } } })
    const main = path.join(dir, "aether.jsonc")
    const extra = path.join(dir, "aether.integrations.jsonc")
    const before = await Bun.file(main).text()
    const external = JSON.stringify({ latex: { tectonic: { path: "external" } } })
    const rename = fs.rename
    const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === main) throw new Error("Injected replacement failure")
      await rename(from, to)
      if (to === extra) await Bun.write(extra, external)
    })
    try {
      await expect(Config.updateGlobal({ latex: { tectonic: { path: "new" } } })).rejects.toThrow(
        "Config update and rollback failed",
      )
    } finally {
      fault.mockRestore()
    }
    expect(await Bun.file(main).text()).toBe(before)
    expect(await Bun.file(extra).text()).toBe(external)
    expect((await Config.getGlobal()).latex?.tectonic?.path).toBe("external")
  })
})
