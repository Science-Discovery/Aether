import { describe, expect, test } from "bun:test"
import { listURLs } from "../../src/knowledge/embedding"

describe("listURLs", () => {
  test("versioned base yields only the direct embeddings URL", () => {
    // Regression: stripping the version produced a bogus .../compatible-mode/embeddings
    // URL whose 404 poisoned the pooled connection and broke the batch-size retry.
    expect(listURLs("https://dashscope.aliyuncs.com/compatible-mode/v1")).toEqual([
      "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    ])
    expect(listURLs("https://api.openai.com/v1/")).toEqual(["https://api.openai.com/v1/embeddings"])
    expect(listURLs("https://example.com/api/v2")).toEqual(["https://example.com/api/v2/embeddings"])
  })

  test("unversioned base also tries the /v1 variant", () => {
    expect(listURLs("https://example.com")).toEqual([
      "https://example.com/embeddings",
      "https://example.com/v1/embeddings",
    ])
    expect(listURLs("https://example.com/compatible-mode/")).toEqual([
      "https://example.com/compatible-mode/embeddings",
      "https://example.com/compatible-mode/v1/embeddings",
    ])
  })
})
