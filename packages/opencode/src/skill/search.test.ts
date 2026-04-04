import { afterAll, describe, expect, mock, test } from "bun:test"
import { ModelID, ProviderID } from "@/provider/schema"

mock.module("ai", () => ({
  generateObject: async (input: { messages?: Array<{ role: string; content: string }> }) => {
    const text = input.messages?.find((item) => item.role === "user")?.content ?? ""
    if (text.includes("make this writing sound more human")) {
      return {
        object: {
          items: [
            {
              id: "writer/skills@humanizer",
              relevance: "high",
              summary_zh: "把文本改得更自然。",
            },
            {
              id: "eyh0602/skillshub@paper-polish",
              relevance: "high",
              summary_zh: "润色论文。",
            },
          ],
        },
      }
    }
    return {
      object: {
        items: [],
      },
    }
  },
  generateText: async () => ({ text: "" }),
}))

mock.module("@/provider/provider", () => ({
  Provider: {
    getModel: async () => ({}),
    getLanguage: async () => ({}),
    defaultModel: async () => undefined,
    list: async () => ({}),
  },
}))

const { Catalog } = await import("./catalog")

const model = {
  providerID: ProviderID.make("mock"),
  modelID: ModelID.make("mock"),
}

afterAll(() => {
  mock.restore()
})

describe("Catalog.bench", () => {
  test("keeps translation intent for translating papers", async () => {
    const out = await Catalog.bench(
      {
        query: "找一下翻译论文的skill",
        items: [
          {
            id: "translator/skills@paper-translation",
            name: "paper-translation",
            source: "translator/skills",
            rank: "semantic",
            body: "Translate academic manuscripts and research papers while preserving scholarly terminology.",
            summary_source: "skill_md",
          },
          {
            id: "translator/skills@docs-translation",
            name: "docs-translation",
            source: "translator/skills",
            rank: "semantic",
            body: "Translate technical documentation and product docs between Chinese and English.",
            summary_source: "skill_md",
          },
          {
            id: "review/skills@manuscript-review",
            name: "manuscript-review",
            source: "review/skills",
            rank: "semantic",
            body: "Review manuscript structure and submission readiness for academic papers.",
            summary_source: "skill_md",
          },
          {
            id: "media/skills@subtitle-translation",
            name: "subtitle-translation",
            source: "media/skills",
            rank: "semantic",
            body: "Translate subtitles and captions for short-form video projects.",
            summary_source: "skill_md",
          },
        ],
      },
      model,
    )

    expect(out.main.map((item) => item.name)).toEqual(expect.arrayContaining(["paper-translation", "docs-translation"]))
    expect(out.main.map((item) => item.name)).not.toContain("subtitle-translation")
  })

  test("does not let the model promote paper polish into humanizer main results", async () => {
    const out = await Catalog.bench(
      {
        query: "make this writing sound more human",
        items: [
          {
            id: "writer/skills@humanizer",
            name: "humanizer",
            source: "writer/skills",
            rank: "exact",
            body: "Rewrite text so it sounds more natural and less AI-generated.",
            summary_source: "skill_md",
          },
          {
            id: "writer/skills@writing-humanizer",
            name: "writing-humanizer",
            source: "writer/skills",
            rank: "semantic",
            body: "Humanize drafted writing by improving flow and natural phrasing.",
            summary_source: "skill_md",
          },
          {
            id: "eyh0602/skillshub@paper-polish",
            name: "paper-polish",
            source: "eyh0602/skillshub",
            rank: "semantic",
            body: "Polish and revise academic papers in LaTeX format.",
            summary_source: "skill_md",
          },
        ],
      },
      model,
    )

    expect(out.main.map((item) => item.name)).toEqual(expect.arrayContaining(["humanizer", "writing-humanizer"]))
    expect(out.main.map((item) => item.name)).not.toContain("paper-polish")
    expect(out.more.map((item) => item.name)).toContain("paper-polish")
  })
})
