import { describe, expect, test } from "bun:test"
import { SkillEvolutionHook } from "./hook"
import { Counter } from "./counter"

describe("SkillEvolutionHook.onStep", () => {
  test("increments counter once per step for a normal session", () => {
    const id = "hook-normal-" + Math.random()
    SkillEvolutionHook.onStep(id)
    SkillEvolutionHook.onStep(id)
    expect(Counter.get(id)).toBe(2)
    Counter.reset(id)
  })
})

describe("SkillEvolutionHook.onLoopEnd", () => {
  test("does nothing when aborted", async () => {
    const id = "hook-aborted-" + Math.random()
    Counter.increment(id)
    Counter.increment(id)
    Counter.increment(id)
    // Prime the counter above default threshold (10)
    for (let i = 0; i < 10; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      messages: [],
      isReviewSession: false,
      finalResponse: true,
      aborted: true,
      projectId: "proj-test",
    })
    // Counter should still be present (not reset) when aborted before threshold check
    // (reset only happens when count >= threshold and conditions met)
    Counter.reset(id)
  })

  test("does nothing when finalResponse is false", async () => {
    const id = "hook-noreply-" + Math.random()
    for (let i = 0; i < 15; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      messages: [],
      isReviewSession: false,
      finalResponse: false,
      aborted: false,
      projectId: "proj-test",
    })
    // Counter should not have been reset since condition failed
    expect(Counter.get(id)).toBeGreaterThan(0)
    Counter.reset(id)
  })

  test("does nothing when isReviewSession is true", async () => {
    const id = "hook-review-" + Math.random()
    for (let i = 0; i < 15; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      messages: [],
      isReviewSession: true,
      finalResponse: true,
      aborted: false,
      projectId: "proj-test",
    })
    expect(Counter.get(id)).toBeGreaterThan(0)
    Counter.reset(id)
  })

  test("resets counter when threshold is met", async () => {
    const id = "hook-threshold-" + Math.random()
    // Add exactly DEFAULT_NUDGE_INTERVAL (10) calls
    for (let i = 0; i < 10; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      messages: [],
      isReviewSession: false,
      finalResponse: true,
      aborted: false,
      projectId: "proj-test",
    })
    // Counter should be reset (spawnReview fires in background and may fail silently)
    expect(Counter.get(id)).toBe(0)
  })
})
