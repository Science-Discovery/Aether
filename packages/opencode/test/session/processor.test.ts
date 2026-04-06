import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

describe("session.processor.finish", () => {
  test("keeps string finish reasons", () => {
    expect(SessionProcessor.finish("stop", false)).toBe("stop")
    expect(SessionProcessor.finish("tool-calls", true)).toBe("tool-calls")
  })

  test("extracts finish reasons from objects", () => {
    expect(SessionProcessor.finish({ reason: "stop" }, false)).toBe("stop")
    expect(SessionProcessor.finish({ type: "length" }, false)).toBe("length")
    expect(SessionProcessor.finish({ finishReason: "tool-calls" }, true)).toBe("tool-calls")
  })

  test("falls back based on tool presence for invalid values", () => {
    expect(SessionProcessor.finish(undefined, false)).toBe("stop")
    expect(SessionProcessor.finish(null, false)).toBe("stop")
    expect(SessionProcessor.finish({ reason: 1 }, false)).toBe("stop")
    expect(SessionProcessor.finish(undefined, true)).toBe("tool-calls")
  })
})
