import { describe, expect, test } from "bun:test"
import { resolveReveal, isPathInRoot, isRevealSuccess } from "./reveal"

// Pure decision: given platform + WSL flag + path (+ an injected WSL→Windows
// converter), return the {cmd, args} to spawn. Experiment confirmed on this machine:
// explorer.exe does NOT accept a raw /home/... path (method B failed), but DOES accept
// the `wslpath -w` form (method A worked). So under WSL we must convert first.

describe("resolveReveal", () => {
  const toWin = (p: string) => `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, "\\")}`

  test("WSL → convert path then explorer.exe (method A, the one that worked)", () => {
    const r = resolveReveal({ platform: "linux", isWsl: true, dir: "/home/zheng/x", toWindows: toWin })
    expect(r.cmd).toBe("explorer.exe")
    expect(r.args[0]).toBe("\\\\wsl.localhost\\Ubuntu\\home\\zheng\\x")
    expect(r.args[0]).not.toContain("/home")
  })

  test("plain Windows → explorer.exe with the path as-is", () => {
    const r = resolveReveal({ platform: "win32", isWsl: false, dir: "C:\\Users\\z\\x", toWindows: toWin })
    expect(r.cmd).toBe("explorer.exe")
    expect(r.args[0]).toBe("C:\\Users\\z\\x")
  })

  test("plain Linux (not WSL) → xdg-open with the path as-is", () => {
    const r = resolveReveal({ platform: "linux", isWsl: false, dir: "/home/z/x", toWindows: toWin })
    expect(r.cmd).toBe("xdg-open")
    expect(r.args[0]).toBe("/home/z/x")
  })

  test("macOS → open", () => {
    const r = resolveReveal({ platform: "darwin", isWsl: false, dir: "/Users/z/x", toWindows: toWin })
    expect(r.cmd).toBe("open")
    expect(r.args[0]).toBe("/Users/z/x")
  })
})

// Security guard: the reveal endpoint must only open directories that live under
// the skill-evolution root, so a crafted request can't make the backend open an
// arbitrary path on the machine.
describe("isPathInRoot", () => {
  const root = "/home/u/.local/share/aether/skill-evolution"

  test("accepts a direct child of the root", () => {
    expect(isPathInRoot(`${root}/abc123`, root)).toBe(true)
  })

  test("accepts a nested path under the root", () => {
    expect(isPathInRoot(`${root}/abc123/skills`, root)).toBe(true)
  })

  test("accepts the root itself", () => {
    expect(isPathInRoot(root, root)).toBe(true)
  })

  test("rejects a path outside the root", () => {
    expect(isPathInRoot("/home/u/secrets", root)).toBe(false)
  })

  test("rejects a parent-traversal escape (boundary)", () => {
    expect(isPathInRoot(`${root}/../../../etc/passwd`, root)).toBe(false)
  })

  test("rejects a sibling that shares the root prefix as a string (boundary)", () => {
    // "<root>-evil" starts with "<root>" as raw text but is NOT inside it.
    expect(isPathInRoot(`${root}-evil/x`, root)).toBe(false)
  })
})

// Pure decision: given the launched command + its exit code, did the open
// actually succeed? Windows explorer.exe is the special case — it frequently
// returns a NON-zero exit code even when it DID open the folder, so we must NOT
// treat its non-zero as failure. Every other launcher follows the usual rule
// (0 = success), which is what lets us correctly report failure when, say,
// xdg-open has no desktop environment to open into.
describe("isRevealSuccess", () => {
  test("explorer.exe with exit code 0 → success", () => {
    expect(isRevealSuccess("explorer.exe", 0)).toBe(true)
  })

  test("explorer.exe with a NON-zero exit code → still success (Windows quirk)", () => {
    expect(isRevealSuccess("explorer.exe", 1)).toBe(true)
  })

  test("xdg-open with exit code 0 → success", () => {
    expect(isRevealSuccess("xdg-open", 0)).toBe(true)
  })

  test("xdg-open with a non-zero exit code → failure (e.g. no desktop env)", () => {
    expect(isRevealSuccess("xdg-open", 3)).toBe(false)
  })

  test("macOS open with exit code 0 → success", () => {
    expect(isRevealSuccess("open", 0)).toBe(true)
  })

  test("macOS open with a non-zero exit code → failure", () => {
    expect(isRevealSuccess("open", 1)).toBe(false)
  })
})
