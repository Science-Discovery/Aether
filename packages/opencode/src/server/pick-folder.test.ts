import { describe, expect, test } from "bun:test"
import { linux, missing, windows, wsl, wslPath } from "./pick-folder"

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

describe("windows", () => {
  test("returns the powershell picker command", () => {
    expect(windows((cmd) => (cmd === "powershell.exe" ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" : null)))
      .toEqual([
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("FolderBrowserDialog"),
      ])
  })

  test("returns undefined when powershell is unavailable", () => {
    expect(windows(() => null)).toBeUndefined()
  })
})

describe("wsl", () => {
  test("returns the windows picker when running in wsl", () => {
    expect(wsl("5.15.167.4-microsoft-standard-WSL2", (cmd) => (cmd === "powershell.exe" ? "/mnt/c/powershell.exe" : null)))
      .toEqual([
        "/mnt/c/powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("FolderBrowserDialog"),
      ])
  })

  test("returns undefined outside wsl", () => {
    expect(wsl("6.8.0-generic", () => "/mnt/c/powershell.exe")).toBeUndefined()
  })
})

describe("wslPath", () => {
  test("converts a windows path to wsl format", () => {
    expect(wslPath("C:\\Songtan\\Gewu")).toBe("/mnt/c/Songtan/Gewu")
  })

  test("keeps non-windows paths unchanged", () => {
    expect(wslPath("/mnt/c/Songtan/Gewu")).toBe("/mnt/c/Songtan/Gewu")
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
