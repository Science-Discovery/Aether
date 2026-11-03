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

async function save(dir: string, name: string, config: Config.Info & { latex?: unknown }) {
  await Bun.write(path.join(dir, name), JSON.stringify({ $schema: schema, ...config }, null, 2))
}

async function read(dir: string, name: string): Promise<Config.Info & { latex?: unknown }> {
  return parse(await Bun.file(path.join(dir, name)).text())
}

test("integrations override legacy global settings without migrating during reads", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.json", { native: { codex: { enabled: true, limit: 3 } }, model: "test/model" })
    await save(dir, "aether.integrations.jsonc", { native: { codex: { enabled: false } } })
    const before = await Bun.file(path.join(dir, "aether.json")).text()
    expect((await Config.getGlobal()).native?.codex).toEqual({ enabled: false, limit: 3 })
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

test("shared integrations resolve only native placeholders and preserve opaque sibling text", async () => {
  await isolated(async (dir) => {
    await Bun.write(path.join(dir, "codex-path"), "codex-fixture")
    const sibling = `"latex": {
      // This build must not resolve or validate another feature's settings.
      "tectonic": { "path": "{file:missing-tectonic-path}" },
      "future": ["{env:AETHER_UNSET_SIBLING}", 42]
    }`
    const source = `{
      ${sibling},
      "native": { "codex": { "enabled": false, "limit": 2, "path": "{file:codex-path}" } }
    }`
    const file = path.join(dir, "aether.integrations.jsonc")
    await Bun.write(file, source)
    const current = await Config.getGlobal()
    expect(current.native?.codex).toEqual({ enabled: false, limit: 2, path: "codex-fixture" })
    expect(current).not.toHaveProperty("latex")
    expect(await Bun.file(file).text()).toBe(source)
    const result = await Config.updateGlobal({ native: { codex: { limit: 4 } } })
    expect(result.native?.codex).toEqual({ enabled: false, limit: 4, path: "codex-fixture" })
    expect(result).not.toHaveProperty("latex")
    expect(await Config.getGlobal()).not.toHaveProperty("latex")
    expect(await Bun.file(file).text()).toContain(sibling)
    expect((await read(dir, "aether.integrations.jsonc")).native?.codex?.path).toBe("{file:codex-path}")
    expect(await Bun.file(path.join(dir, "aether.json")).exists()).toBe(false)
  })
})

test("sibling-only integrations stay byte-identical during ordinary config saves", async () => {
  await isolated(async (dir) => {
    const file = path.join(dir, "aether.integrations.jsonc")
    const source = '{\n  // Opaque sibling data.\n  "latex": ["{file:missing}", null]\n}\n'
    await Bun.write(file, source)
    expect(await Config.getGlobal()).toEqual({})
    const result = await Config.updateGlobal({ model: "test/model" })
    expect(result.model).toBe("test/model")
    expect(result).not.toHaveProperty("latex")
    expect(await Bun.file(file).text()).toBe(source)
    expect(await read(dir, "aether.json")).toEqual({ $schema: schema, model: "test/model" })
  })
})

test("native validation still rejects invalid settings in the shared envelope", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.integrations.jsonc", {
      native: { codex: { limit: 17 } },
      latex: { path: "{file:missing}" },
    })
    const file = path.join(dir, "aether.integrations.jsonc")
    const before = await Bun.file(file).text()
    await expect(Config.getGlobal()).rejects.toMatchObject({ name: "ConfigInvalidError" })
    expect(await Bun.file(file).text()).toBe(before)
  })
})

test("unmigrated mixed standard config is rejected without removing sibling fields", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.jsonc", {
      native: { codex: { enabled: false } },
      latex: { tectonic: { path: "tectonic" } },
    })
    const file = path.join(dir, "aether.jsonc")
    const before = await Bun.file(file).text()
    await expect(Config.getGlobal()).rejects.toMatchObject({ name: "ConfigInvalidError" })
    await expect(Config.updateGlobal({ native: { codex: { limit: 3 } } })).rejects.toMatchObject({
      name: "ConfigInvalidError",
    })
    expect(await Bun.file(file).text()).toBe(before)
    expect(await Bun.file(path.join(dir, "aether.integrations.jsonc")).exists()).toBe(false)
  })
})

test("integration-only saves create no standard config and merge native settings", async () => {
  await isolated(async (dir) => {
    await Config.updateGlobal({
      native: { codex: { enabled: false, limit: 2 } },
    })
    const result = await Config.updateGlobal({ native: { codex: { limit: 4 } } })
    expect(result.native?.codex).toEqual({ enabled: false, limit: 4 })
    expect(result).not.toHaveProperty("latex")
    expect(await read(dir, "aether.integrations.jsonc")).toEqual(result)
    expect(await Bun.file(path.join(dir, "aether.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, "aether.jsonc")).exists()).toBe(false)
  })
})

test("ordinary saves never copy integrations into a newly created standard config", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.integrations.jsonc", {
      native: { codex: { limit: 2 } },
      latex: { tectonic: { path: "tectonic" } },
    })
    const result = await Config.updateGlobal({ model: "test/model" })
    expect(result.native?.codex?.limit).toBe(2)
    expect(result).not.toHaveProperty("latex")
    expect(result.model).toBe("test/model")
    expect(await read(dir, "aether.json")).toEqual({ $schema: schema, model: "test/model" })
    expect((await read(dir, "aether.integrations.jsonc")).latex).toEqual({ tectonic: { path: "tectonic" } })
  })
})

test("saving migrates all active standard files, preserves comments and ignores shadowed legacy files", async () => {
  await isolated(async (dir) => {
    await save(dir, "config.json", { native: { codex: { limit: 1 } } })
    await save(dir, "aether.json", { native: { codex: { limit: 2 } }, model: "test/model" })
    await Bun.write(
      path.join(dir, "aether.jsonc"),
      `{
      "$schema": "${schema}",
      // Preserve this provider and its comment.
      "provider": { "openai": { "options": { "baseURL": "https://example.test" } } },
      "native": { "codex": { "enabled": false, "limit": 3, "path": "{env:AETHER_INTEGRATION_TEST_PATH}" } }
    }`,
    )
    await save(dir, "opencode.json", { native: { codex: { limit: 16 } } })
    await save(dir, "aether.integrations.jsonc", { native: { codex: { limit: 4 } } })
    const inactive = await Bun.file(path.join(dir, "opencode.json")).text()
    const result = await Config.updateGlobal({ native: { codex: { enabled: true } } })
    expect(result.native?.codex?.limit).toBe(4)
    expect(result.native?.codex?.enabled).toBe(true)
    expect(result).not.toHaveProperty("latex")
    expect(result.provider?.openai?.options?.baseURL).toBe("https://example.test")
    for (const name of ["config.json", "aether.json", "aether.jsonc"]) {
      expect((await read(dir, name)).native).toBeUndefined()
      expect((await read(dir, name)).latex).toBeUndefined()
    }
    expect((await read(dir, "aether.integrations.jsonc")).native?.codex?.path).toBe(
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
    await save(dir, "opencode.jsonc", { native: { codex: { limit: 2 } }, model: "legacy/model" })
    const result = await Config.updateGlobal({ native: { codex: { enabled: false } } })
    expect(result.model).toBe("legacy/model")
    expect(result.native?.codex).toEqual({ limit: 2, enabled: false })
    expect((await read(dir, "opencode.jsonc")).native).toBeUndefined()
    expect(await Bun.file(path.join(dir, "aether.jsonc")).exists()).toBe(false)
  })
})

test("ordinary JSONC saves migrate integrations without deleting providers", async () => {
  await isolated(async (dir) => {
    const provider = { openai: { options: { baseURL: "https://example.test" } } }
    await save(dir, "aether.jsonc", {
      provider,
      native: { codex: { limit: 2 } },
    })
    const result = await Config.updateGlobal({ model: "test/model" })
    expect(result.provider).toEqual(provider)
    expect(result.native?.codex?.limit).toBe(2)
    expect((await read(dir, "aether.jsonc")).provider).toEqual(provider)
    expect((await read(dir, "aether.jsonc")).native).toBeUndefined()
    expect((await read(dir, "aether.jsonc")).latex).toBeUndefined()
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
        native: { codex: { limit: 2 } },
      }),
    )
    await Config.updateGlobal({ native: { codex: { enabled: false } } })
    const raw = parse(await Bun.file(path.join(dir, "aether.jsonc")).text())
    expect(raw.theme).toBe("legacy-theme")
    expect(raw.tui).toEqual({ scroll_speed: 4 })
    expect(raw.native).toBeUndefined()
    expect((await Config.getGlobal()).native?.codex).toEqual({ limit: 2, enabled: false })
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
      native: { codex: { enabled: false } },
      provider: { openai: { name: "new" } },
      provider_remove: ["removed"],
    })
    expect(result.provider).toEqual({ openai: { name: "new" }, retained: { name: "retained" } })
    expect(result.native?.codex?.enabled).toBe(false)
    expect((await read(dir, "aether.jsonc")).native).toBeUndefined()
    expect((await read(dir, "aether.jsonc")).provider_remove).toBeUndefined()
  })
})

test("concurrent saves merge integration fields without losing either update", async () => {
  await isolated(async (dir) => {
    await Promise.all([
      Config.updateGlobal({ native: { codex: { enabled: false } } }),
      Config.updateGlobal({ native: { codex: { limit: 5 } } }),
    ])
    expect((await Config.getGlobal()).native?.codex).toEqual({ enabled: false, limit: 5 })
  })
})

test("invalid mixed saves are rejected before writing either file", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.json", { model: "original/model" })
    const before = await Bun.file(path.join(dir, "aether.json")).text()
    await expect(Config.updateGlobal({ native: { codex: { limit: 17 } }, model: "new/model" })).rejects.toBeDefined()
    expect(await Bun.file(path.join(dir, "aether.json")).text()).toBe(before)
    expect(await Bun.file(path.join(dir, "aether.integrations.jsonc")).exists()).toBe(false)
  })
})

for (const exists of [false, true]) {
  test(`a failed standard-file replacement rolls back ${exists ? "existing" : "new"} integrations`, async () => {
    await isolated(async (dir) => {
      await save(dir, "aether.jsonc", { native: { codex: { limit: 2 } }, model: "original/model" })
      if (exists) await save(dir, "aether.integrations.jsonc", { native: { codex: { limit: 3 } } })
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
        await expect(Config.updateGlobal({ native: { codex: { limit: 5 } }, model: "new/model" })).rejects.toThrow(
          "Injected config replacement failure",
        )
      } finally {
        fault.mockRestore()
      }
      expect(await Bun.file(main).text()).toBe(before)
      if (prior !== undefined) expect(await Bun.file(extra).text()).toBe(prior)
      if (!exists) expect(await Bun.file(extra).exists()).toBe(false)
      expect((await Config.getGlobal()).native?.codex?.limit).toBe(exists ? 3 : 2)
      expect((await fs.readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false)
    })
  })
}

test("a failed legacy rollback retains integrations as the surviving settings copy", async () => {
  await isolated(async (dir) => {
    await save(dir, "config.json", { native: { codex: { limit: 2 } } })
    await save(dir, "aether.json", { native: { codex: { path: "codex" } } })
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
      await expect(Config.updateGlobal({ native: { codex: { enabled: false } } })).rejects.toThrow(
        "Config update and rollback failed",
      )
    } finally {
      fault.mockRestore()
    }
    expect((await read(dir, "config.json")).native).toBeUndefined()
    expect((await read(dir, "aether.integrations.jsonc")).native?.codex).toEqual({
      limit: 2,
      enabled: false,
      path: "codex",
    })
    expect((await Config.getGlobal()).native?.codex?.limit).toBe(2)
    expect((await Config.getGlobal()).native?.codex?.path).toBe("codex")
  })
})

test("a concurrent external edit is preserved and the integration update is rolled back", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.jsonc", { native: { codex: { limit: 2 } }, model: "original/model" })
    const main = path.join(dir, "aether.jsonc")
    const extra = path.join(dir, "aether.integrations.jsonc")
    const rename = fs.rename
    const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === extra) await save(dir, "aether.jsonc", { native: { codex: { limit: 2 } }, model: "external/model" })
    })
    try {
      await expect(Config.updateGlobal({ native: { codex: { limit: 5 } } })).rejects.toThrow(
        "Config changed during save",
      )
    } finally {
      fault.mockRestore()
    }
    expect((await read(dir, "aether.jsonc")).model).toBe("external/model")
    expect((await Config.getGlobal()).native?.codex?.limit).toBe(2)
    expect(await Bun.file(extra).exists()).toBe(false)
  })
})

test("rollback preserves an external edit to the already replaced integrations file", async () => {
  await isolated(async (dir) => {
    await save(dir, "aether.jsonc", { native: { codex: { limit: 2 } } })
    const main = path.join(dir, "aether.jsonc")
    const extra = path.join(dir, "aether.integrations.jsonc")
    const before = await Bun.file(main).text()
    const external = JSON.stringify({ native: { codex: { limit: 8, path: "external" } } })
    const rename = fs.rename
    const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === main) throw new Error("Injected replacement failure")
      await rename(from, to)
      if (to === extra) await Bun.write(extra, external)
    })
    try {
      await expect(Config.updateGlobal({ native: { codex: { limit: 5 } } })).rejects.toThrow(
        "Config update and rollback failed",
      )
    } finally {
      fault.mockRestore()
    }
    expect(await Bun.file(main).text()).toBe(before)
    expect(await Bun.file(extra).text()).toBe(external)
    expect((await Config.getGlobal()).native?.codex?.limit).toBe(8)
  })
})
