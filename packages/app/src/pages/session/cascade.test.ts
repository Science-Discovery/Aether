import { describe, expect, test } from "bun:test"
import { cascade } from "./cascade"

const row = () => [
  { width: 200, min: 81 },
  { width: 400, min: 150 },
  { width: 300, min: 107 },
  { width: 200, min: 67 },
]

describe("cascade", () => {
  test("right drag compresses the adjacent right pane first", () => {
    const out = cascade(row(), 2, 50)
    expect(out.widths).toEqual([200, 450, 250, 200])
    expect(out.moved).toBe(50)
  })

  test("right drag overflow cascades to the next right pane", () => {
    const out = cascade(row(), 2, 250)
    expect(out.widths).toEqual([200, 650, 107, 143])
    expect(out.moved).toBe(250)
  })

  test("right drag stops once every right pane sits at its min", () => {
    const out = cascade(row(), 2, 400)
    expect(out.widths).toEqual([200, 726, 107, 67])
    expect(out.moved).toBe(326)
  })

  test("left drag compresses the adjacent left pane first", () => {
    const out = cascade(row(), 2, -80)
    expect(out.widths).toEqual([200, 320, 380, 200])
    expect(out.moved).toBe(-80)
  })

  test("left drag overflow cascades to the next left pane", () => {
    const out = cascade(row(), 2, -300)
    expect(out.widths).toEqual([150, 150, 600, 200])
    expect(out.moved).toBe(-300)
  })

  test("left drag stops once every left pane sits at its min", () => {
    const out = cascade(row(), 2, -600)
    expect(out.widths).toEqual([81, 150, 669, 200])
    expect(out.moved).toBe(-369)
  })

  test("zero-sum within the row for a boundary divider", () => {
    const panes = row()
    const before = panes.reduce((sum, pane) => sum + pane.width, 0)
    const out = cascade(panes, 1, 133)
    const after = out.widths.reduce((sum, w) => sum + w, 0)
    expect(after).toBe(before)
  })

  test("panes already at or below min absorb nothing", () => {
    const out = cascade(
      [
        { width: 81, min: 81 },
        { width: 150, min: 150 },
        { width: 60, min: 67 },
      ],
      1,
      40,
    )
    expect(out.widths).toEqual([81, 150, 60])
    expect(out.moved).toBe(0)
  })

  test("divider without a left side cannot move left", () => {
    const out = cascade(row(), 0, -50)
    expect(out.widths).toEqual([200, 400, 300, 200])
    expect(out.moved).toBe(0)
  })

  test("divider without a right side cannot move right", () => {
    const out = cascade(row(), 4, 50)
    expect(out.widths).toEqual([200, 400, 300, 200])
    expect(out.moved).toBe(0)
  })

  test("zero delta is a no-op", () => {
    const out = cascade(row(), 2, 0)
    expect(out.widths).toEqual([200, 400, 300, 200])
    expect(out.moved).toBe(0)
  })

  test("two-pane row grows and shrinks across the divider", () => {
    const out = cascade(
      [
        { width: 400, min: 150 },
        { width: 300, min: 107 },
      ],
      1,
      100,
    )
    expect(out.widths).toEqual([500, 200])
    const back = cascade(
      [
        { width: 400, min: 150 },
        { width: 300, min: 107 },
      ],
      1,
      -260,
    )
    expect(back.widths).toEqual([150, 550])
    expect(back.moved).toBe(-250)
  })

  test("does not mutate the input", () => {
    const panes = row()
    cascade(panes, 2, 120)
    expect(panes.map((pane) => pane.width)).toEqual([200, 400, 300, 200])
  })
})
