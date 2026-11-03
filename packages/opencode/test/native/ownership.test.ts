import { expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { NativeLock } from "../../src/native/lock"
import { NativeOwnership } from "../../src/native/ownership"
import { NativeQueue } from "../../src/native/queue"
import { NativeRuntime } from "../../src/native/runtime"
import { NativeStore } from "../../src/native/store"
import { tmpdir } from "../fixture/fixture"

const fixture = path.join(import.meta.dir, "fixture.ts")

async function scenario(run: (session: Session.Info) => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.createNext({
          directory: Instance.directory,
          engine: { type: "codex", thread: "thread" },
        })
        await NativeStore.migrate(session)
        await NativeRuntime.configure({ path: process.execPath, limit: 2 })
        await run(session)
      },
    })
  } finally {
    await NativeRuntime.dispose(dir.path)
    await Instance.disposeDirectory(dir.path)
  }
}

test("releasing an idle chat closes only its owned process and preserves history", async () => {
  await scenario(async (session) => {
    const lease = await NativeRuntime.acquire({ id: session.id, directory: Instance.directory, args: [fixture] })
    await lease.release(true)
    const other = await NativeRuntime.acquire({ id: "other", directory: Instance.directory, args: [fixture] })
    const before = await NativeStore.history(session.id)
    expect(await NativeOwnership.release(session.id)).toEqual({ released: true })
    expect(lease.client.closed).toBe(true)
    expect(other.client.closed).toBe(false)
    expect(await NativeStore.history(session.id)).toEqual(before)
    expect((await Session.get(session.id)).engine?.thread).toBe("thread")
    expect(await NativeOwnership.release(session.id)).toEqual({ released: false })
    await other.release(false)
  })
})

test("releasing never cancels an active task or a reserved history operation", async () => {
  await scenario(async (session) => {
    const lease = await NativeRuntime.acquire({ id: session.id, directory: Instance.directory, args: [fixture] })
    await expect(NativeOwnership.release(session.id)).rejects.toThrow("finish")
    expect(lease.client.closed).toBe(false)
    await lease.release(true)
    await SessionStatus.set(session.id, { type: "busy" })
    await expect(NativeOwnership.release(session.id)).rejects.toThrow("Finish")
    expect(lease.client.closed).toBe(false)
    await SessionStatus.set(session.id, { type: "idle" })
    await NativeLock.run(session.id, async () => {
      await expect(NativeOwnership.release(session.id)).rejects.toThrow("operation")
    })
    expect(lease.client.closed).toBe(false)
  })
})

test("releasing refuses queued input and a conversation from another directory", async () => {
  await scenario(async (session) => {
    await NativeQueue.enqueue({ sessionID: session.id, messageID: MessageID.ascending(), text: "Keep this queued" })
    await expect(NativeOwnership.release(session.id)).rejects.toThrow("queued")
    expect((await NativeQueue.list(session.id)).items).toHaveLength(1)
    await using dir = await tmpdir()
    const other = await Session.createNext({ directory: dir.path, engine: { type: "codex", thread: "other" } })
    await expect(NativeOwnership.release(other.id)).rejects.toThrow("project")
  })
})

for (const mode of ["child", "goal", "cursor"])
  test(`releasing checks the owned native process and refuses ${mode} work without closing it`, async () => {
    await scenario(async (session) => {
      const lease = await NativeRuntime.acquire({
        id: session.id,
        directory: Instance.directory,
        args: [path.join(import.meta.dir, "ownership-fixture.ts")],
      })
      lease.bind("thread")
      NativeStore.bind(session.id, Instance.directory)
      await lease.release(true)
      await Bun.write(path.join(Instance.directory, "ownership-mode"), mode)
      const error = await NativeOwnership.release(session.id).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(lease.client.closed).toBe(false)
      await Bun.write(path.join(Instance.directory, "ownership-mode"), "idle")
      expect(await NativeOwnership.release(session.id)).toEqual({ released: true })
      expect(lease.client.closed).toBe(true)
    })
  })
