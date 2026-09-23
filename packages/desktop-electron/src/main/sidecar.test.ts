import { describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"

import { decodePid, encodePid, killTree, ownedBy, running } from "./sidecar"

function sleeper() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" })
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function exited(child: ChildProcess) {
  return new Promise<void>((resolve) => child.on("exit", () => resolve()))
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe("pid record", () => {
  test("encode round-trips through decode", () => {
    expect(decodePid(encodePid(4242, "C:\\Apps\\opencode-cli.exe"), "fallback")).toEqual({
      pid: 4242,
      image: "C:\\Apps\\opencode-cli.exe",
    })
  })

  test("decode accepts legacy plain pid with fallback image", () => {
    expect(decodePid("123\n", "fallback")).toEqual({ pid: 123, image: "fallback" })
  })

  test("decode rejects empty, garbage and invalid records", () => {
    expect(decodePid("", "fallback")).toBeNull()
    expect(decodePid("   \n", "fallback")).toBeNull()
    expect(decodePid("not-a-pid", "fallback")).toBeNull()
    expect(decodePid("-5", "fallback")).toBeNull()
    expect(decodePid("0", "fallback")).toBeNull()
    expect(decodePid('{"pid": -1, "image": "x"}', "fallback")).toBeNull()
    expect(decodePid('{"pid": 1}', "fallback")).toBeNull()
    expect(decodePid('{"image": "x"}', "fallback")).toBeNull()
    expect(() => decodePid("{oops", "fallback")).toThrow()
  })
})

describe("ownedBy", () => {
  test("matches the recorded image case- and separator-insensitively", () => {
    expect(ownedBy({ exe: "C:\\Apps\\OPENCODE-CLI.EXE", cmdline: "" }, "c:/apps/opencode-cli.exe")).toBe(true)
    expect(ownedBy({ exe: "/usr/lib/opencode-cli", cmdline: "" }, "/usr/lib/opencode-cli")).toBe(true)
  })

  test("rejects a foreign executable", () => {
    expect(ownedBy({ exe: "C:\\Windows\\System32\\cmd.exe", cmdline: "" }, "C:\\Apps\\opencode-cli.exe")).toBe(false)
    expect(ownedBy({ exe: "", cmdline: "anything" }, "C:\\Apps\\opencode-cli.exe")).toBe(false)
  })

  test("wsl image requires wsl.exe running the opencode script", () => {
    const script = 'wsl.exe -e bash -lc "BIN=\\"$HOME/.opencode/bin/opencode\\"; exec \\"$BIN\\" serve"'
    expect(ownedBy({ exe: "C:\\Windows\\System32\\wsl.exe", cmdline: script }, "wsl")).toBe(true)
    expect(ownedBy({ exe: "C:\\Program Files\\WSL\\wsl.exe", cmdline: script }, "wsl")).toBe(true)
    expect(ownedBy({ exe: "C:\\Windows\\System32\\wsl.exe", cmdline: "wsl.exe ~" }, "wsl")).toBe(false)
    expect(ownedBy({ exe: "C:\\Apps\\opencode-cli.exe", cmdline: script }, "wsl")).toBe(false)
  })
})

describe("running", () => {
  test("confirms the live owner and rejects a foreign image", async () => {
    const child = sleeper()
    try {
      const pid = child.pid!
      expect(await running(pid, process.execPath)).toBe(true)
      expect(await running(pid, "C:\\definitely\\missing\\opencode-cli.exe")).toBe(false)
    } finally {
      child.kill()
    }
  }, 20000)

  test("reports false for a dead pid without hanging", async () => {
    expect(await running(999_999_999, process.execPath)).toBe(false)
  }, 20000)
})

describe("killTree", () => {
  test("terminates the recorded process", async () => {
    const child = sleeper()
    const pid = child.pid!
    expect(alive(pid)).toBe(true)
    await killTree(pid)
    await Promise.race([exited(child), wait(5000)])
    expect(alive(pid)).toBe(false)
  }, 20000)
})
