import { describe, expect, test } from "bun:test"
import { resolveModelSelection } from "./model-selection"

const removed = { providerID: "opencode", modelID: "big-pickle" }
const paid = { providerID: "opencode", modelID: "claude-sonnet-4-5" }
const other = { providerID: "local", modelID: "big-pickle" }
const valid = (model: typeof other) => model.providerID === other.providerID || model.modelID === paid.modelID

describe("model selection after catalog changes", () => {
  test("unconfigured users have no selection when no chat model is available", () => {
    expect(
      resolveModelSelection({ candidates: [], valid: () => false, fallback: () => undefined, ready: true }),
    ).toEqual({ model: undefined, unavailable: false })
  })

  test.each([0, 1, 2, 3])(
    "blocks an unavailable OpenCode choice at priority %i instead of billing a fallback",
    (index) => {
      const candidates = Array.from({ length: index }, () => undefined)
      expect(
        resolveModelSelection({
          candidates: [...candidates, removed, other],
          valid,
          fallback: () => paid,
          ready: true,
        }),
      ).toEqual({ model: undefined, unavailable: true })
    },
  )

  test("preserves a valid explicit choice before stale agent, default or recent selections", () => {
    expect(resolveModelSelection({ candidates: [other, removed], valid, fallback: () => paid, ready: true })).toEqual({
      model: other,
      unavailable: false,
    })
  })

  test("retains paid OpenCode and other providers with the same model name", () => {
    for (const model of [paid, other]) {
      expect(resolveModelSelection({ candidates: [model], valid, fallback: () => undefined, ready: true })).toEqual({
        model,
        unavailable: false,
      })
    }
  })

  test("waits for loaded catalogs before declaring an old choice unavailable", () => {
    expect(
      resolveModelSelection({ candidates: [removed], valid: () => false, fallback: () => paid, ready: false }),
    ).toEqual({ model: undefined, unavailable: false })
    expect(
      resolveModelSelection({ candidates: [removed], valid: () => true, fallback: () => paid, ready: true }),
    ).toEqual({ model: removed, unavailable: false })
  })

  test("does not use a seeded global paid model while project choices are still loading", () => {
    expect(resolveModelSelection({ candidates: [paid], valid, fallback: () => paid, ready: false })).toEqual({
      model: undefined,
      unavailable: false,
    })
    expect(resolveModelSelection({ candidates: [], valid, fallback: () => paid, ready: false })).toEqual({
      model: undefined,
      unavailable: false,
    })
  })

  test("a deliberate replacement takes precedence without deleting stale preferences", () => {
    const candidates = [removed]
    expect(
      resolveModelSelection({ candidates: [other, ...candidates], valid, fallback: () => paid, ready: true }).model,
    ).toEqual(other)
    expect(candidates).toEqual([removed])
  })

  test("keeps the previous fallback behavior for missing models from other providers", () => {
    expect(
      resolveModelSelection({
        candidates: [{ providerID: "old", modelID: "removed" }],
        valid,
        fallback: () => other,
        ready: true,
      }).model,
    ).toEqual(other)
  })
})
