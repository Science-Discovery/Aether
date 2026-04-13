import { describe, expect, spyOn, test } from "bun:test"
import { Provider } from "@/provider/provider"
import { cases, rank, roster, subset, table } from "./benchmark"

describe("rank", () => {
  test("prefers precise main results over noisy main hits", () => {
    const query = cases.find((item) => item.id === "paper-polish-zh")
    expect(query).toBeDefined()
    const result = rank(query!, {
      main: ["paper-polish", "professional-proofreader", "video-editing"],
      more: ["code-polish"],
      latency_ms: 4200,
      faithfulness: 0.66,
    })
    const clean = rank(query!, {
      main: ["paper-polish", "professional-proofreader", "ai-proofreading"],
      more: ["code-polish"],
      latency_ms: 4200,
      faithfulness: 1,
    })
    expect(clean.total).toBeGreaterThan(result.total)
    expect(result.breakdown.must_not_penalty).toBeLessThan(clean.breakdown.must_not_penalty)
  })

  test("accepts edge matches in more without promoting them to main", () => {
    const query = cases.find((item) => item.id === "paper-polish-zh")
    expect(query).toBeDefined()
    const result = rank(query!, {
      main: ["paper-polish", "professional-proofreader"],
      more: ["code-polish", "polish"],
      latency_ms: 3800,
      faithfulness: 1,
    })
    expect(result.breakdown.precision_main).toBeGreaterThan(30)
    expect(result.breakdown.must_not_penalty).toBeGreaterThan(10)
  })

  test("treats docs translation equivalents as full must-have hits", () => {
    const query = cases.find((item) => item.id === "translate-en")
    expect(query).toBeDefined()
    const result = rank(query!, {
      main: ["rtl-document-translation"],
      more: [],
      latency_ms: 3200,
      faithfulness: 0,
    })
    expect(result.breakdown.recall_main).toBe(15)
    expect(result.breakdown.precision_main).toBe(40)
  })

  test("treats paper translation equivalents as full must-have hits", () => {
    const query = cases.find((item) => item.id === "translate-paper-en")
    expect(query).toBeDefined()
    const result = rank(query!, {
      main: ["academic-translate"],
      more: [],
      latency_ms: 3200,
      faithfulness: 0,
    })
    expect(result.breakdown.recall_main).toBe(15)
    expect(result.breakdown.precision_main).toBe(40)
  })

  test("does not let docs and paper translation aliases satisfy each other", () => {
    const docs = cases.find((item) => item.id === "translate-en")
    const paper = cases.find((item) => item.id === "translate-paper-en")
    expect(docs).toBeDefined()
    expect(paper).toBeDefined()

    expect(
      rank(docs!, {
        main: ["academic-translate"],
        more: [],
        latency_ms: 3200,
        faithfulness: 0,
      }).breakdown.recall_main,
    ).toBe(0)

    expect(
      rank(paper!, {
        main: ["rtl-document-translation"],
        more: [],
        latency_ms: 3200,
        faithfulness: 0,
      }).breakdown.recall_main,
    ).toBe(0)
  })

  test("does not give full must-have credit to weak generic translation names", () => {
    const query = cases.find((item) => item.id === "translate-en")
    expect(query).toBeDefined()
    const result = rank(query!, {
      main: ["translator", "translation", "pdf-translator"],
      more: [],
      latency_ms: 3200,
      faithfulness: 0,
    })
    expect(result.breakdown.recall_main).toBe(0)
    expect(result.breakdown.precision_main).toBe(0)
  })
})

describe("table", () => {
  test("sorts models by total score descending", () => {
    const out = table([
      {
        model: "opencode/gpt-5-nano",
        total: 71,
        breakdown: {
          precision_main: 28,
          must_not_penalty: 14,
          recall_main: 12,
          summary_faithfulness: 12,
          latency: 3,
          stability: 2,
        },
      },
      {
        model: "opencode/big-pickle",
        total: 84,
        breakdown: {
          precision_main: 35,
          must_not_penalty: 18,
          recall_main: 14,
          summary_faithfulness: 12,
          latency: 3,
          stability: 2,
        },
      },
    ])
    expect(out[0]?.model).toBe("opencode/big-pickle")
    expect(out[1]?.model).toBe("opencode/gpt-5-nano")
  })
})

describe("cases", () => {
  test("covers a detailed mixed chinese and english discovery matrix", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50)
    expect(new Set(cases.map((item) => item.lang))).toEqual(new Set(["zh", "en"]))
    expect(new Set(cases.map((item) => item.category))).toEqual(
      new Set([
        "academic_polish",
        "translation",
        "visualization",
        "browser",
        "document",
        "slides",
        "meta",
        "paper_web",
        "humanize",
        "exact",
      ]),
    )
    expect(cases.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "paper-polish-zh",
        "humanizer-zh",
        "updater-zh",
        "paper-polish-en",
        "proofread-en",
        "humanizer-en",
        "tool-search-zh",
        "translate-zh",
        "translate-paper-zh",
        "translate-en",
        "exact-updater",
        "exact-humanizer-cn",
        "browser-zh",
        "browser-en",
        "exact-playwright",
        "pdf-zh",
        "pdf-en",
        "slides-zh",
        "slides-en",
        "pptx-en",
        "paper-web-en",
        "latex-en",
        "plot-zh",
      ]),
    )
  })
})

describe("subset", () => {
  test("filters cases by language and category", () => {
    const picked = subset({
      lang: "zh",
      category: ["visualization", "browser"],
    })
    expect(picked.length).toBeGreaterThan(0)
    expect(new Set(picked.map((item) => item.lang))).toEqual(new Set(["zh"]))
    expect(new Set(picked.map((item) => item.category))).toEqual(new Set(["visualization", "browser"]))
  })
})

describe("roster", () => {
  test("includes connected models from all providers", async () => {
    const listSpy = spyOn(Provider, "list").mockResolvedValue({
      opencode: {
        id: "opencode",
        name: "OpenCode",
        models: {
          "big-pickle": {
            id: "big-pickle",
            providerID: "opencode",
          },
        },
      },
      openrouter: {
        id: "openrouter",
        name: "OpenRouter",
        models: {
          "openai/gpt-5-chat": {
            id: "openai/gpt-5-chat",
            providerID: "openrouter",
          },
        },
      },
    } as any)

    const rows = await roster()
    expect(rows.map((item) => item.name)).toEqual(
      expect.arrayContaining(["opencode/big-pickle", "openrouter/openai/gpt-5-chat"]),
    )

    listSpy.mockRestore()
  })
})
