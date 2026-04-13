import { describe, expect, test } from "bun:test"
import { parseWeb, queries, split, type SearchResult } from "./catalog"

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
    ).toBe("more")

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
    ).toBe("more")

    expect(
      split(
        "translate an academic manuscript",
        item({
          id: "yrom/arxiv-paper-translator@arxiv-paper-translator",
          name: "arxiv-paper-translator",
          provider: "external",
          rank: "semantic",
          source: "yrom/arxiv-paper-translator",
        }),
        "Translate arXiv papers and research manuscripts into another language while preserving scientific terminology.",
      ),
    ).toBe("main")

    expect(
      split(
        "translate technical docs",
        item({
          id: "belumume/claude-skills@rtl-document-translation",
          name: "rtl-document-translation",
          provider: "external",
          rank: "semantic",
          source: "belumume/claude-skills",
        }),
        "Translate technical documentation and product documents, including localized right-to-left output.",
      ),
    ).toBe("main")
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
    ).toBeUndefined()
  })

  test("keeps narrative plot and motion graphics out of scientific visualization main results", () => {
    expect(
      split(
        "科研绘图",
        item({
          id: "studio/skills@motion-designer",
          name: "motion-designer",
          provider: "external",
          rank: "semantic",
          source: "studio/skills",
        }),
        "Advanced motion designer specialized in creating video specs and motion graphics for animated scenes.",
      ),
    ).toBeUndefined()

    expect(
      split(
        "科研绘图",
        item({
          id: "writer/skills@natural-dialogue-techniques",
          name: "natural-dialogue-techniques",
          provider: "external",
          rank: "semantic",
          source: "writer/skills",
        }),
        "Provides techniques for natural dialogue that reveals character and advances plot.",
      ),
    ).toBeUndefined()
  })

  test("keeps academic review helpers out of translation main results", () => {
    expect(
      split(
        "translate an academic manuscript",
        item({
          id: "review/skills@manuscript-review",
          name: "manuscript-review",
          provider: "external",
          rank: "semantic",
          source: "review/skills",
        }),
        "Review academic manuscripts and provide proofreading and paper feedback.",
      ),
    ).toBe("more")

    expect(
      split(
        "translate an academic manuscript",
        item({
          id: "review/skills@scientific-manuscript-review",
          name: "scientific-manuscript-review",
          provider: "external",
          rank: "semantic",
          source: "review/skills",
        }),
        "Review scientific manuscripts, proofread papers, and improve academic writing quality.",
      ),
    ).toBe("more")

    expect(
      split(
        "translate an academic manuscript",
        item({
          id: "review/skills@scientific-manuscript-review",
          name: "scientific-manuscript-review",
          provider: "external",
          rank: "semantic",
          source: "review/skills",
        }),
        "Review scientific manuscripts, translate academic papers, and improve academic writing quality.",
      ),
    ).toBe("more")
  })

  test("keeps manuscript translation hits in main without page body when probe and name are strong", () => {
    expect(
      split(
        "translate an academic manuscript",
        item({
          id: "canyangliunian/agent-skills@academic-translate",
          name: "academic-translate",
          provider: "external",
          rank: "semantic",
          source: "canyangliunian/agent-skills",
          probe: "academic translation",
        }),
      ),
    ).toBe("main")

    expect(
      split(
        "translate technical docs",
        item({
          id: "belumume/claude-skills@rtl-document-translation",
          name: "rtl-document-translation",
          provider: "external",
          rank: "semantic",
          source: "belumume/claude-skills",
          probe: "docs translation",
        }),
      ),
    ).toBe("main")
  })

  test("keeps non-manuscript polish tools out of paper polish main results", () => {
    expect(
      split(
        "paper polish skill",
        item({
          id: "code/skills@code-polish",
          name: "code-polish",
          provider: "external",
          rank: "semantic",
          source: "code/skills",
        }),
        "Polish and refactor source code for readability and consistency.",
      ),
    ).toBe("more")

    expect(
      split(
        "paper polish skill",
        item({
          id: "ux/skills@ui-ux-polish",
          name: "ui-ux-polish",
          provider: "external",
          rank: "semantic",
          source: "ux/skills",
        }),
        "Polish interface details, layout rhythm, and UX presentation for product surfaces.",
      ),
    ).toBe("more")
  })

  test("keeps review and conversion helpers out of journal polish zh main results", () => {
    expect(
      split(
        "投稿前润色英文论文",
        item({
          id: "review/skills@scientific-manuscript-review",
          name: "scientific-manuscript-review",
          provider: "external",
          rank: "semantic",
          source: "review/skills",
        }),
        "Review scientific manuscripts, proofread papers, and improve academic writing quality.",
      ),
    ).toBe("more")

    expect(
      split(
        "投稿前润色英文论文",
        item({
          id: "local/skills@tex-to-md",
          name: "tex-to-md",
          provider: "external",
          rank: "semantic",
          source: "local/skills",
        }),
        "Convert LaTeX paper source into readable Markdown for review, summarization, and downstream editing.",
      ),
    ).toBe("more")

    expect(
      split(
        "投稿前润色英文论文",
        item({
          id: "writer/skills@professional-proofreader",
          name: "professional-proofreader",
          provider: "external",
          rank: "semantic",
          source: "writer/skills",
        }),
        "Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.",
      ),
    ).toBe("main")
  })

  test("keeps exact proofreaders in main for chinese paper polish queries", () => {
    expect(
      split(
        "找一下论文润色的skill",
        item({
          id: "writer/skills@professional-proofreader",
          name: "professional-proofreader",
          provider: "external",
          rank: "exact",
          source: "writer/skills",
        }),
        "Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.",
      ),
    ).toBe("main")
  })

  test("keeps semantic proofreaders in main when high-signal proofreading probes match", () => {
    expect(
      split(
        "帮我找个给英文稿件校对的 skill",
        item({
          id: "writer/skills@english-proofreading",
          name: "english-proofreading",
          provider: "external",
          rank: "semantic",
          source: "writer/skills",
          probe: "english proofreading",
        }),
        "Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.",
      ),
    ).toBe("main")

    expect(
      split(
        "投稿前润色英文论文",
        item({
          id: "writer/skills@english-proofreading",
          name: "english-proofreading",
          provider: "external",
          rank: "semantic",
          source: "writer/skills",
          probe: "professional proofreader",
        }),
        "Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.",
      ),
    ).toBe("main")
  })
})

describe("queries", () => {
  test("plans english discovery queries for chinese paper polish intent", () => {
    const list = queries("找一下论文润色的skill", {
      phrases: [],
      keywords: [],
    })
    expect(list).toEqual(expect.arrayContaining(["找一下论文润色的skill", "paper polish", "proofread manuscript", "proofread paper"]))
    expect(list).not.toEqual(expect.arrayContaining(["polish"]))
  })

  test("plans proofreader probes for english manuscript proofreading intent", () => {
    expect(
      queries("帮我找个给英文稿件校对的 skill", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["professional proofreader", "english proofreading"]))
  })

  test("plans english discovery queries for chinese scientific plotting intent", () => {
    expect(
      queries("科研绘图", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["scientific plotting", "scientific visualization", "figure generation"]))
  })

  test("plans browser automation probes for click-through and inspect intents", () => {
    expect(
      queries("click through a website automatically", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["browser automation", "playwright"]))

    expect(
      queries("自动检查网页元素和交互", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["browser automation", "playwright"]))
  })

  test("prioritizes specific task probes ahead of broad academic probes", () => {
    const list = queries("找一下论文润色的skill", {
      probes: ["academic", "research", "scientific", "paper polish", "proofread manuscript", "proofread paper"],
    }).slice(0, 3)

    expect(list).toEqual(expect.arrayContaining(["找一下论文润色的skill", "proofread manuscript"]))
    expect(list).not.toEqual(expect.arrayContaining(["academic", "research", "scientific"]))
  })

  test("plans academic humanizer probes for naturalness requests", () => {
    expect(
      queries("把学术写作改得更自然一些", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["academic writing humanizer"]))
  })

  test("keeps direct task probes in the top results when the raw query has filler words", () => {
    expect(
      queries("paper polish skill", {
        phrases: [],
        keywords: [],
      }).slice(0, 3),
    ).toEqual(expect.arrayContaining(["paper polish"]))
  })

  test("keeps broad academic probes out of the primary paper polish plan", () => {
    expect(
      queries("找一下论文润色的skill", {
        phrases: [],
        keywords: [],
      }),
    ).not.toEqual(expect.arrayContaining(["academic", "research", "scientific"]))
  })

  test("keeps broad translation probes out of the primary docs translation plan", () => {
    const list = queries("translate technical docs", {
      phrases: [],
      keywords: [],
    })
    expect(list).toEqual(expect.arrayContaining(["translate technical docs", "technical docs translation"]))
    expect(list).not.toEqual(expect.arrayContaining(["translate", "translation"]))
  })

  test("keeps academic translation probes in the primary manuscript translation plan", () => {
    expect(
      queries("translate an academic manuscript", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["manuscript translation", "paper translation", "academic translation"]))
  })

  test("keeps model native probes alongside english discovery probes for non-latin queries", () => {
    expect(
      queries("把 API 文档翻译成本地化中文", {
        native: ["API 文档 翻译", "文档 翻译"],
        direct: ["technical docs translation", "docs translation"],
        supporting: ["documentation localization"],
        broad: ["translation"],
      }),
    ).toEqual(
      expect.arrayContaining([
        "把 api 文档翻译成本地化中文",
        "api 文档 翻译",
        "technical docs translation",
      ]),
    )
  })

  test("preserves exact hyphenated skill ids for external discovery", () => {
    expect(
      queries("auto-updater", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["auto-updater"]))

    expect(
      queries("latex-paper-en", {
        phrases: [],
        keywords: [],
      }),
    ).toEqual(expect.arrayContaining(["latex-paper-en"]))
  })
})

describe("parseWeb", () => {
  test("extracts skills.sh skill pages and ignores marketplace noise", () => {
    expect(
      parseWeb(`
        <a href="https://skills.sh/trending">Trending</a>
        <a href="https://skills.sh/vercel-labs/skills/find-skills">Find Skills</a>
        <a href="https://skills.sh/microsoft/playwright-cli/playwright-cli">Playwright</a>
        <a href="https://skills.sh/skills.volces.com/playwright-cli">Playwright Mirror</a>
        <a href="https://skills.sh/f/prompts.chat/book-translation">Noise</a>
      `),
    ).toEqual([
      {
        package: "vercel-labs/skills@find-skills",
        source: "vercel-labs/skills",
        name: "find-skills",
        url: "https://skills.sh/vercel-labs/skills/find-skills",
      },
      {
        package: "microsoft/playwright-cli@playwright-cli",
        source: "microsoft/playwright-cli",
        name: "playwright-cli",
        url: "https://skills.sh/microsoft/playwright-cli/playwright-cli",
      },
      {
        package: "skills.volces.com@playwright-cli",
        source: "skills.volces.com",
        name: "playwright-cli",
        url: "https://skills.sh/skills.volces.com/playwright-cli",
      },
    ])
  })
})
