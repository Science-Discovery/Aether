import { describe, expect, test } from "bun:test"
import { nextTabListScrollLeft } from "./file-tab-scroll"

describe("nextTabListScrollLeft", () => {
  test("does not scroll when width shrinks", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 420,
      clientWidth: 300,
      prevContextOpen: false,
      contextOpen: false,
    })

    expect(left).toBeUndefined()
  })

  test("scrolls to right end when context tab opens in the right group", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 400,
      scrollWidth: 500,
      clientWidth: 320,
      prevContextOpen: false,
      contextOpen: true,
    })

    expect(left).toBe(180)
  })

  test("scrolls to reveal the last file tab for new file tabs", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 780,
      clientWidth: 300,
      prevContextOpen: true,
      contextOpen: true,
      lastFileTabRight: 420,
    })

    expect(left).toBe(120)
  })

  test("falls back to the right end without a file tab", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 780,
      clientWidth: 300,
      prevContextOpen: true,
      contextOpen: true,
    })

    expect(left).toBe(480)
  })

  test("does not scroll when there is no overflow", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 200,
      scrollWidth: 250,
      clientWidth: 300,
      prevContextOpen: true,
      contextOpen: true,
      lastFileTabRight: 240,
    })

    expect(left).toBeUndefined()
  })
})
