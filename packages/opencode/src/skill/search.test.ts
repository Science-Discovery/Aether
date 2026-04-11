import { describe, expect, test } from "bun:test"
import { split, type SearchResult } from "./catalog"

function item(input: Partial<SearchResult> & Pick<SearchResult, "id" | "name" | "provider" | "rank">): SearchResult {
  return {
    installed: false,
    ...input,
  }
}

describe("split", () => {
  test("keeps paper translation skills in main for translation queries", () => {
    expect(
      split(
        "找一下翻译论文的skill",
        item({
          id: "translator/skills@paper-translation",
          name: "paper-translation",
          provider: "external",
          rank: "semantic",
          source: "translator/skills",
        }),
        "Translate academic manuscripts and research papers while preserving scholarly terminology.",
      ),
    ).toBe("main")

    expect(
      split(
        "找一下翻译论文的skill",
        item({
          id: "translator/skills@docs-translation",
          name: "docs-translation",
          provider: "external",
          rank: "semantic",
          source: "translator/skills",
        }),
        "Translate technical documentation and product docs between Chinese and English.",
      ),
    ).toBe("main")

    expect(
      split(
        "找一下翻译论文的skill",
        item({
          id: "media/skills@subtitle-translation",
          name: "subtitle-translation",
          provider: "external",
          rank: "semantic",
          source: "media/skills",
        }),
        "Translate subtitles and captions for short-form video projects.",
      ),
    ).toBeUndefined()
  })

  test("keeps paper polish out of humanizer main results", () => {
    expect(
      split(
        "make this writing sound more human",
        item({
          id: "writer/skills@humanizer",
          name: "humanizer",
          provider: "external",
          rank: "exact",
          source: "writer/skills",
        }),
        "Rewrite text so it sounds more natural and less AI-generated.",
      ),
    ).toBe("main")

    expect(
      split(
        "make this writing sound more human",
        item({
          id: "writer/skills@writing-humanizer",
          name: "writing-humanizer",
          provider: "external",
          rank: "semantic",
          source: "writer/skills",
        }),
        "Humanize drafted writing by improving flow and natural phrasing.",
      ),
    ).toBe("main")

    expect(
      split(
        "make this writing sound more human",
        item({
          id: "eyh0602/skillshub@paper-polish",
          name: "paper-polish",
          provider: "external",
          rank: "semantic",
          source: "eyh0602/skillshub",
        }),
        "Polish and revise academic papers in LaTeX format.",
      ),
    ).toBe("more")
  })
})
