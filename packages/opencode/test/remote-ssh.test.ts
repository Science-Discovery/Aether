import { describe, expect, test } from "bun:test"
import { bins, halt, launch, pick, split } from "../src/remote-ssh"
import * as mod from "../src/remote-ssh"

describe("remote ssh command split", () => {
  test("handles quoted key paths", () => {
    expect(split(`ssh -i "~/.ssh/id with space" user@host`)).toEqual([
      "ssh",
      "-i",
      "~/.ssh/id with space",
      "user@host",
    ])
  })

  test("keeps plain args in order", () => {
    expect(split("ssh -p 2222 user@host")).toEqual(["ssh", "-p", "2222", "user@host"])
  })

  test("expands tilde install dir against remote home", () => {
    const fn = (mod as any).installDir as (home: string, input: string) => string
    expect(fn("/home/rocky", "~/.opencode/bin")).toBe("/home/rocky/.opencode/bin")
    expect(fn("/home/rocky", "~")).toBe("/home/rocky")
  })

  test("parses installed remote versions and sorts newest first", () => {
    expect(bins("\naether_0.5.1\n0.4.9\naether_0.5.10\n")).toEqual(["0.5.10", "0.5.1", "0.4.9"])
  })

  test("prefers exact remote version when installed", () => {
    expect(pick("0.5.1", ["0.5.2", "0.5.1"])).toEqual({
      chosen: "0.5.1",
      source: "exact",
      install: false,
    })
  })

  test("falls back to newest installed version instead of auto-updating", () => {
    expect(pick("0.6.0", ["0.5.2", "0.5.1"])).toEqual({
      chosen: "0.5.2",
      source: "fallback",
      install: false,
    })
  })

  test("requires install only when no remote version exists", () => {
    expect(pick("0.6.0", [])).toEqual({
      chosen: "0.6.0",
      source: "exact",
      install: true,
    })
    expect(pick("", [])).toEqual({
      chosen: "",
      source: "fallback",
      install: true,
    })
  })

  test("cleans up remote backend when ssh session exits", () => {
    const text = launch("/opt/aether", "/tmp/aether.pid", 4312, "/home/rocky")
    expect(text).toContain("trap cleanup EXIT HUP INT TERM")
    expect(text).toContain("rm -f \"$pidfile\"")
    expect(text).toContain("kill \"$pid\" 2>/dev/null || true")
    expect(text).toContain("wait \"$pid\" 2>/dev/null || true")
    expect(text).toContain("cd '/home/rocky'")
    expect(text).toContain(
      "\"$bin\" --print-logs --log-level WARN serve --hostname 127.0.0.1 --port 4312 --remote-runtime --remote-lease-ttl 45000 &",
    )
  })

  test("stops active local ssh child on shutdown", () => {
    const calls: string[] = []
    expect(
      halt({
        exitCode: null,
        signalCode: null,
        kill(sig: NodeJS.Signals | number) {
          calls.push(String(sig))
          return true
        },
      }),
    ).toBe(true)
    expect(calls).toEqual(["SIGTERM"])
  })

  test("does not stop exited local ssh child on shutdown", () => {
    const calls: string[] = []
    expect(
      halt({
        exitCode: 0,
        signalCode: null,
        kill(sig: NodeJS.Signals | number) {
          calls.push(String(sig))
          return true
        },
      }),
    ).toBe(false)
    expect(calls).toEqual([])
  })
})
