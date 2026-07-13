import { afterEach, expect, test } from "bun:test"
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

function body(models: unknown[]) {
  return JSON.stringify({
    models,
    ignored: true,
  })
}

function model(slug: string, input?: { visibility?: string; version?: string | null }) {
  return {
    slug,
    visibility: input?.visibility ?? "list",
    minimal_client_version: input?.version ?? null,
    use_responses_lite: true,
  }
}

afterEach(() => CodexModels.Test.reset())

test("accepts only compatible visible slugs and ignores protocol fields", () => {
  const result = CodexModels.Test.parse(
    body([
      model("zeta"),
      model("alpha", { version: "0.143.0" }),
      model("future", { version: "0.145.0" }),
      model("hidden", { visibility: "hidden" }),
      model("invalid", { version: "next" }),
      model("alpha"),
    ]),
  )
  expect(result).toEqual(["alpha", "zeta"])
})

test("downloads changes and sends ETag for 304", async () => {
  let count = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      count += 1
      if (count === 1) return new Response(body([model("gpt-5.6-sol")]), { headers: { ETag: '"one"' } })
      expect(req.headers.get("if-none-match")).toBe('"one"')
      return new Response(null, { status: 304 })
    },
  })
  const fetcher = (_url: RequestInfo | URL, init?: RequestInit) => fetch(server.url, init)

  try {
    const first = await CodexModels.Test.download({ previous: empty, fetcher })
    const second = await CodexModels.Test.download({
      previous: first.status,
      models: first.models,
      fetcher,
    })
    expect(first.changed).toBe(true)
    expect(first.status.etag).toBe('"one"')
    expect(second.changed).toBe(false)
    expect(second.models).toEqual(["gpt-5.6-sol"])
  } finally {
    server.stop(true)
  }
})

test("does not mark matching content changed without ETag", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(body([model("gpt-5.6-sol")])) })
  const fetcher = (_url: RequestInfo | URL, init?: RequestInit) => fetch(server.url, init)

  try {
    const first = await CodexModels.Test.download({ previous: empty, fetcher })
    const second = await CodexModels.Test.download({
      previous: first.status,
      models: first.models,
      fetcher,
    })
    expect(second.changed).toBe(false)
    expect(second.status.etag).toBeNull()
    expect(second.status.updatedAt).toBe(first.status.updatedAt)
  } finally {
    server.stop(true)
  }
})

test.each([
  ["401", () => new Response("unauthorized", { status: 401 })],
  ["403", () => new Response("forbidden", { status: 403 })],
  ["invalid JSON", () => new Response("{")],
  ["invalid schema", () => new Response(JSON.stringify({ models: [{ slug: "model" }] }))],
  ["empty visible list", () => new Response(body([model("hidden", { visibility: "hidden" })]))],
])("rejects %s catalogs", async (_name, response) => {
  await expect(
    CodexModels.Test.download({
      previous: empty,
      fetcher: async () => response(),
    }),
  ).rejects.toBeDefined()
})

test("times out without replacing the last valid catalog", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(100)
      return new Response(body([model("late")]))
    },
  })

  try {
    await expect(
      CodexModels.Test.download({
        previous: { ...empty, hash: "saved", updatedAt: 1 },
        models: ["saved"],
        timeout: 10,
        fetcher: (_url, init) => fetch(server.url, init),
      }),
    ).rejects.toBeDefined()
  } finally {
    server.stop(true)
  }
})

test("shares one network task across concurrent refreshes", async () => {
  let count = 0
  let release = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  await CodexModels.activate({
    seed: "concurrent",
    async fetcher() {
      count += 1
      await wait
      return new Response(body([model("model")]))
    },
  })

  const first = CodexModels.refresh({ force: true })
  const second = CodexModels.refresh({ force: true })
  release()
  await Promise.all([first, second])
  expect(first).toBe(second)
  expect(count).toBe(1)
})

test("force refresh follows a freshness-skipped startup task", async () => {
  let count = 0
  CodexModels.Test.prime({ seed: "force", models: ["cached"] })
  await CodexModels.activate({
    seed: "force",
    fetcher: async () => {
      count += 1
      return new Response(body([model("fresh")]))
    },
  })
  const result = await CodexModels.refresh({ force: true })

  expect(count).toBe(1)
  expect(result.hash).toBe(CodexModels.Test.key("fresh"))
})

test("uses an account-hashed cache without storing credentials", async () => {
  const identity = `account-${crypto.randomUUID()}`
  const token = `token-${crypto.randomUUID()}`
  const file = CodexModels.Test.filepath(CodexModels.Test.key(identity))
  await fs.rm(file, { force: true })

  try {
    await CodexModels.activate({
      identity,
      seed: token,
      fetcher: async () => new Response(body([model("cached")]), { headers: { ETag: '"cache"' } }),
    })
    const result = await CodexModels.refresh({ force: true })
    expect(result.error).toBeNull()
    const saved = await Bun.file(file).text()
    expect(saved).not.toContain(identity)
    expect(saved).not.toContain(token)

    CodexModels.Test.reset()
    const models = await CodexModels.activate({
      identity,
      seed: token,
      fetcher: async () => new Response("offline", { status: 503 }),
    })
    expect(models?.has("cached")).toBe(true)
    expect(CodexModels.status()).toMatchObject({ source: "cache", hash: result.hash })
    await CodexModels.refresh({ force: true })
    expect(CodexModels.status()).toMatchObject({ source: "cache", hash: result.hash })
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("does not publish an old account result after account switch", async () => {
  let release = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let updates = 0
  const unsub = CodexModels.onUpdated(() => updates++)

  await CodexModels.activate({
    seed: "old-account",
    async fetcher() {
      await wait
      return new Response(body([model("old")]))
    },
  })
  const old = CodexModels.refresh({ force: true })

  await CodexModels.activate({
    seed: "new-account",
    fetcher: async () => new Response(body([model("new")])),
  })
  await CodexModels.refresh({ force: true })
  release()
  await old

  expect(updates).toBe(1)
  expect(CodexModels.status().hash).toBe(CodexModels.Test.key("new"))
  unsub()
})
