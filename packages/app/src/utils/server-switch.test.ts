import { describe, expect, test } from "bun:test"
import { switchServer } from "./server-switch"

describe("switchServer", () => {
  test("waits for path change before activation", () => {
    const seen: string[] = []
    const queue: VoidFunction[] = []
    let path = "/a/session"

    switchServer({
      done: () => seen.push("navigate"),
      later: () => seen.push("activate"),
      path: () => path,
      schedule: (next) => {
        seen.push("scheduled")
        queue.push(next)
      },
    })

    expect(seen).toEqual(["navigate", "scheduled"])
    expect(queue).toHaveLength(1)

    queue.shift()?.()
    expect(seen).toEqual(["navigate", "scheduled", "scheduled"])

    path = "/"
    queue.shift()?.()
    expect(seen).toEqual(["navigate", "scheduled", "scheduled", "activate"])
  })

  test("activates immediately when already at root", () => {
    const seen: string[] = []

    switchServer({
      done: () => seen.push("navigate"),
      later: () => seen.push("activate"),
      path: () => "/",
      schedule: () => seen.push("scheduled"),
    })

    expect(seen).toEqual(["navigate", "activate"])
  })
})
