import { describe, expect, test } from "bun:test"
import {
  REVIEW_MAX_STEPS,
  REVIEW_MAX_TOKENS,
  REVIEW_MAX_STEP_CHARS,
  REVIEW_MAX_TOTAL_CHARS,
  isStepLimitReached,
  stepUsageTokens,
  isTokenLimitExceeded,
  isOutputRunaway,
  reviewCharGuard,
  reviewCharLimits,
} from "./limits"

describe("isStepLimitReached", () => {
  test("not reached while step is below the max", () => {
    expect(isStepLimitReached(0, 25)).toBe(false)
    expect(isStepLimitReached(24, 25)).toBe(false)
  })

  test("reached exactly at the max (boundary)", () => {
    expect(isStepLimitReached(25, 25)).toBe(true)
  })

  test("reached past the max", () => {
    expect(isStepLimitReached(26, 25)).toBe(true)
  })

  test("a max of 0 is always reached, including at step 0 (boundary)", () => {
    expect(isStepLimitReached(0, 0)).toBe(true)
  })
})

describe("stepUsageTokens", () => {
  test("sums input, output, reasoning and both cache fields", () => {
    const total = stepUsageTokens({
      input: 100,
      output: 200,
      reasoning: 50,
      cache: { read: 10, write: 5 },
    })
    expect(total).toBe(365)
  })

  test("an all-zero usage sums to zero (boundary)", () => {
    expect(
      stepUsageTokens({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    ).toBe(0)
  })
})

describe("isTokenLimitExceeded", () => {
  test("not exceeded while accumulated tokens are below the max", () => {
    expect(isTokenLimitExceeded(149_999, 150_000)).toBe(false)
  })

  test("not exceeded exactly at the max (boundary — equal is allowed)", () => {
    expect(isTokenLimitExceeded(150_000, 150_000)).toBe(false)
  })

  test("exceeded once accumulated tokens pass the max", () => {
    expect(isTokenLimitExceeded(150_001, 150_000)).toBe(true)
  })

  test("zero accumulated tokens is never exceeded (boundary)", () => {
    expect(isTokenLimitExceeded(0, 150_000)).toBe(false)
  })
})

describe("isOutputRunaway (single-step guard)", () => {
  test("not runaway while accumulated chars are below the max", () => {
    expect(isOutputRunaway(299_999, 300_000)).toBe(false)
  })

  test("not runaway exactly at the max (boundary — equal is allowed)", () => {
    expect(isOutputRunaway(300_000, 300_000)).toBe(false)
  })

  test("runaway once accumulated chars pass the max", () => {
    expect(isOutputRunaway(300_001, 300_000)).toBe(true)
  })

  test("zero accumulated chars is never runaway (boundary)", () => {
    expect(isOutputRunaway(0, 300_000)).toBe(false)
  })
})

describe("isOutputRunaway (whole-review guard)", () => {
  test("the accumulated total below the whole-review cap is not runaway", () => {
    expect(isOutputRunaway(REVIEW_MAX_TOTAL_CHARS - 1, REVIEW_MAX_TOTAL_CHARS)).toBe(false)
  })

  test("exactly at the whole-review cap is still allowed (boundary)", () => {
    expect(isOutputRunaway(REVIEW_MAX_TOTAL_CHARS, REVIEW_MAX_TOTAL_CHARS)).toBe(false)
  })

  test("once the accumulated total passes the whole-review cap it is runaway", () => {
    expect(isOutputRunaway(REVIEW_MAX_TOTAL_CHARS + 1, REVIEW_MAX_TOTAL_CHARS)).toBe(true)
  })

  test("a per-step amount that is fine for one step trips the total once summed across steps", () => {
    // Each step stays well under the single-step cap...
    const perStep = 50_000
    expect(isOutputRunaway(perStep, REVIEW_MAX_STEP_CHARS)).toBe(false)
    // ...but accumulated across enough steps it passes the whole-review cap.
    const steps = Math.ceil(REVIEW_MAX_TOTAL_CHARS / perStep) + 1
    expect(isOutputRunaway(perStep * steps, REVIEW_MAX_TOTAL_CHARS)).toBe(true)
  })
})

describe("reviewCharGuard", () => {
  const caps = { stepMax: 300_000, totalMax: 1_000_000 }

  test('"continue" while both step and total are within their caps', () => {
    expect(reviewCharGuard({ stepChars: 1_000, totalChars: 5_000 }, caps)).toBe("continue")
  })

  test('"cut-step" when the single step exceeds the step cap (one-shot runaway)', () => {
    // step over its cap, total still well under its cap
    expect(reviewCharGuard({ stepChars: 300_001, totalChars: 300_001 }, caps)).toBe("cut-step")
  })

  test('"stop-review" when the accumulated total exceeds the total cap (slow grind)', () => {
    // each step stayed small, but summed they passed the total cap
    expect(reviewCharGuard({ stepChars: 1_000, totalChars: 1_000_001 }, caps)).toBe("stop-review")
  })

  test("the total cap wins when both caps are exceeded at once", () => {
    // stopping the whole review supersedes merely cutting the step
    expect(reviewCharGuard({ stepChars: 300_001, totalChars: 1_000_001 }, caps)).toBe("stop-review")
  })

  test('exactly at each cap is still "continue" (boundary — equal is allowed)', () => {
    expect(reviewCharGuard({ stepChars: 300_000, totalChars: 1_000_000 }, caps)).toBe("continue")
  })

  test("zero usage is continue (boundary)", () => {
    expect(reviewCharGuard({ stepChars: 0, totalChars: 0 }, caps)).toBe("continue")
  })
})

describe("review limit constants", () => {
  test("expose the agreed default step and token caps", () => {
    expect(REVIEW_MAX_STEPS).toBe(25)
    expect(REVIEW_MAX_TOKENS).toBe(150_000)
  })

  test("exposes the agreed single-step output char cap", () => {
    expect(REVIEW_MAX_STEP_CHARS).toBe(300_000)
  })

  test("exposes the agreed whole-review (accumulated) char cap", () => {
    expect(REVIEW_MAX_TOTAL_CHARS).toBe(1_000_000)
  })

  test("the whole-review cap is larger than the single-step cap", () => {
    expect(REVIEW_MAX_TOTAL_CHARS).toBeGreaterThan(REVIEW_MAX_STEP_CHARS)
  })
})

describe("reviewCharLimits", () => {
  test("falls back to the constant defaults when config has no skills block", () => {
    expect(reviewCharLimits(undefined)).toEqual({
      stepMax: REVIEW_MAX_STEP_CHARS,
      totalMax: REVIEW_MAX_TOTAL_CHARS,
    })
  })

  test("falls back to defaults when skills exists but the fields are unset", () => {
    expect(reviewCharLimits({ skills: {} })).toEqual({
      stepMax: REVIEW_MAX_STEP_CHARS,
      totalMax: REVIEW_MAX_TOTAL_CHARS,
    })
  })

  test("uses the configured values when both are set", () => {
    expect(reviewCharLimits({ skills: { review_max_step_chars: 5000, review_max_total_chars: 50000 } })).toEqual({
      stepMax: 5000,
      totalMax: 50000,
    })
  })

  test("overrides each field independently (one set, one default)", () => {
    expect(reviewCharLimits({ skills: { review_max_step_chars: 7000 } })).toEqual({
      stepMax: 7000,
      totalMax: REVIEW_MAX_TOTAL_CHARS,
    })
    expect(reviewCharLimits({ skills: { review_max_total_chars: 80000 } })).toEqual({
      stepMax: REVIEW_MAX_STEP_CHARS,
      totalMax: 80000,
    })
  })

  test("treats 0 as a real configured value, not a missing field (boundary)", () => {
    // 0 is falsy; a naive `cfg || default` would wrongly fall back. Guard against that.
    expect(reviewCharLimits({ skills: { review_max_step_chars: 0, review_max_total_chars: 0 } })).toEqual({
      stepMax: 0,
      totalMax: 0,
    })
  })
})
