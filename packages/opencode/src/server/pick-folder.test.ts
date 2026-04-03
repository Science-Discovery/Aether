import { describe, expect, test } from "bun:test"
import { linux, missing } from "./pick-folder"

describe("linux", () => {
  test("prefers zenity when available", () => {
    expect(linux({ HOME: "/tmp" }, (cmd) => (cmd === "zenity" ? "/usr/bin/zenity" : null))).toEqual([
      "/usr/bin/zenity",
      "--file-selection",
      "--directory",
      "--title=Select Folder",
    ])
  })

  test("falls back to kdialog", () => {
    expect(linux({ HOME: "/tmp" }, (cmd) => (cmd === "kdialog" ? "/usr/bin/kdialog" : null))).toEqual([
      "/usr/bin/kdialog",
      "--getexistingdirectory",
      "/tmp",
    ])
  })

  test("returns undefined when no picker exists", () => {
    expect(linux({ HOME: "/tmp" }, () => null)).toBeUndefined()
  })
})

describe("missing", () => {
  test("marks picker as unavailable", () => {
    expect(missing()).toEqual({
      path: null,
      unavailable: true,
      reason: "missing_picker",
    })
  })
})
