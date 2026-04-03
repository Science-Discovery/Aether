import { describe, expect, test } from "bun:test"
import { picked } from "./pick-folder"

describe("picked", () => {
  test("returns the selected path", () => {
    const out: unknown[] = []

    expect(picked({ path: " /tmp/demo " }, (input) => out.push(input), "Request failed")).toBe("/tmp/demo")
    expect(out).toHaveLength(0)
  })

  test("stays silent when the user cancels", () => {
    const out: unknown[] = []

    expect(picked({ path: null }, (input) => out.push(input), "Request failed")).toBeUndefined()
    expect(out).toHaveLength(0)
  })

  test("shows a toast when no picker is available", () => {
    const out: unknown[] = []

    expect(
      picked({ path: null, unavailable: true, reason: "missing_picker" }, (input) => out.push(input), "Request failed"),
    ).toBeUndefined()
    expect(out).toEqual([
      {
        variant: "error",
        title: "Request failed",
        description: "This server cannot open a folder picker here. Enter the path manually or install zenity/kdialog.",
      },
    ])
  })
})
