import { describe, expect, test } from "bun:test"
import { fitFileTabs } from "./file-tab-fit"

describe("fitFileTabs", () => {
  test("shows every tab at natural width when it fits", () => {
    const fit = fitFileTabs({
      clientWidth: 600,
      fixedWidth: 100,
      natural: [120, 150, 90],
      capped: [120, 150, 90],
      moreWidth: 40,
    })

    expect(fit).toEqual({ capped: false, visible: 3 })
  })

  test("caps tab widths when natural widths overflow", () => {
    const fit = fitFileTabs({
      clientWidth: 600,
      fixedWidth: 100,
      natural: [300, 300, 300],
      capped: [150, 150, 150],
      moreWidth: 40,
    })

    expect(fit).toEqual({ capped: true, visible: 3 })
  })

  test("shows a leading subset with the overflow trigger when even caps overflow", () => {
    const fit = fitFileTabs({
      clientWidth: 600,
      fixedWidth: 100,
      natural: [300, 300, 300, 300, 300],
      capped: [150, 150, 150, 150, 150],
      moreWidth: 40,
    })

    expect(fit).toEqual({ capped: true, visible: 3 })
  })

  test("always keeps at least one visible tab", () => {
    const fit = fitFileTabs({
      clientWidth: 160,
      fixedWidth: 100,
      natural: [300, 300],
      capped: [150, 150],
      moreWidth: 40,
    })

    expect(fit).toEqual({ capped: true, visible: 1 })
  })

  test("never shows more tabs than the budget allows", () => {
    const fit = fitFileTabs({
      clientWidth: 300,
      fixedWidth: 100,
      natural: [500, 500, 500],
      capped: [150, 150, 150],
      moreWidth: 40,
    })

    expect(fit).toEqual({ capped: true, visible: 1 })
  })
})
