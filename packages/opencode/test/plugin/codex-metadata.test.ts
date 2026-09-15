import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { CodexModels } from "../../src/plugin/codex-models"

const empty: CodexModels.Status = {
  enabled: true,
  source: "fallback",
  checkedAt: null,
  updatedAt: null,
  etag: null,
  hash: null,
  error: null,
}

function body(value: CodexModels.Metadata = {}) {
  return JSON.stringify({ models: [{ slug: "future", visibility: "list", ...value }] })
}

beforeEach(async () => {
  await CodexModels.Test.version({
    force: true,
    fetcher: async () => new Response(JSON.stringify({ version: "0.154.0" })),
  })
})

afterEach(() => CodexModels.Test.reset())

test("preserves absent and empty controls and accepts future effort names", () => {
  expect(CodexModels.Metadata.parse({})).toEqual({})
  expect(CodexModels.Metadata.parse({ supported_reasoning_levels: [] })).toEqual({ supported_reasoning_levels: [] })
  expect(
    CodexModels.Metadata.parse({
      supported_reasoning_levels: [{ effort: "future-effort", description: "Ignored presentation text" }],
      default_reasoning_level: "future-effort",
      instructions: "Ignored remote instructions",
    }),
  ).toEqual({
    supported_reasoning_levels: [{ effort: "future-effort" }],
    default_reasoning_level: "future-effort",
  })
})

test.each([
  { display_name: "Renamed" },
  { context_window: 272000 },
  { input_modalities: ["text", "image"] },
  { supported_reasoning_levels: [{ effort: "ultra" }] },
  { supported_reasoning_levels: [] },
  { default_reasoning_level: "ultra" },
])("detects subscription metadata changes with unchanged slugs: %j", async (value) => {
  const metadata = CodexModels.Metadata.parse(value)
  const first = await CodexModels.Test.download({ previous: empty, fetcher: async () => new Response(body()) })
  const next = await CodexModels.Test.download({
    previous: first.status,
    models: first.models,
    metadata: first.metadata,
    fetcher: async () => new Response(body(metadata)),
  })
  expect(next.models).toEqual(first.models)
  expect(next.metadata.future).toEqual(metadata)
  expect(next.changed).toBe(true)
  expect(next.status.hash).not.toBe(first.status.hash)
})

test("ignores unknown fields and response order when detecting changes", async () => {
  const first = await CodexModels.Test.download({
    previous: empty,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: "zeta", visibility: "list", display_name: "Zeta", instructions: "Before" },
            { slug: "alpha", visibility: "list", display_name: "Alpha" },
          ],
        }),
      ),
  })
  const next = await CodexModels.Test.download({
    previous: first.status,
    models: first.models,
    metadata: first.metadata,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: "alpha", visibility: "list", display_name: "Alpha" },
            { slug: "hidden", visibility: "hidden", context_window: null },
            { slug: "zeta", visibility: "list", display_name: "Zeta", instructions: "After" },
          ],
        }),
      ),
  })
  expect(next.models).toEqual(["alpha", "zeta"])
  expect(next.changed).toBe(false)
  expect(next.metadata).toEqual(first.metadata)
})

test("retains metadata after an ETag 304 response", async () => {
  const first = await CodexModels.Test.download({
    previous: empty,
    fetcher: async () => new Response(body({ display_name: "Future" }), { headers: { ETag: '"same"' } }),
  })
  const next = await CodexModels.Test.download({
    previous: first.status,
    models: first.models,
    metadata: first.metadata,
    fetcher: async (_url, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"same"')
      return new Response(null, { status: 304 })
    },
  })
  expect(next.metadata).toEqual({ future: { display_name: "Future" } })
  expect(next.changed).toBe(false)
})

test("upgrades a fresh v1 cache with a complete request and writes v2 metadata", async () => {
  const identity = crypto.randomUUID()
  const file = CodexModels.Test.filepath(CodexModels.Test.key(identity))
  await Bun.write(
    file,
    JSON.stringify({
      version: 1,
      clientVersion: "0.154.0",
      checkedAt: Date.now(),
      updatedAt: 1,
      etag: '"legacy"',
      hash: CodexModels.Test.key("future"),
      error: null,
      models: ["future"],
    }),
  )
  try {
    const allowed = await CodexModels.activate({
      identity,
      seed: "secret-token",
      fetcher: async (_url, init) => {
        expect(new Headers(init?.headers).has("if-none-match")).toBe(false)
        return new Response(body({ display_name: "Future", supported_reasoning_levels: [{ effort: "ultra" }] }))
      },
    })
    expect(allowed?.has("future")).toBe(true)
    await CodexModels.refresh({ force: true })
    expect(CodexModels.metadata("future")).toEqual({
      display_name: "Future",
      supported_reasoning_levels: [{ effort: "ultra" }],
    })
    const saved = await Bun.file(file).json()
    expect(saved.version).toBe(2)
    expect(saved.metadata).toEqual(CodexModels.catalog())
    expect(JSON.stringify(saved)).not.toContain(identity)
    expect(JSON.stringify(saved)).not.toContain("secret-token")
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("loads v2 metadata offline and publishes changes to metadata alone", async () => {
  const identity = crypto.randomUUID()
  const file = CodexModels.Test.filepath(CodexModels.Test.key(identity))
  let value = { display_name: "Before", supported_reasoning_levels: [{ effort: "low" }] }
  let updates = 0
  const stop = CodexModels.onUpdated(() => updates++)
  try {
    await CodexModels.activate({ identity, seed: "secret", fetcher: async () => new Response(body(value)) })
    await CodexModels.refresh({ force: true })
    expect(updates).toBe(1)
    value = { display_name: "After", supported_reasoning_levels: [{ effort: "ultra" }] }
    await CodexModels.refresh({ force: true })
    expect(updates).toBe(2)
    const snapshot = CodexModels.catalog()
    snapshot.future.display_name = "External mutation"
    CodexModels.metadata("future")!.supported_reasoning_levels!.push({ effort: "mutation" })
    expect(CodexModels.metadata("future")).toEqual(value)

    CodexModels.Test.reset()
    await CodexModels.Test.version({
      force: true,
      fetcher: async () => new Response(JSON.stringify({ version: "0.154.0" })),
    })
    const allowed = await CodexModels.activate({
      identity,
      seed: "rotated-secret",
      fetcher: async () => new Response("offline", { status: 503 }),
    })
    expect(allowed?.has("future")).toBe(true)
    expect(CodexModels.metadata("future")).toEqual(value)
    await CodexModels.refresh({ force: true })
    expect(CodexModels.status().error).toContain("503")
    expect(CodexModels.metadata("future")).toEqual(value)
    expect(updates).toBe(2)
  } finally {
    stop()
    await fs.rm(file, { force: true })
  }
})

test("keeps metadata isolated when a previous account finishes after a switch", async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let updates = 0
  const stop = CodexModels.onUpdated(() => updates++)
  try {
    await CodexModels.activate({
      seed: "old-account",
      fetcher: async () => {
        await pending
        return new Response(body({ display_name: "Old account" }))
      },
    })
    const old = CodexModels.refresh({ force: true })
    await CodexModels.activate({
      seed: "new-account",
      fetcher: async () => new Response(body({ display_name: "New account" })),
    })
    await CodexModels.refresh({ force: true })
    release()
    await old
    expect(updates).toBe(1)
    expect(CodexModels.catalog()).toEqual({ future: { display_name: "New account" } })
    expect(CodexModels.metadata("unknown")).toBeUndefined()
    expect(CodexModels.metadata("constructor")).toBeUndefined()
  } finally {
    release()
    stop()
  }
})
