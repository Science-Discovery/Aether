import { describe, expect, test } from "bun:test"
import { LegacyRepair } from "../../src/automation/legacy-repair"

const status = {
  directory: "/tmp/opencode",
  target: "/tmp/opencode/opencode-prod.db",
  has_legacy: true,
  message: "发现旧库",
  dismissed: false,
  legacy_count: 1,
  files: [
    {
      name: "opencode-dev.db",
      path: "/tmp/opencode/opencode-dev.db",
      channel: "dev",
      mtime: 1,
    },
  ],
  naming: { dev: 1 },
  versions: { "0.1.0": 2 },
}

describe("LegacyRepair.decide", () => {
  test("auto mode runs fallback when merge has errors", () => {
    const next = LegacyRepair.decide({
      mode: "auto",
      force: false,
      status,
      merge: {
        target: status.target,
        merged: [],
        tables: 0,
        changes: 0,
        skipped: [],
        errors: ["bad db"],
      },
    })
    expect(next.run).toBeTrue()
    expect(next.reason).toBe("merge-errors")
  })

  test("controlled-only mode skips fallback", () => {
    const next = LegacyRepair.decide({
      mode: "controlled-only",
      force: false,
      status,
      merge: {
        target: status.target,
        merged: [],
        tables: 0,
        changes: 0,
        skipped: [],
        errors: ["bad db"],
      },
    })
    expect(next.run).toBeFalse()
    expect(next.reason).toBe("mode=controlled-only")
  })
})
