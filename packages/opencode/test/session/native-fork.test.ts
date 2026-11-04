import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: () => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  try {
    await Instance.provide({ directory: dir.path, fn: run })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
}

function row(id: Session.Info["id"]) {
  return Database.useProject(Instance.project.id, (db) =>
    db.select().from(SessionTable).where(eq(SessionTable.id, id)).get(),
  )!
}

async function legacy(source: Session.Info) {
  return Session.createNext({
    directory: source.directory,
    title: "Legacy Codex fork",
    engine: { type: "codex", permission: "user" },
    parentID: source.id,
    treeID: source.treeID,
    forkParentSessionID: source.id,
    forkAfterUserMessageID: MessageID.ascending(),
  })
}

test("new native forks are independent and keep the actual source without normalizing to an ancestor", async () => {
  await scenario(async () => {
    const source = await Session.create({ title: "Codex source", engine: { type: "codex", permission: "user" } })
    const first = await Session.fork({ sessionID: source.id })
    const second = await Session.fork({ sessionID: first.id })
    for (const session of [first, second]) {
      expect(session.parentID).toBeUndefined()
      expect(row(session.id).parent_id).toBeNull()
      expect(session.treeID).toBe(source.treeID)
      expect(session.engine?.thread).toBeUndefined()
    }
    expect(first.forkParentSessionID).toBe(source.id)
    expect(second.forkParentSessionID).toBe(first.id)
    expect(second.forkIndex).toBe(2)
    expect(await Session.children(source.id)).toEqual([])
    expect(await Session.children(first.id)).toEqual([])
    expect([...Session.list({ directory: source.directory, roots: true })].map((entry) => entry.id).sort()).toEqual(
      [source.id, first.id, second.id].sort(),
    )
    await Session.remove(first.id)
    expect((await Session.get(second.id)).forkParentSessionID).toBe(first.id)
    expect((await Session.get(source.id)).id).toBe(source.id)
  })
})

test("legacy native forks project as roots before local and global pagination without rewriting stored ancestry", async () => {
  await scenario(async () => {
    const source = await Session.create({ title: "Codex source", engine: { type: "codex", permission: "user" } })
    const fork = await legacy(source)
    const child = await Session.create({ parentID: source.id, engine: { type: "codex", permission: "user" } })
    Database.useProject(Instance.project.id, (db) => {
      db.update(SessionTable).set({ time_updated: 100 }).where(eq(SessionTable.id, source.id)).run()
      db.update(SessionTable).set({ time_updated: 200 }).where(eq(SessionTable.id, fork.id)).run()
      db.update(SessionTable).set({ time_updated: 300 }).where(eq(SessionTable.id, child.id)).run()
    })
    const before = row(fork.id)
    const current = await Session.get(fork.id)
    expect(current.parentID).toBeUndefined()
    expect((await Session.getGlobal(fork.id)).parentID).toBeUndefined()
    expect(current.forkParentSessionID).toBe(source.id)
    expect(current.forkAfterUserMessageID).toBe(fork.forkAfterUserMessageID)
    expect([...Session.list({ directory: source.directory, roots: true, limit: 1 })].map((entry) => entry.id)).toEqual([
      fork.id,
    ])
    expect(
      [...Session.listGlobal({ directory: source.directory, roots: true, limit: 1 })].map((entry) => entry.id),
    ).toEqual([fork.id])
    expect(
      [...Session.listGlobal({ directory: source.directory, roots: true, cursor: 200 })].map((entry) => entry.id),
    ).toEqual([source.id])
    expect(
      [...Session.list({ directory: source.directory, roots: true, search: "Legacy" })].map((entry) => entry.id),
    ).toEqual([fork.id])
    expect((await Session.get(child.id)).parentID).toBe(source.id)
    expect(await Session.children(source.id)).toEqual([])
    await Session.tree(source.id)
    expect(row(fork.id)).toEqual(before)
  })
})

test("archiving a native source or an independent legacy fork does not archive the other conversations", async () => {
  await scenario(async () => {
    const source = await Session.create({ engine: { type: "codex", permission: "user" } })
    const first = await legacy(source)
    const second = await legacy(first)
    await Session.archive(source.id)
    expect((await Session.get(source.id)).time.archived).toBeDefined()
    expect((await Session.get(first.id)).time.archived).toBeUndefined()
    expect((await Session.get(second.id)).time.archived).toBeUndefined()
    await Session.archive(first.id)
    const current = await Session.get(first.id)
    expect(current.time.archived).toBeDefined()
    expect(current.parentID).toBeUndefined()
    expect(current.forkParentSessionID).toBe(source.id)
    expect(current.forkAfterUserMessageID).toBe(first.forkAfterUserMessageID)
    expect((await Session.get(second.id)).time.archived).toBeUndefined()
    expect(row(first.id).parent_id).toBe(source.id)
    await Session.unarchive(source.id)
    expect((await Session.get(source.id)).time.archived).toBeUndefined()
    expect((await Session.get(first.id)).time.archived).toBeDefined()
    await Session.unarchive(first.id)
    expect((await Session.get(first.id)).time.archived).toBeUndefined()
    expect((await Session.get(first.id)).forkParentSessionID).toBe(source.id)
  })
})

test("deleting a native source preserves legacy forks while ordinary Aether forks retain recursive deletion", async () => {
  await scenario(async () => {
    const source = await Session.create({ engine: { type: "codex", permission: "user" } })
    const first = await legacy(source)
    const second = await legacy(first)
    await Session.remove(source.id)
    await expect(Session.get(source.id)).rejects.toMatchObject({ name: "NotFoundError" })
    expect((await Session.get(first.id)).forkParentSessionID).toBe(source.id)
    expect((await Session.get(second.id)).forkParentSessionID).toBe(first.id)
    await Session.remove(first.id)
    expect((await Session.get(second.id)).id).toBe(second.id)

    const root = await Session.create({ title: "Aether source" })
    const branch = await Session.fork({ sessionID: root.id })
    const child = await Session.create({ parentID: root.id })
    expect(branch.parentID).toBe(root.id)
    expect(branch.forkParentSessionID).toBe(root.id)
    expect((await Session.children(root.id)).map((entry) => entry.id)).toEqual([branch.id])
    const roots = [...Session.list({ directory: root.directory, roots: true })].map((entry) => entry.id)
    expect(roots).toContain(root.id)
    expect(roots).toContain(second.id)
    expect(roots).not.toContain(branch.id)
    expect(roots).not.toContain(child.id)
    expect((await Session.get(child.id)).parentID).toBe(root.id)
    await Session.remove(root.id)
    await expect(Session.get(root.id)).rejects.toMatchObject({ name: "NotFoundError" })
    await expect(Session.get(branch.id)).rejects.toMatchObject({ name: "NotFoundError" })
    expect((await Session.get(second.id)).id).toBe(second.id)
  })
})
