import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const root = join(import.meta.dir, "..", "..")

function read(rel: string) {
  return readFileSync(join(root, rel), "utf-8")
}

describe("mobile.ts must not open independent SSE connections", () => {
  const src = read("src/context/mobile.ts")

  test("does not fetch /mobile/*/events endpoint", () => {
    expect(src).not.toMatch(/\/events/)
  })

  test("does not use EventSource", () => {
    expect(src).not.toMatch(/EventSource/)
  })

  test("does not set Accept: text/event-stream", () => {
    expect(src).not.toMatch(/text\/event-stream/)
  })

  test("does not contain SSE retry or reconnect logic", () => {
    expect(src).not.toMatch(/connectSSE/)
    expect(src).not.toMatch(/scheduleSseRetry/)
    expect(src).not.toMatch(/clearSseRetry/)
    expect(src).not.toMatch(/sseControllers/)
  })

  test("exports bindEmitter for global event integration", () => {
    expect(src).toMatch(/export function bindEmitter/)
  })

  test("exports bindResolver for API access", () => {
    expect(src).toMatch(/export function bindResolver/)
  })
})

describe("layout.tsx must bind global emitter to mobile module", () => {
  const src = read("src/pages/layout.tsx")

  test("imports bindEmitter from mobile context", () => {
    expect(src).toMatch(/bindEmitter/)
  })

  test("calls bindEmitter with globalSDK.event", () => {
    expect(src).toMatch(/bindEmitter\(globalSDK\.event\)/)
  })
})

describe("global-sdk.tsx must use shared connection", () => {
  const src = read("src/context/global-sdk.tsx")

  test("imports connectShared", () => {
    expect(src).toMatch(/connectShared/)
  })

  test("does not directly call eventSdk.global.event", () => {
    expect(src).not.toMatch(/eventSdk\.global\.event/)
  })

  test("does not create a dedicated eventSdk for SSE", () => {
    const lines = src.split("\n")
    const hasEventSdk = lines.some((l) => l.includes("eventSdk") && l.includes("createSdkForServer"))
    expect(hasEventSdk).toBe(false)
  })
})

describe("shared-connection.ts must implement BroadcastChannel sharing", () => {
  const src = read("src/context/shared-connection.ts")

  test("uses BroadcastChannel", () => {
    expect(src).toMatch(/BroadcastChannel/)
  })

  test("falls back to direct connection when BroadcastChannel unavailable", () => {
    expect(src).toMatch(/typeof BroadcastChannel === "undefined"/)
    expect(src).toMatch(/connectDirect/)
  })

  test("implements heartbeat mechanism", () => {
    expect(src).toMatch(/heartbeat/)
    expect(src).toMatch(/HB_MS/)
  })

  test("implements leader claim mechanism", () => {
    expect(src).toMatch(/kind: "claim"/)
    expect(src).toMatch(/kind: "heartbeat"/)
    expect(src).toMatch(/kind: "event"/)
  })

  test("has timeout for leader death detection", () => {
    expect(src).toMatch(/TIMEOUT_MS/)
  })
})

describe("no frontend module creates independent mobile SSE connections", () => {
  const ctx = join(root, "src", "context")
  const pages = join(root, "src", "pages")

  function scanDir(dir: string): string[] {
    const results: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        results.push(...scanDir(full))
      } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.") && !entry.includes(".spec.")) {
        results.push(full)
      }
    }
    return results
  }

  test("no file fetches /mobile/*/events", () => {
    const violations: string[] = []
    for (const file of [...scanDir(ctx), ...scanDir(pages)]) {
      const content = readFileSync(file, "utf-8")
      if (/\/mobile\/\w+\/events/.test(content)) {
        violations.push(file)
      }
    }
    expect(violations).toEqual([])
  })

  test("no file opens EventSource to mobile endpoints", () => {
    const violations: string[] = []
    for (const file of [...scanDir(ctx), ...scanDir(pages)]) {
      const content = readFileSync(file, "utf-8")
      if (/new EventSource\(.*mobile/.test(content)) {
        violations.push(file)
      }
    }
    expect(violations).toEqual([])
  })
})
