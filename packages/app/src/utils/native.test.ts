import { describe, expect, test } from "bun:test"
import { nativeEffort, nativeModel } from "./native"

const models = [
  { id: "first", name: "First", default: false, efforts: ["low"] },
  { id: "preferred", name: "Preferred", default: true, efforts: ["medium", "high"], effort: "medium" },
]

describe("native model selection", () => {
  test("uses the engine's advertised default without requiring an API provider", () => {
    expect(nativeModel(models)?.id).toBe("preferred")
    expect(nativeModel([models[0]])?.id).toBe("first")
    expect(nativeModel([])).toBeUndefined()
  })

  test("preserves an explicit selection and never silently replaces an unavailable model", () => {
    expect(nativeModel(models, "first")?.id).toBe("first")
    expect(nativeModel(models, "removed")).toBeUndefined()
  })

  test("only submits supported reasoning settings", () => {
    expect(nativeEffort(models[1], "high")).toBe("high")
    expect(nativeEffort(models[1], "unsupported")).toBe("medium")
    expect(nativeEffort(models[0], "high")).toBeUndefined()
    expect(nativeEffort(undefined, "high")).toBeUndefined()
  })
})
