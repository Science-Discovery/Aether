import { describe, expect, test } from "bun:test"
import { resolveInput, wsl } from "./path"

describe("wsl", () => {
  test("converts a windows path in wsl", () => {
    expect(wsl("C:\\Songtan\\paper.pdf", "5.15.167.4-microsoft-standard-WSL2")).toBe("/mnt/c/Songtan/paper.pdf")
  })

  test("converts a windows path with slash separators in wsl", () => {
    expect(wsl("C:/Songtan/paper.pdf", "5.15.167.4-microsoft-standard-WSL2")).toBe("/mnt/c/Songtan/paper.pdf")
  })

  test("converts a drive root in wsl", () => {
    expect(wsl("C:\\", "5.15.167.4-microsoft-standard-WSL2")).toBe("/mnt/c")
  })

  test("leaves a windows path unchanged outside wsl", () => {
    expect(wsl("C:\\Songtan\\paper.pdf", "6.8.0-generic")).toBe("C:\\Songtan\\paper.pdf")
  })

  test("leaves a unix path unchanged in wsl", () => {
    expect(wsl("/mnt/c/Songtan/paper.pdf", "5.15.167.4-microsoft-standard-WSL2")).toBe("/mnt/c/Songtan/paper.pdf")
  })
})

describe("resolveInput", () => {
  test("treats a wsl windows path as absolute", () => {
    expect(resolveInput("/home/st_97142/Aether", "C:\\Songtan\\paper.pdf", "5.15.167.4-microsoft-standard-WSL2")).toBe(
      "/mnt/c/Songtan/paper.pdf",
    )
  })

  test("resolves a relative path from the root", () => {
    // path.resolve() uses Windows semantics on native Windows; skip this WSL-only test
    if (process.platform === "win32") return
    expect(resolveInput("/home/st_97142/Aether", "docs/paper.pdf", "5.15.167.4-microsoft-standard-WSL2")).toBe(
      "/home/st_97142/Aether/docs/paper.pdf",
    )
  })
})
