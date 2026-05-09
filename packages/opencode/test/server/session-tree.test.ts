import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.tree endpoint", () => {
  test("returns the full tree for sessions in the new branch tree system", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await Session.create({ title: "Root" })
        const child = await Session.fork({ sessionID: root.id })
        const sibling = await Session.fork({ sessionID: root.id })

        const app = Server.Default()
        const response = await app.request(`/session/${child.id}/tree`)

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.kind).toBe("tree")
        expect(body.treeID).toBe(root.treeID)
        expect(body.sessions).toHaveLength(3)
        expect(body.sessions[0].id).toBe(root.id)
        expect(body.sessions.map((session: Session.Info) => session.id)).toContain(root.id)
        expect(body.sessions.map((session: Session.Info) => session.id)).toContain(child.id)
        expect(body.sessions.map((session: Session.Info) => session.id)).toContain(sibling.id)
      },
    })
  })

  test("returns legacy state for sessions without treeID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const legacy = await Session.create({ title: "Legacy" })
        Database.useProject(legacy.projectID, (db) =>
          db.update(SessionTable).set({ tree_id: null }).where(eq(SessionTable.id, legacy.id)).run(),
        )

        const app = Server.Default()
        const response = await app.request(`/session/${legacy.id}/tree`)

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.kind).toBe("legacy")
      },
    })
  })
})
