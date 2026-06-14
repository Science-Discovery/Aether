import { describe, expect, test } from "bun:test"
import {
  REVIEW_MAX_STEP_CHARS,
  REVIEW_MAX_TOTAL_CHARS,
  isOutputRunaway,
  reviewCharGuard,
  reviewCharLimits,
  createReviewCharCounter,
} from "./limits"

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

  test('"stop-review" when the single step exceeds the step cap (one-shot runaway)', () => {
    // step over its cap, total still under its cap — either guard ends the
    // whole review now (a cut step that just kept stepping was its own runaway).
    expect(reviewCharGuard({ stepChars: 300_001, totalChars: 300_001 }, caps)).toBe("stop-review")
  })

  test('"stop-review" when the accumulated total exceeds the total cap (slow grind)', () => {
    // each step stayed small, but summed they passed the total cap
    expect(reviewCharGuard({ stepChars: 1_000, totalChars: 1_000_001 }, caps)).toBe("stop-review")
  })

  test('"stop-review" when both caps are exceeded at once', () => {
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

describe("createReviewCharCounter", () => {
  // Caps kept small so the cross-step math is easy to read. The whole-review
  // total cap (250) is below 3 single steps of 100, so step 3 must trip it even
  // though every individual step stays at/under the per-step cap (100).
  const caps = { stepMax: 100, totalMax: 250 }

  test("continues while a single step stays within both caps", () => {
    const counter = createReviewCharCounter(caps)
    expect(counter.record(50)).toBe("continue")
    expect(counter.total).toBe(50)
    expect(counter.step).toBe(50)
  })

  test("accumulates the whole-review total across steps and stops once it passes the cap", () => {
    // This is the regression for the bug: the total must survive across steps.
    // Each step stays at the per-step cap (100, still allowed), but summed they
    // cross the whole-review cap (250) on step 3.
    const counter = createReviewCharCounter(caps)

    expect(counter.record(100)).toBe("continue") // step 1: total 100
    counter.stepReset()
    expect(counter.record(100)).toBe("continue") // step 2: total 200
    counter.stepReset()
    expect(counter.record(100)).toBe("stop-review") // step 3: total 300 > 250
    expect(counter.total).toBe(300)
  })

  test("stepReset clears the per-step count but leaves the whole-review total intact", () => {
    const counter = createReviewCharCounter(caps)
    counter.record(80)
    expect(counter.step).toBe(80)
    expect(counter.total).toBe(80)

    counter.stepReset()
    expect(counter.step).toBe(0) // per-step zeroed
    expect(counter.total).toBe(80) // whole-review total preserved
  })

  test("stops immediately when a single step blows past the per-step cap (failure path)", () => {
    const counter = createReviewCharCounter(caps)
    expect(counter.record(101)).toBe("stop-review") // 101 > stepMax 100
  })

  test("a fresh counter at zero usage continues (boundary)", () => {
    const counter = createReviewCharCounter(caps)
    expect(counter.record(0)).toBe("continue")
    expect(counter.total).toBe(0)
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
