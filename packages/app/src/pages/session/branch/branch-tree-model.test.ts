import { describe, expect, test } from "bun:test"
import type { Message, Part, Session, TextPart } from "@opencode-ai/sdk/v2"
import { buildBranchTreeRows } from "./branch-tree-model"

const session = (input: Partial<Session> & Pick<Session, "id" | "title">): Session => ({
  id: input.id,
  slug: input.slug ?? input.id,
  projectID: input.projectID ?? "project",
  directory: input.directory ?? "/repo",
  title: input.title,
  treeID: input.treeID,
  version: input.version ?? "1",
  time: input.time ?? { created: 1, updated: 1 },
  parentID: input.parentID,
})

const message = (
  input: {
    id: string
    sessionID: string
    role: Message["role"]
    parentID?: string
    time?: { created: number }
  } & Record<string, unknown>,
): Message =>
  ({
    id: input.id,
    sessionID: input.sessionID,
    role: input.role,
    time: input.time ?? { created: 1 },
    parentID: input.role === "assistant" ? input.parentID ?? "user" : undefined,
    agent: input.agent ?? "build",
    modelID: input.modelID ?? "model",
    providerID: input.providerID ?? "provider",
    mode: input.mode ?? "build",
    path: input.path ?? { cwd: "/repo", root: "/repo" },
    cost: input.cost ?? 0,
    tokens: input.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as Message

const text = (input: Pick<TextPart, "id" | "sessionID" | "messageID" | "text">): TextPart => ({
  id: input.id,
  sessionID: input.sessionID,
  messageID: input.messageID,
  type: "text",
  text: input.text,
})

describe("buildBranchTreeRows", () => {
  test("walks to the root and sorts siblings by creation time", () => {
    const root = session({ id: "root", title: "Root", time: { created: 1, updated: 1 } })
    const later = session({
      id: "later",
      parentID: "root",
      title: "Later",
      time: { created: 3, updated: 3 },
    })
    const earlier = session({
      id: "earlier",
      parentID: "root",
      title: "Earlier",
      time: { created: 2, updated: 2 },
    })

    const result = buildBranchTreeRows({
      currentSessionID: "later",
      treeSessions: [later, root, earlier],
      previewPlaceholder: "empty",
    })

    expect(result.rootIDs).toEqual(["root"])
    expect(result.rows.map((row) => row.id)).toEqual(["root", "earlier", "later"])
  })

  test("uses the first branch-specific user message for child previews", () => {
    const root = session({ id: "root", title: "Root" })
    const child = session({ id: "child", parentID: "root", title: "Child", time: { created: 2, updated: 2 } })
    const rootUser = message({ id: "m-root-user", sessionID: "root", role: "user" })
    const rootAssistant = message({ id: "m-root-assistant", sessionID: "root", role: "assistant", parentID: "m-root-user" })
    const childRootUser = message({ id: "m-child-user-copy", sessionID: "child", role: "user" })
    const childRootAssistant = message({
      id: "m-child-assistant-copy",
      sessionID: "child",
      role: "assistant",
      parentID: "m-child-user-copy",
    })
    const childUser = message({ id: "m-child-user", sessionID: "child", role: "user", time: { created: 3 } })

    const messagesBySession = {
      root: [rootUser, rootAssistant],
      child: [childRootUser, childRootAssistant, childUser],
    }
    const partsByMessage: Record<string, Part[] | undefined> = {
      [rootUser.id]: [text({ id: "p1", sessionID: "root", messageID: rootUser.id, text: "Original root prompt" })],
      [rootAssistant.id]: [text({ id: "p2", sessionID: "root", messageID: rootAssistant.id, text: "Answer" })],
      [childRootUser.id]: [text({ id: "p3", sessionID: "child", messageID: childRootUser.id, text: "Original root prompt" })],
      [childRootAssistant.id]: [
        text({ id: "p4", sessionID: "child", messageID: childRootAssistant.id, text: "Answer" }),
      ],
      [childUser.id]: [text({ id: "p5", sessionID: "child", messageID: childUser.id, text: "Try a narrower approach" })],
    }

    const result = buildBranchTreeRows({
      currentSessionID: "child",
      treeSessions: [root, child],
      allSessions: [root, child],
      messagesBySession,
      partsByMessage,
      previewPlaceholder: "empty",
    })

    expect(result.rows.find((row) => row.id === "root")?.previewText).toBe("Original root prompt")
    expect(result.rows.find((row) => row.id === "child")?.previewText).toBe("Try a narrower approach")
  })

  test("falls back to the placeholder when a fork has no new user message yet", () => {
    const root = session({ id: "root", title: "Root" })
    const child = session({ id: "child", parentID: "root", title: "Child", time: { created: 2, updated: 2 } })
    const rootUser = message({ id: "m-root-user", sessionID: "root", role: "user" })
    const childUser = message({ id: "m-child-user-copy", sessionID: "child", role: "user" })

    const result = buildBranchTreeRows({
      currentSessionID: "child",
      treeSessions: [root, child],
      allSessions: [root, child],
      messagesBySession: {
        root: [rootUser],
        child: [childUser],
      },
      partsByMessage: {
        [rootUser.id]: [text({ id: "p1", sessionID: "root", messageID: rootUser.id, text: "Original root prompt" })],
        [childUser.id]: [text({ id: "p2", sessionID: "child", messageID: childUser.id, text: "Original root prompt" })],
      },
      previewPlaceholder: "No messages yet",
    })

    expect(result.rows.find((row) => row.id === "child")?.previewText).toBe("No messages yet")
  })

  test("treats a tree node with a parent outside the tree as the visible root", () => {
    const legacyParent = session({ id: "legacy-parent", title: "Legacy Parent" })
    const treeRoot = session({
      id: "tree-root",
      parentID: "legacy-parent",
      title: "Tree Root",
      treeID: "tree-1",
      time: { created: 2, updated: 2 },
    })
    const child = session({
      id: "child",
      parentID: "tree-root",
      title: "Child",
      treeID: "tree-1",
      time: { created: 3, updated: 3 },
    })

    const result = buildBranchTreeRows({
      currentSessionID: "child",
      treeSessions: [treeRoot, child],
      allSessions: [legacyParent, treeRoot, child],
      previewPlaceholder: "empty",
    })

    expect(result.rootIDs).toEqual(["tree-root"])
    expect(result.rows.map((row) => row.id)).toEqual(["tree-root", "child"])
  })
})
