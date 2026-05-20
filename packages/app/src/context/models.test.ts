import { describe, expect, test } from "bun:test"
import { setModelsVisibilityInDisabledList } from "./models-visibility"

describe("model visibility config", () => {
  test("disables multiple provider models in one update", () => {
    const next = setModelsVisibilityInDisabledList(
      ["openai/gpt-5"],
      [
        { providerID: "alibaba", modelID: "qwen-max" },
        { providerID: "alibaba", modelID: "qwen-plus" },
      ],
      false,
    )

    expect(next).toEqual(["openai/gpt-5", "alibaba/qwen-max", "alibaba/qwen-plus"])
  })

  test("does not duplicate disabled models", () => {
    const next = setModelsVisibilityInDisabledList(
      ["alibaba/qwen-max"],
      [
        { providerID: "alibaba", modelID: "qwen-max" },
        { providerID: "alibaba", modelID: "qwen-max" },
      ],
      false,
    )

    expect(next).toEqual(["alibaba/qwen-max"])
  })

  test("enables provider models by removing provider and legacy bare ids", () => {
    const next = setModelsVisibilityInDisabledList(
      ["alibaba/qwen-max", "qwen-plus", "openai/gpt-5"],
      [
        { providerID: "alibaba", modelID: "qwen-max" },
        { providerID: "alibaba", modelID: "qwen-plus" },
      ],
      true,
    )

    expect(next).toEqual(["openai/gpt-5"])
  })
})
