import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "fs/promises"
import { eq } from "drizzle-orm"
import { FeishuManager } from "../../src/mobile/feishu"
import { QQManager } from "../../src/mobile/qq"
import { WeChatManager } from "../../src/mobile/wechat"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { platformDir } from "../../src/persist/naming"
import { Database } from "../../src/storage/db"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const managers = { feishu: FeishuManager, qq: QQManager, wechat: WeChatManager }
const platforms = ["feishu", "qq", "wechat"] as const
const scope = "chat_main"

let root = ""
const realAppData = process.env.APPDATA
const realDisableShare = process.env.OPENCODE_DISABLE_SHARE

beforeAll(async () => {
  const tmp = await tmpdir()
  root = tmp.path
  process.env.APPDATA = root
  process.env.OPENCODE_DISABLE_SHARE = "true"
})

afterAll(async () => {
  if (realAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = realAppData
  if (realDisableShare === undefined) delete process.env.OPENCODE_DISABLE_SHARE
  else process.env.OPENCODE_DISABLE_SHARE = realDisableShare
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const p of platforms) {
    const m = managers[p] as any
    m.sessionMap = {}
    m._scopeDirs = {}
    m._initialized = true
    await rm(platformDir(p), { recursive: true, force: true })
  }
})

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

async function provide<R>(dir: string, fn: () => R): Promise<R> {
  return Instance.provide({ directory: dir, init: InstanceBootstrap, fn })
}

async function seedSessions(dir: string, count: number): Promise<string[]> {
  return provide(dir, async () => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      ids.push((await Session.create({})).id)
    }
    return ids
  })
}

async function setUpdated(dir: string, ids: string[]): Promise<void> {
  await provide(dir, () => {
    const pid = Instance.project.id
    Database.useProject(pid, (db) => {
      ids.forEach((id, i) => {
        db.update(SessionTable)
          .set({ time_updated: 1_000_000 + i })
          .where(eq(SessionTable.id, id))
          .run()
      })
    })
  })
}

async function makeFork(dir: string, rootId: string): Promise<string> {
  return provide(dir, async () => {
    const fork = await Session.create({ parentID: SessionID.make(rootId) })
    Database.useProject(Instance.project.id, (db) =>
      db
        .update(SessionTable)
        .set({ fork_parent_session_id: rootId, time_updated: 1_000_000 })
        .where(eq(SessionTable.id, fork.id))
        .run(),
    )
    return fork.id
  })
}

function arm(p: (typeof platforms)[number], dir: string, sessionId: string) {
  const m = managers[p] as any
  m.sessionMap = { [scope]: sessionId }
  m._scopeDirs = { [scope]: dir }
}

function pinOf(p: (typeof platforms)[number]): string | undefined {
  return (managers[p] as any).sessionMap[scope]
}

describe("mobile session pin preservation", () => {
  for (const p of platforms) {
    test(`${p}: initSessions keeps a pinned non-latest session`, async () => {
      await using tmp = await tmpdir()
      const ids = await seedSessions(tmp.path, 2)
      await setUpdated(tmp.path, ids)
      arm(p, tmp.path, ids[0])

      await (managers[p] as any).initSessions()

      expect(pinOf(p)).toBe(ids[0])
    })

    test(`${p}: initSessions keeps a pinned fork session`, async () => {
      await using tmp = await tmpdir()
      const ids = await seedSessions(tmp.path, 2)
      await setUpdated(tmp.path, ids)
      const forkId = await makeFork(tmp.path, ids[0])
      arm(p, tmp.path, forkId)

      await (managers[p] as any).initSessions()

      expect(pinOf(p)).toBe(forkId)
    })

    test(`${p}: initSessions drops a pin whose session is archived`, async () => {
      await using tmp = await tmpdir()
      const ids = await seedSessions(tmp.path, 1)
      arm(p, tmp.path, ids[0])
      await provide(tmp.path, () => Session.archive(SessionID.make(ids[0])))

      await (managers[p] as any).initSessions()

      expect(pinOf(p)).toBeUndefined()
    })

    test(`${p}: initSessions drops a pin whose session no longer exists`, async () => {
      await using tmp = await tmpdir()
      await seedSessions(tmp.path, 1)
      arm(p, tmp.path, "ses_does_not_exist")

      await (managers[p] as any).initSessions()

      expect(pinOf(p)).toBeUndefined()
    })

    test(`${p}: currentSession keeps a pin ranked beyond the recent-20 window`, async () => {
      await using tmp = await tmpdir()
      const ids = await seedSessions(tmp.path, 25)
      await setUpdated(tmp.path, ids)
      arm(p, tmp.path, ids[0])

      const current = await (managers[p] as any).currentSession(scope)

      expect(current).toBe(ids[0])
      expect(pinOf(p)).toBe(ids[0])
    })

    test(`${p}: currentSession keeps a pinned fork session`, async () => {
      await using tmp = await tmpdir()
      const ids = await seedSessions(tmp.path, 2)
      await setUpdated(tmp.path, ids)
      const forkId = await makeFork(tmp.path, ids[0])
      arm(p, tmp.path, forkId)

      const current = await (managers[p] as any).currentSession(scope)

      expect(current).toBe(forkId)
      expect(pinOf(p)).toBe(forkId)
    })

    test(`${p}: currentSession falls back to latest when the pin is stale`, async () => {
      await using tmp = await tmpdir()
      const ids = await seedSessions(tmp.path, 2)
      await setUpdated(tmp.path, ids)
      arm(p, tmp.path, "ses_does_not_exist")

      const current = await (managers[p] as any).currentSession(scope)

      expect(current).toBe(ids[1])
      expect(pinOf(p)).toBe(ids[1])
    })

    test(`${p}: currentSession creates a session when the project has none`, async () => {
      await using tmp = await tmpdir()
      arm(p, tmp.path, "ses_does_not_exist")

      const current = await (managers[p] as any).currentSession(scope, true)

      expect(current).toBeTruthy()
      expect(pinOf(p)).toBe(current)
    })
  }
})
