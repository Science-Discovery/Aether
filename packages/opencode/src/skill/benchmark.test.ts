import { describe, expect, test } from "bun:test"
import { cases, rank, table } from "./benchmark"

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
  test("covers mixed gui-style chinese and english queries", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12)
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
      ]),
    )
  })
})
