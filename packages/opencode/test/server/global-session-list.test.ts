import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"

Log.init({ print: false })

describe("Session.listGlobal", () => {
  test("lists sessions across projects with project metadata", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    const firstSession = await Instance.provide({
      directory: first.path,
      fn: async () => Session.create({ title: "first-session" }),
    })
    const secondSession = await Instance.provide({
      directory: second.path,
      fn: async () => Session.create({ title: "second-session" }),
    })

    const sessions = [...Session.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).toContain(firstSession.id)
    expect(ids).toContain(secondSession.id)

    const firstProject = Project.get(firstSession.projectID)
    const secondProject = Project.get(secondSession.projectID)

    const firstItem = sessions.find((session) => session.id === firstSession.id)
    const secondItem = sessions.find((session) => session.id === secondSession.id)

    expect(firstItem?.project?.id).toBe(firstProject?.id)
    expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
    expect(secondItem?.project?.id).toBe(secondProject?.id)
    expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
  })

  test("supports archived include/only modes and legacy archived=true compatibility", async () => {
    await using tmp = await tmpdir({ git: true })

    const archived = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({ title: "archived-session" }),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.setArchived({ sessionID: archived.id, time: Date.now() }),
    })

    const sessions = [...Session.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).not.toContain(archived.id)

    const allSessions = [...Session.listGlobal({ limit: 200, archived: true })]
    const allIds = allSessions.map((session) => session.id)

    expect(allIds).toContain(archived.id)

    const includeByMode = [...Session.listGlobal({ limit: 200, archivedMode: "include" })]
    expect(includeByMode.map((session) => session.id)).toContain(archived.id)

    const onlyArchived = [...Session.listGlobal({ limit: 200, archivedMode: "only" })]
    const onlyArchivedIDs = onlyArchived.map((session) => session.id)
    expect(onlyArchivedIDs).toContain(archived.id)
    expect(onlyArchivedIDs.length).toBeGreaterThan(0)

    const explicitExclude = [...Session.listGlobal({ limit: 200, archivedMode: "exclude" })]
    expect(explicitExclude.map((session) => session.id)).not.toContain(archived.id)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.setArchived({ sessionID: archived.id, time: 0 }),
    })
    const afterUnarchive = [...Session.listGlobal({ limit: 200, archivedMode: "exclude" })]
    expect(afterUnarchive.map((session) => session.id)).toContain(archived.id)
  })

  test("supports cursor pagination", async () => {
    await using tmp = await tmpdir({ git: true })

    const first = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({ title: "page-one" }),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({ title: "page-two" }),
    })

    const page = [...Session.listGlobal({ directory: tmp.path, limit: 1 })]
    expect(page.length).toBe(1)
    expect(page[0].id).toBe(second.id)

    const next = [...Session.listGlobal({ directory: tmp.path, limit: 10, cursor: page[0].time.updated })]
    const ids = next.map((session) => session.id)

    expect(ids).toContain(first.id)
    expect(ids).not.toContain(second.id)
  })

  test("directory filter is case-insensitive on Windows", async () => {
    if (process.platform !== "win32") return
    await using tmp = await tmpdir({ git: true })

    const created = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({ title: "global-directory-case-insensitive" }),
    })

    const lower = Filesystem.resolve(tmp.path).toLowerCase()
    const listed = [...Session.listGlobal({ directory: lower, limit: 200, archivedMode: "include" })]
    const ids = new Set(listed.map((session) => session.id))

    expect(ids.has(created.id)).toBe(true)
  })
})
