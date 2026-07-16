import { expect, test } from "bun:test"
import { applyGlobalEvent } from "./event-reducer"

test("handles provider.models.updated without triggering a full refresh", () => {
  let refresh = 0
  let providers = 0
  applyGlobalEvent({
    event: { type: "provider.models.updated" },
    project: [],
    refresh: () => {
      refresh += 1
    },
    providers: () => {
      providers += 1
    },
    setGlobalProject() {},
  })

  expect(refresh).toBe(0)
  expect(providers).toBe(1)
})
