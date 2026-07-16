import { expect, test } from "bun:test"
import path from "path"
import { ModelsDev } from "../../src/provider/models"
import { tmpdir } from "../fixture/fixture"

function data(options = false) {
  return JSON.stringify({
    test: {
      id: "test",
      name: "Test",
      doc: "https://example.com/docs",
      env: ["TEST_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      models: {
        model: {
          id: "model",
          name: "Model",
          description: "Test model",
          release_date: "2026-07-13",
          last_updated: "2026-07-13",
          attachment: false,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          temperature: true,
          tool_call: true,
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          open_weights: false,
          ...(options ? { options: {} } : {}),
        },
      },
    },
  })
}

const catalog = data()

const empty: ModelsDev.Status = {
  source: "none",
  checkedAt: null,
  updatedAt: null,
  etag: null,
  hash: null,
  error: null,
}

test("downloads changed data and uses ETag for 304", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "models.json")
  let count = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      count += 1
      if (count === 1) return new Response(catalog, { headers: { ETag: '"catalog-1"' } })
      expect(req.headers.get("if-none-match")).toBe('"catalog-1"')
      return new Response(null, { status: 304 })
    },
  })

  try {
    const first = await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous: empty,
      fetcher: fetch,
    })
    const second = await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous: first,
      fetcher: fetch,
    })

    expect(first.changed).toBe(true)
    expect(first.etag).toBe('"catalog-1"')
    expect(second.changed).toBe(false)
    expect(second.source).toBe("cache")
    expect(await Bun.file(file).text()).toBe(catalog)
  } finally {
    server.stop(true)
  }
})

test("accepts models.dev records without options", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "models.json")
  const body = data(false)
  const server = Bun.serve({ port: 0, fetch: () => new Response(body) })

  try {
    const result = await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous: empty,
      fetcher: fetch,
    })
    expect(result.changed).toBe(true)
  } finally {
    server.stop(true)
  }
})

test("does not rewrite a matching response without ETag", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "models.json")
  const server = Bun.serve({ port: 0, fetch: () => new Response(catalog) })

  try {
    const first = await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous: empty,
      fetcher: fetch,
    })
    const stat = await Bun.file(file).stat()
    const second = await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous: first,
      fetcher: fetch,
    })

    expect(second.changed).toBe(false)
    expect((await Bun.file(file).stat()).mtime.getTime()).toBe(stat.mtime.getTime())
  } finally {
    server.stop(true)
  }
})

test("drops a stale ETag when a 200 response omits it", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "models.json")
  let count = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      count += 1
      if (count === 1) return new Response(catalog, { headers: { ETag: '"catalog-1"' } })
      return new Response(catalog)
    },
  })

  try {
    const first = await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous: empty,
      fetcher: fetch,
    })
    const second = await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous: first,
      fetcher: fetch,
    })

    expect(first.etag).toBe('"catalog-1"')
    expect(second.etag).toBeNull()
    expect(second.changed).toBe(false)
  } finally {
    server.stop(true)
  }
})

test("force bypasses the freshness window", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "models.json")
  await Bun.write(file, catalog)
  let count = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      count += 1
      return new Response(catalog)
    },
  })

  try {
    const previous = { ...empty, source: "cache" as const }
    await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: false,
      previous,
      fetcher: fetch,
    })
    expect(count).toBe(0)

    await ModelsDev.Test.download({
      file,
      url: server.url.toString().replace(/\/$/, ""),
      force: true,
      previous,
      fetcher: fetch,
    })
    expect(count).toBe(1)
  } finally {
    server.stop(true)
  }
})

test.each([
  ["invalid JSON", "{"],
  ["invalid schema", JSON.stringify({ test: { id: "test" } })],
])("rejects %s without replacing the last valid cache", async (_name, body) => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "models.json")
  await Bun.write(file, catalog)
  const server = Bun.serve({ port: 0, fetch: () => new Response(body) })

  try {
    await expect(
      ModelsDev.Test.download({
        file,
        url: server.url.toString().replace(/\/$/, ""),
        force: true,
        previous: empty,
        fetcher: fetch,
      }),
    ).rejects.toBeDefined()
    expect(await Bun.file(file).text()).toBe(catalog)
  } finally {
    server.stop(true)
  }
})

test("times out without replacing the last valid cache", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "models.json")
  await Bun.write(file, catalog)
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(100)
      return new Response("late")
    },
  })

  try {
    await expect(
      ModelsDev.Test.download({
        file,
        url: server.url.toString().replace(/\/$/, ""),
        force: true,
        previous: empty,
        fetcher: fetch,
        timeout: 10,
      }),
    ).rejects.toBeDefined()
    expect(await Bun.file(file).text()).toBe(catalog)
  } finally {
    server.stop(true)
  }
})

test("shares one in-flight refresh task", async () => {
  await ModelsDev.refresh()
  let count = 0
  let done = () => {}
  const wait = new Promise<void>((resolve) => {
    done = resolve
  })
  const run = async () => {
    count += 1
    await wait
    return { ...empty, changed: false }
  }

  const first = ModelsDev.Test.once(run)
  const second = ModelsDev.Test.once(run)
  done()
  await Promise.all([first, second])

  expect(first).toBe(second)
  expect(count).toBe(1)
})
