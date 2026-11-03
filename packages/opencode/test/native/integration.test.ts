import { describe, expect, test } from "bun:test"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Question } from "../../src/question"
import type { QuestionID } from "../../src/question/schema"
import { Native } from "../../src/native/schema"
import { NativeInput } from "../../src/native/input"
import { ReadingModeRoutes } from "../../src/server/routes/reading-mode"
import { Server } from "../../src/server/server"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { buildSessionBackup, importSessionBackup } from "../../src/session/backup"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionRevert } from "../../src/session/revert"
import { MessageID } from "../../src/session/schema"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

describe("native engine integration", () => {
  test("rejects client thread injection while leaving legacy sessions unchanged", async () => {
    expect(Native.Input.safeParse({ type: "codex", thread: "foreign-thread" }).success).toBe(false)
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const legacy = await Session.create({})
        expect(legacy.engine).toBeUndefined()
        expect((await Session.get(legacy.id)).engine).toBeUndefined()
        await expect(Session.setEngine({ sessionID: legacy.id, engine: { type: "codex" } })).rejects.toThrow(
          "cannot be changed",
        )
        const native = await Session.create({ engine: { type: "codex", model: "research" } })
        const fork = await Session.fork({ sessionID: native.id })
        expect(fork.id).not.toBe(native.id)
        expect(fork.engine).toEqual(native.engine)
        expect(fork.parentID).toBeUndefined()
        expect(await Session.messages({ sessionID: fork.id })).toEqual([])
        await Session.setEngine({
          sessionID: native.id,
          engine: { type: "codex", model: "research", thread: "thread-1" },
        })
        expect((await Session.get(native.id)).engine).toEqual({ type: "codex", model: "research", thread: "thread-1" })
        await expect(SessionRevert.revert({ sessionID: native.id, messageID: MessageID.ascending() })).rejects.toThrow(
          "NativeSessionUnsupported",
        )
        expect((await Session.get(native.id)).revert).toBeUndefined()
        await expect(
          SessionPrompt.shell({ sessionID: native.id, agent: "codex", command: "echo forbidden" }),
        ).rejects.toThrow("NativeSessionUnsupported")
        await expect(SessionPrompt.command({ sessionID: native.id, command: "init", arguments: "" })).rejects.toThrow(
          "NativeSessionUnsupported",
        )
        await expect(importSessionBackup(buildSessionBackup(await Session.get(native.id), []))).rejects.toThrow(
          "InvalidSessionBackupError",
        )
        await expect(
          SessionCompaction.create({
            sessionID: native.id,
            agent: "codex",
            auto: false,
            model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("research") },
          }),
        ).rejects.toThrow("NativeSessionUnsupported")
        expect(await Session.messages({ sessionID: native.id })).toEqual([])
      },
    })
  })

  test("steer API rejects native sessions before appending unsent context", async () => {
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        const response = await Server.Default().request(
          `/session/${session.id}/steer?directory=${encodeURIComponent(dir.path)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "Do not lose this context" }),
          },
        )
        expect(response.status).toBe(400)
        expect((await response.json()).name).toBe("NativeSessionUnsupported")
        expect(await Session.messages({ sessionID: session.id })).toEqual([])
      },
    })
  })

  test("upgrades a previously opened project store without losing its sessions", async () => {
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const legacy = await Session.create({ title: "Existing research" })
        const id = Instance.project.id
        Database.attach(id).$client.exec("ALTER TABLE session DROP COLUMN engine")
        Database.detach(id)
        const reopened = Database.attach(id)
        expect(reopened.$client.prepare("PRAGMA table_info(session)").all()).toContainEqual(
          expect.objectContaining({ name: "engine" }),
        )
        expect((await Session.get(legacy.id)).title).toBe("Existing research")
        expect((await Session.get(legacy.id)).engine).toBeUndefined()
        const native = await Session.create({ engine: { type: "codex" } })
        Database.detach(id)
        expect((await Session.get(native.id)).engine).toEqual({ type: "codex", permission: "auto" })
      },
    })
  })

  test("cancelling a native question removes its UI card exactly once", async () => {
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        const events: QuestionID[] = []
        const unsubscribe = Bus.subscribe(Question.Event.Rejected, (event) => {
          events.push(event.properties.requestID)
        })
        const controller = new AbortController()
        const pending = Question.runPromise(
          (service) =>
            service.ask({
              sessionID: session.id,
              questions: [
                { header: "Codex", question: "Allow command?", options: [{ label: "Allow", description: "Once" }] },
              ],
            }),
          { signal: controller.signal },
        ).catch(() => undefined)
        const question = (await Question.list())[0]
        expect(question).toBeDefined()
        controller.abort()
        await pending
        expect(await Question.list()).toEqual([])
        expect(events).toEqual([question.id])
        unsubscribe()
      },
    })
  })

  test("reading sessions preserve the chosen engine and never reuse another engine's session", async () => {
    await using dir = await tmpdir()
    const pdf = await PDFDocument.create()
    pdf.addPage()
    await Bun.write(path.join(dir.path, "paper.pdf"), await pdf.save())
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const app = ReadingModeRoutes()
        const request = (engine?: { type: "codex" }) =>
          app.request("/session/from-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: "paper.pdf", engine }),
          })
        const legacy = (await (await request()).json()) as { action: string; session: Session.Info }
        const native = (await (await request({ type: "codex" })).json()) as { action: string; session: Session.Info }
        expect(legacy.action).toBe("created")
        expect(native.action).toBe("created")
        expect(native.session.id).not.toBe(legacy.session.id)
        expect(native.session.engine).toEqual({ type: "codex", permission: "auto" })
        const reused = (await (await request({ type: "codex" })).json()) as { action: string; session: Session.Info }
        expect(reused.action).toBe("existing")
        expect(reused.session.id).toBe(native.session.id)
        const form = new FormData()
        form.append(
          "pdf",
          new File([Uint8Array.from(await pdf.save()).buffer], "upload.pdf", { type: "application/pdf" }),
        )
        form.append("engine", JSON.stringify({ type: "codex", thread: "injected" }))
        expect((await app.request("/session", { method: "POST", body: form })).status).toBe(400)
        form.set("engine", JSON.stringify({ type: "codex" }))
        const uploaded = (await (await app.request("/session", { method: "POST", body: form })).json()) as Session.Info
        expect(uploaded.engine).toEqual({ type: "codex", permission: "auto" })
        await Promise.all([legacy.session.id, native.session.id, uploaded.id].map(Session.remove))
      },
    })
  })

  test("deleting a native session removes only its own attachments", async () => {
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const first = await Session.create({ engine: { type: "codex" } })
        const second = await Session.create({ engine: { type: "codex" } })
        const file = path.join(NativeInput.directory(first.id), "attachment.txt")
        const other = path.join(NativeInput.directory(second.id), "attachment.txt")
        await Bun.write(file, "one")
        await Bun.write(other, "two")
        await Session.remove(first.id)
        expect(await Bun.file(file).exists()).toBe(false)
        expect(await Bun.file(other).text()).toBe("two")
        await Session.remove(second.id)
      },
    })
  })
})
