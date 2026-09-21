import { describe, expect, test } from "bun:test"
import { mayNotSupport } from "./knowledge-embedding"

// 独立于 knowledge-embedding.test.ts：该文件位于 .github/cicd-protected-files.txt
// 保护名单中，外部 PR 不可修改，故 mayNotSupport 的断言放在这里。
describe("mayNotSupport", () => {
  test("hides the warning when any model comes from runtime, remote, or config", () => {
    // Alibaba (China): remote (qwen3.7-*) + whitelist (v1~v4) -> provider does offer embeddings
    expect(
      mayNotSupport([
        { id: "qwen3.7-text-embedding", name: "qwen3.7-text-embedding", source: "remote" },
        { id: "text-embedding-v4", name: "text-embedding-v4", source: "whitelist" },
      ]),
    ).toBe(false)

    // providers with embedding models in the models.dev catalog
    expect(mayNotSupport([{ id: "text-embedding-3-small", name: "text-embedding-3-small", source: "runtime" }])).toBe(
      false,
    )

    // user-configured models
    expect(mayNotSupport([{ id: "my-model", name: "my-model", source: "config" }])).toBe(false)
  })

  test("shows the warning when every model is a whitelist guess", () => {
    expect(
      mayNotSupport([
        { id: "text-embedding-v3", name: "text-embedding-v3", source: "whitelist" },
        { id: "text-embedding-v4", name: "text-embedding-v4", source: "whitelist" },
      ]),
    ).toBe(true)

    // nothing resolved at all -> still uncertain
    expect(mayNotSupport([])).toBe(true)
  })
})
