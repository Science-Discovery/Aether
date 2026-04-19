import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { loadBranchTreeSessions, mergeSessionsByID } from "./branch-tree-loader"

const session = (input: Partial<Session> & Pick<Session, "id" | "title">): Session => ({
  id: input.id,
  slug: input.slug ?? input.id,
  projectID: input.projectID ?? "project",
  directory: input.directory ?? "/repo",
  title: input.title,
  version: input.version ?? "1",
  time: input.time ?? { created: 1, updated: 1 },
  parentID: input.parentID,
})

describe("loadBranchTreeSessions", () => {
  test("loads ancestors and descendants for the current branch tree", async () => {
    const root = session({ id: "root", title: "Root", time: { created: 1, updated: 1 } })
    const childB = session({ id: "child-b", title: "Child B", parentID: "root", time: { created: 3, updated: 3 } })
    const childA = session({ id: "child-a", title: "Child A", parentID: "root", time: { created: 2, updated: 2 } })
    const grandchild = session({
      id: "grandchild",
      title: "Grandchild",
      parentID: "child-a",
      time: { created: 4, updated: 4 },
    })

    const sessions = new Map([
      [root.id, root],
      [childA.id, childA],
      [childB.id, childB],
      [grandchild.id, grandchild],
    ])

    const children = new Map<string, Session[]>([
      [root.id, [childB, childA]],
      [childA.id, [grandchild]],
    ])

    const result = await loadBranchTreeSessions({
      sessionID: "grandchild",
      getSession: async (sessionID) => {
        const match = sessions.get(sessionID)
        if (!match) throw new Error(`missing session ${sessionID}`)
        return match
      },
      getChildren: async (sessionID) => children.get(sessionID) ?? [],
    })

    expect(result.rootID).toBe("root")
    expect(result.sessions.map((item) => item.id)).toEqual(["child-a", "child-b", "grandchild", "root"])
  })
})

describe("mergeSessionsByID", () => {
  test("replaces matching sessions and keeps store ordering stable by id", () => {
    const existing = [session({ id: "b", title: "Old B" }), session({ id: "c", title: "C" })]
    const incoming = [session({ id: "a", title: "A" }), session({ id: "b", title: "New B" })]

    expect(mergeSessionsByID(existing, incoming).map((item) => `${item.id}:${item.title}`)).toEqual([
      "a:A",
      "b:New B",
      "c:C",
    ])
  })
})
