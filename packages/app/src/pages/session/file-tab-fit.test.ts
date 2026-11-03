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

  test("keeps a bounded long filename alongside short tabs without compacting them", () => {
    expect(
      fitFileTabs({
        clientWidth: 600,
        fixedWidth: 100,
        natural: [240, 90, 90],
        capped: [150, 90, 90],
        moreWidth: 40,
      }),
    ).toEqual({ capped: false, visible: 3 })
  })

  test("retains every compact tab at the exact available width", () => {
    expect(
      fitFileTabs({
        clientWidth: 490,
        fixedWidth: 100,
        natural: [240, 90, 240],
        capped: [150, 90, 150],
        moreWidth: 40,
      }),
    ).toEqual({ capped: true, visible: 3 })
  })

  test("reserves overflow space and restores tabs after a resize", () => {
    const input = {
      fixedWidth: 100,
      natural: [240, 240, 240],
      capped: [150, 150, 150],
      moreWidth: 40,
    }
    expect(fitFileTabs({ ...input, clientWidth: 1100 })).toEqual({ capped: false, visible: 3 })
    expect(fitFileTabs({ ...input, clientWidth: 700 })).toEqual({ capped: true, visible: 3 })
    expect(fitFileTabs({ ...input, clientWidth: 460 })).toEqual({ capped: true, visible: 2 })
    expect(fitFileTabs({ ...input, clientWidth: 1100 })).toEqual({ capped: false, visible: 3 })
  })
})
