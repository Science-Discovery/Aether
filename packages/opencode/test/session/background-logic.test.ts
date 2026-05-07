import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { fromOverride } from "../../src/session/discipline"

describe("BackgroundTask data extraction logic", () => {
  test("findLast text from descending stream returns newest text", () => {
    // Simulate descending stream order (newest first) - as MessageV2.stream does
    const messages = [
      { role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "final summary" }] },
      {
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "tool", tool: "grep" }, { type: "text", text: "intermediate finding" }],
      },
      { role: "assistant", parts: [{ type: "step-start" }] },
    ]

    // Current code: find first non-empty text (since stream is descending, first = newest)
    let resultText = ""
    for (const msg of messages) {
      if (msg.role !== "assistant") continue
      for (const p of msg.parts) {
        if (p.type === "text" && p.text?.trim() && !resultText) {
          resultText = p.text
        }
      }
    }

    expect(resultText).toBe("final summary")
  })

  test("findLast text from single message", () => {
    const parts = [{ type: "step-start" }, { type: "tool", tool: "grep" }, { type: "text", text: "result text" }]

    const text = parts.findLast((x: any) => x.type === "text")?.text ?? ""
    expect(text).toBe("result text")
  })

  test("empty parts produce empty text", () => {
    const parts: any[] = [{ type: "step-start" }]
    const text = parts.findLast((x) => x.type === "text")?.text ?? ""
    expect(text).toBe("")
  })
})
