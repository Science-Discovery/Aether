import { describe, expect, test } from "bun:test"
import { nextRevealScroll } from "./file-tab-reveal"

describe("file tab reveal", () => {
  test("retries when root is not ready", () => {
    expect(
      nextRevealScroll({
        rootReady: false,
        rootHeight: 400,
        targetReady: true,
        targetHeight: 24,
        top: 20,
        bottom: 44,
        scrollTop: 100,
      }),
    ).toEqual({ kind: "retry", reason: "root" })
  })

  test("retries when target is not ready", () => {
    expect(
      nextRevealScroll({
        rootReady: true,
        rootHeight: 400,
        targetReady: false,
        targetHeight: 24,
        top: 20,
        bottom: 44,
        scrollTop: 100,
      }),
    ).toEqual({ kind: "retry", reason: "target" })
  })

  test("does not scroll when target is already visible", () => {
    expect(
      nextRevealScroll({
        rootReady: true,
        rootHeight: 400,
        targetReady: true,
        targetHeight: 24,
        top: 100,
        bottom: 124,
        scrollTop: 250,
      }),
    ).toEqual({ kind: "done", reason: "visible", top: 250 })
  })

  test("centers target when it is outside the viewport", () => {
    expect(
      nextRevealScroll({
        rootReady: true,
        rootHeight: 400,
        targetReady: true,
        targetHeight: 24,
        top: 520,
        bottom: 544,
        scrollTop: 100,
      }),
    ).toEqual({ kind: "done", reason: "scroll", top: 432 })
  })
})
