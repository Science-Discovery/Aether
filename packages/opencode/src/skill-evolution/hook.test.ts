import { describe, expect, test, spyOn } from "bun:test"
import { SkillEvolutionHook } from "./hook"
import { Counter } from "./counter"
import { DEFAULT_NUDGE_INTERVAL } from "./constants"
import { ConfigReader } from "./config-reader"
import { SessionID } from "@/session/schema"

describe("SkillEvolutionHook.onStep", () => {
  test("increments counter once per step for a normal session", () => {
    const id = ("hook-normal-" + Math.random()) as SessionID
    SkillEvolutionHook.onStep(id)
    SkillEvolutionHook.onStep(id)
    expect(Counter.get(id)).toBe(2)
    Counter.reset(id)
  })
})

describe("SkillEvolutionHook.onLoopEnd", () => {
  test("does nothing when aborted", async () => {
    const id = ("hook-aborted-" + Math.random()) as SessionID
    for (let i = 0; i < 13; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      finalResponse: true,
      aborted: true,
      projectId: "proj-test",
    })
    // aborted early-returns before threshold check — counter untouched
    expect(Counter.get(id)).toBe(13)
    Counter.reset(id)
  })

  test("does nothing when finalResponse is false", async () => {
    const id = ("hook-noreply-" + Math.random()) as SessionID
    for (let i = 0; i < 15; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      finalResponse: false,
      aborted: false,
      projectId: "proj-test",
    })
    // no final response — counter untouched
    expect(Counter.get(id)).toBeGreaterThan(0)
    Counter.reset(id)
  })

  test("counter preserved when below threshold", async () => {
    const id = ("hook-below-" + Math.random()) as SessionID
    for (let i = 0; i < 5; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      finalResponse: true,
      aborted: false,
      projectId: "proj-test",
    })
    // 5 < DEFAULT_NUDGE_INTERVAL — counter must not be reset
    expect(Counter.get(id)).toBe(5)
    Counter.reset(id)
  })

  test("does not trigger when global evolution switch is off", async () => {
    // Master switch off: even past the threshold, onLoopEnd must early-return
    // before spawnReview — observable as the counter staying put (not reset to 0).
    const spy = spyOn(ConfigReader, "isEvolutionEnabled").mockResolvedValue(false)
    try {
      const id = ("hook-master-off-" + Math.random()) as SessionID
      for (let i = 0; i < 12; i++) Counter.increment(id)

      await SkillEvolutionHook.onLoopEnd({
        sessionID: id,
        finalResponse: true,
        aborted: false,
        projectId: "proj-test",
      })
      // switch off → no spawn → counter untouched (would be 0 if it had triggered)
      expect(Counter.get(id)).toBe(12)
      Counter.reset(id)
    } finally {
      spy.mockRestore()
    }
  })

  test("resets counter only after spawn when threshold is met", async () => {
    const id = ("hook-threshold-" + Math.random()) as SessionID
    for (let i = 0; i < DEFAULT_NUDGE_INTERVAL; i++) Counter.increment(id)

    await SkillEvolutionHook.onLoopEnd({
      sessionID: id,
      finalResponse: true,
      aborted: false,
      projectId: "proj-test",
    })
    // counter reset only after spawnReview setup completes
    expect(Counter.get(id)).toBe(0)
  })
})
