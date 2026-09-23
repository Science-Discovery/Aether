import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"

import { wslPath } from "./apps"

const wsl = (() => {
  if (process.platform !== "win32") return false
  try {
    execFileSync("wsl", ["-e", "true"])
    return true
  } catch {
    return false
  }
})()

const home = () => execFileSync("wsl", ["-e", "sh", "-lc", 'printf %s "$HOME"']).toString().trim()

describe.skipIf(!wsl)("wslPath", () => {
  test("resolves ~ to the WSL home like the pre-fix $HOME expansion", () => {
    const expanded = execFileSync("wsl", ["-e", "wslpath", "-w", `${home()}/sub`])
      .toString()
      .trim()
    expect(wslPath("~/sub", "windows")).toBe(expanded)
    expect(wslPath("~", "windows")).toBe(wslPath(home(), "windows"))
  })

  test("windows paths still convert to wsl paths", () => {
    expect(wslPath("C:\\Windows", "linux")).toBe("/mnt/c/Windows")
  })

  test("command substitution in ~ paths is never executed", () => {
    const marker = `/tmp/aether-wslpath-inject-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const result = wslPath(`~$(touch ${marker})`, "windows")
    expect(result).toContain("$(")
    const probed = execFileSync("wsl", ["-e", "sh", "-lc", `test -e ${marker} && echo yes || echo no`])
    expect(probed.toString().trim()).toBe("no")
  })

  test("backticks and quotes in ~ paths stay literal", () => {
    const weird = '~`id -u` it\'s "quoted"'
    const result = wslPath(weird, "linux")
    expect(result.endsWith(weird.slice(1))).toBe(true)
  })
})
