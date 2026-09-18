import { beforeAll, describe, expect, mock, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"

let getWorkspaceTerminalCacheKey: (dir: string) => string
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown
let runKey: (slug: string) => string

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  migrateTerminalState = mod.migrateTerminalState
  runKey = mod.runKey
})

describe("runKey", () => {
  const slug = (dir: string) => base64Encode(dir)

  test("merges slash spelling variants of the same directory", () => {
    const back = slug("E:\\work\\AI\\Aether\\aether-test")
    const forward = slug("E:/work/AI/Aether/aether-test")
    expect(runKey(back)).toBe("e:\\work\\ai\\aether\\aether-test")
    expect(runKey(forward)).toBe(runKey(back))
  })

  test("merges case variants", () => {
    expect(runKey(slug("e:\\work\\ai\\aether\\AETHER-test"))).toBe(runKey(slug("E:\\work\\AI\\Aether\\aether-test")))
  })

  test("strips trailing separators", () => {
    expect(runKey(slug("E:\\work\\AI\\Aether\\aether-test\\"))).toBe(runKey(slug("E:\\work\\AI\\Aether\\aether-test")))
    expect(runKey(slug("E:/work/AI/Aether/aether-test//"))).toBe(runKey(slug("E:\\work\\AI\\Aether\\aether-test")))
  })

  test("falls back to the raw slug when it is not valid base64", () => {
    expect(runKey("!!!")).toBe("!!!")
  })
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(getWorkspaceTerminalCacheKey("/repo")).toBe("/repo:__workspace__")
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "Terminal 2", titleNumber: 2 },
        { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "two",
      all: [
        { id: "one", title: "Terminal 1", titleNumber: 1 },
        { id: "two", title: "shell", titleNumber: 7 },
      ],
    })
  })
})
