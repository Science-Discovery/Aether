import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { trimSessions } from "./session-trim"

const session = (input: { id: string; parentID?: string; created: number; updated?: number; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: input.created,
      updated: input.updated,
      archived: input.archived,
    },
  }) as Session

describe("trimSessions", () => {
  test("keeps base roots selected by update time, not creation time", () => {
    const now = 1_000_000
    const list = [
      session({ id: "a", created: now - 100_000 }),
      session({ id: "b", created: now - 90_000 }),
      session({ id: "c", created: now - 80_000 }),
      session({ id: "d", created: now - 70_000, updated: now - 500 }),
      session({ id: "e", created: now - 60_000, archived: now - 10 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now })
    expect(result.map((x) => x.id)).toEqual(["a", "b", "c", "d"])
  })

  test("prioritizes recently-updated session over newer-created but stale one", () => {
    const now = 1_000_000
    const list = [
      session({ id: "ses_new1", created: now - 1_000 }),
      session({ id: "ses_new2", created: now - 2_000 }),
      session({ id: "ses_new3", created: now - 3_000 }),
      session({ id: "ses_old_updated", created: now - 100_000, updated: now - 500 }),
      session({ id: "ses_new4", created: now - 4_000 }),
    ]

    const result = trimSessions(list, { limit: 3, permission: {}, now })
    const ids = result.map((x) => x.id)
    expect(ids).toContain("ses_old_updated")
    expect(ids).toContain("ses_new1")
    expect(ids).toContain("ses_new2")
  })

  test("keeps children when root is kept, permission exists, or child is recent", () => {
    const now = 1_000_000
    const list = [
      session({ id: "root-1", created: now - 1000 }),
      session({ id: "root-2", created: now - 2000 }),
      session({ id: "z-root", created: now - 30_000_000 }),
      session({ id: "child-kept-by-root", parentID: "root-1", created: now - 20_000_000 }),
      session({ id: "child-kept-by-permission", parentID: "z-root", created: now - 20_000_000 }),
      session({ id: "child-kept-by-recency", parentID: "z-root", created: now - 500 }),
      session({ id: "child-trimmed", parentID: "z-root", created: now - 20_000_000 }),
    ]

    const result = trimSessions(list, {
      limit: 2,
      permission: {
        "child-kept-by-permission": [{ id: "perm-1" } as PermissionRequest],
      },
      now,
    })

    expect(result.map((x) => x.id)).toEqual([
      "child-kept-by-permission",
      "child-kept-by-recency",
      "child-kept-by-root",
      "root-1",
      "root-2",
    ])
  })

  test("keep retains a stale root that would otherwise be trimmed", () => {
    const now = 100_000_000
    const list = [
      session({ id: "recent-1", created: now - 1000, updated: now - 100 }),
      session({ id: "recent-2", created: now - 2000, updated: now - 200 }),
      session({ id: "ses_old", created: now - 30_000_000, updated: now - 30_000_000 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now, keep: ["ses_old"] })
    expect(result.map((x) => x.id)).toEqual(["recent-1", "recent-2", "ses_old"])
  })

  test("keep retains a viewed child together with its root ancestor", () => {
    const now = 100_000_000
    const list = [
      session({ id: "recent-1", created: now - 1000, updated: now - 100 }),
      session({ id: "recent-2", created: now - 2000, updated: now - 200 }),
      session({ id: "z-root", created: now - 30_000_000, updated: now - 30_000_000 }),
      session({ id: "z-child", parentID: "z-root", created: now - 30_000_000, updated: now - 30_000_000 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now, keep: ["z-child"] })
    const ids = result.map((x) => x.id)
    expect(ids).toContain("z-child")
    expect(ids).toContain("z-root")
  })

  test("keep of an archived session does not resurrect it", () => {
    const now = 100_000_000
    const list = [
      session({ id: "recent-1", created: now - 1000, updated: now - 100 }),
      session({ id: "recent-2", created: now - 2000, updated: now - 200 }),
      session({ id: "ses_old", created: now - 30_000_000, updated: now - 30_000_000, archived: now - 10 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now, keep: ["ses_old"] })
    expect(result.map((x) => x.id)).not.toContain("ses_old")
  })

  test("keep of an unknown id changes nothing", () => {
    const now = 100_000_000
    const list = [
      session({ id: "recent-1", created: now - 1000, updated: now - 100 }),
      session({ id: "recent-2", created: now - 2000, updated: now - 200 }),
      session({ id: "ses_old", created: now - 30_000_000, updated: now - 30_000_000 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now, keep: ["ses_missing"] })
    expect(result.map((x) => x.id)).toEqual(["recent-1", "recent-2"])
  })

  test("collapse keeps the latest five roots even when all were touched recently", () => {
    const now = 1_000_000
    const list = [
      session({ id: "s1", created: now - 1000, updated: now - 100 }),
      session({ id: "s2", created: now - 2000, updated: now - 200 }),
      session({ id: "s3", created: now - 3000, updated: now - 300 }),
      session({ id: "s4", created: now - 4000, updated: now - 400 }),
      session({ id: "s5", created: now - 5000, updated: now - 500 }),
      session({ id: "s6", created: now - 6000, updated: now - 600 }),
    ]

    const lenient = trimSessions(list, { limit: 5, permission: {}, now })
    expect(lenient.map((x) => x.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"])

    const collapse = trimSessions(list, { limit: 5, permission: {}, now, recent: 0 })
    expect(collapse.map((x) => x.id)).toEqual(["s1", "s2", "s3", "s4", "s5"])
  })

  test("collapse still keeps the viewed session and its root", () => {
    const now = 1_000_000
    const list = [
      session({ id: "s1", created: now - 1000, updated: now - 100 }),
      session({ id: "s2", created: now - 2000, updated: now - 200 }),
      session({ id: "z-root", created: now - 30_000_000, updated: now - 30_000_000 }),
      session({ id: "z-child", parentID: "z-root", created: now - 30_000_000, updated: now - 30_000_000 }),
    ]

    const collapse = trimSessions(list, { limit: 1, permission: {}, now, recent: 0, keep: ["z-child"] })
    const ids = collapse.map((x) => x.id)
    expect(ids).toContain("s1")
    expect(ids).toContain("z-child")
    expect(ids).toContain("z-root")
  })
})
