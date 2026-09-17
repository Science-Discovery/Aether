import { describe, expect, test } from "bun:test"
import { switchServer } from "./server-switch"

describe("switchServer", () => {
  test("leaves the current route synchronously and defers activation", () => {
    const seen: string[] = []
    const queue: VoidFunction[] = []

    switchServer({
      leave: () => seen.push("leave"),
      activate: () => seen.push("activate"),
      schedule: (run) => {
        seen.push("scheduled")
        queue.push(run)
      },
    })

    expect(seen).toEqual(["leave", "scheduled"])
    expect(queue).toHaveLength(1)

    queue.shift()?.()
    expect(seen).toEqual(["leave", "scheduled", "activate"])
  })

  test("defaults to a microtask for activation", async () => {
    const seen: string[] = []

    switchServer({
      leave: () => seen.push("leave"),
      activate: () => seen.push("activate"),
    })

    expect(seen).toEqual(["leave"])
    await Promise.resolve()
    expect(seen).toEqual(["leave", "activate"])
  })
})
