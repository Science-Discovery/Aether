import { describe, expect, test } from "bun:test"
import { split } from "../src/remote-ssh"
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
})
