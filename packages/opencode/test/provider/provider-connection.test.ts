import { test, expect } from "bun:test"
import z from "zod"

import { EmbeddingModel, model, merge } from "../../src/server/routes/provider"

type Entry = z.infer<typeof EmbeddingModel>

const empty = () => new Map<string, Entry>()

test("remote embedding model without name uses id as label", () => {
  const m = empty()
  model(m, "alibaba-cn", "qwen3.7-text-embedding", undefined, "remote")
  model(m, "alibaba-cn", "qwen3.7-text-embedding-flash", undefined, "remote")
  expect(m.get("qwen3.7-text-embedding")?.name).toBe("qwen3.7-text-embedding")
  expect(m.get("qwen3.7-text-embedding-flash")?.name).toBe("qwen3.7-text-embedding-flash")
})

test("vendor whitelist merges canonical entries alongside remote models", () => {
  for (const vendor of ["qwen", "dashscope", "alibaba", "alibaba-cn"]) {
    const m = empty()
    model(m, vendor, "qwen3.7-text-embedding", undefined, "remote")
    merge(m, vendor)
    const ids = [...m.keys()]
    expect(ids).toContain("text-embedding-v1")
    expect(ids).toContain("text-embedding-v2")
    expect(ids).toContain("text-embedding-v3")
    expect(ids).toContain("text-embedding-v4")
    expect(ids).toContain("qwen3.7-text-embedding")
    expect(m.get("text-embedding-v3")).toEqual({
      id: "text-embedding-v3",
      name: "text-embedding-v3",
      dimensions: 1024,
      provider: "Qwen",
      source: "whitelist",
    })
    expect(m.get("text-embedding-v1")?.dimensions).toBe(1536)
  }
})

test("whitelist merge does not overwrite already resolved ids", () => {
  const m = empty()
  model(m, "alibaba-cn", "alibaba-cn/text-embedding-v3", "Remote V3", "remote")
  merge(m, "alibaba-cn")
  const entry = m.get("text-embedding-v3")
  expect(entry?.name).toBe("Remote V3")
  expect(entry?.source).toBe("remote")
  expect([...m.keys()].sort()).toEqual([
    "text-embedding-v1",
    "text-embedding-v2",
    "text-embedding-v3",
    "text-embedding-v4",
  ])
})

test("unknown provider with empty list falls back to global whitelist", () => {
  const m = empty()
  merge(m, "no-such-provider")
  expect(m.get("text-embedding-3-small")?.source).toBe("whitelist")
  expect(m.get("text-embedding-3-large")?.dimensions).toBe(3072)
  expect(m.get("gemini-embedding-001")?.provider).toBe("Google")
  expect(m.has("text-embedding-v2")).toBe(false)
})

test("unknown provider with resolved models gets no global fallback", () => {
  const m = empty()
  model(m, "no-such-provider", "my-embedding", undefined, "remote")
  merge(m, "no-such-provider")
  expect(m.size).toBe(1)
})

test("known provider without vendor list gets no whitelist fallback", () => {
  const m = empty()
  merge(m, "anthropic")
  expect(m.size).toBe(0)
  model(m, "anthropic", "some-embedding", undefined, "remote")
  merge(m, "anthropic")
  expect(m.size).toBe(1)
})

test("openai vendor whitelist keeps only openai models", () => {
  const m = empty()
  merge(m, "openai")
  expect(m.has("text-embedding-v1")).toBe(false)
  expect(m.has("text-embedding-3-small")).toBe(true)
  expect(m.has("text-embedding-3-large")).toBe(true)
})
