import { describe, expect, test } from "bun:test"
import type { Project } from "@opencode-ai/sdk/v2/client"
import { projectID, resolveProject } from "./bootstrap"

function project(input: { id: string; worktree: string; sandboxes?: string[] }): Project {
  return {
    id: input.id,
    worktree: input.worktree,
    vcs: "git",
    sandboxes: input.sandboxes ?? [],
    time: { created: 1, updated: 1 },
  } as Project
}

describe("resolveProject prefers exact worktree over sandbox alias", () => {
  test("directory that is its own project wins over earlier project listing it as sandbox", () => {
    const parent = "/Users/x/pole"
    const child = "/Users/x/pole/child"
    const projects = [
      project({ id: "aa", worktree: child, sandboxes: [parent] }),
      project({ id: "bb", worktree: parent }),
    ]
    expect(resolveProject(parent, projects)?.id).toBe("bb")
    expect(projectID(parent, projects)).toBe("bb")
  })

  test("sandbox fallback still applies when directory is not a project worktree", () => {
    const owner = "/Users/x/repo"
    const sandbox = "/Users/x/repo/.local/worktree/sandbox-1"
    const projects = [project({ id: "aa", worktree: owner, sandboxes: [sandbox] })]
    expect(resolveProject(sandbox, projects)?.id).toBe("aa")
  })

  test("matching tolerates path separator differences", () => {
    const projects = [project({ id: "aa", worktree: "C:\\repo", sandboxes: ["C:/repo/.local/worktree/sandbox-1"] })]
    expect(resolveProject("C:/repo", projects)?.id).toBe("aa")
    expect(resolveProject("C:\\repo\\.local\\worktree\\sandbox-1", projects)?.id).toBe("aa")
  })

  test("no match returns undefined", () => {
    const projects = [project({ id: "aa", worktree: "/a" })]
    expect(resolveProject("/missing", projects)).toBeUndefined()
    expect(projectID("/missing", projects)).toBeUndefined()
  })
})
