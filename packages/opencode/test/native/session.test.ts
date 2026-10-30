import { describe, expect, test } from "bun:test"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Question } from "../../src/question"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { NativeSession } from "../../src/native/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function scenario(mode: string, run: (session: Session.Info, dir: string) => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "session-fixture.ts")
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`,
  )
  if (process.platform !== "win32") await chmod(file, 0o755)
  await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode }))
  await Bun.write(path.join(cfg.path, "aether.json"), JSON.stringify({ native: { codex: { path: file } } }))
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        await run(session, dir.path)
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

async function calls(dir: string) {
  return (await Bun.file(path.join(dir, "calls.jsonl")).text())
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          id?: string
          pid?: number
          method?: string
          params?: Record<string, unknown>
          result?: Record<string, unknown>
          error?: { code: number; message: string }
        },
    )
}

async function question() {
  for (let i = 0; i < 200; i++) {
    const result = await Question.list()
    if (result[0]) return result[0]
    await Bun.sleep(10)
  }
  throw new Error("Codex did not ask a question")
}

async function stopped(pid: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const alive = (() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })()
    if (!alive) return
    await Bun.sleep(50)
  }
  throw new Error("The Codex fixture process did not exit")
}

describe("native Codex session", () => {
  test("permission updates and preserved engine writes do not lose each other's fields", async () => {
    await scenario("normal", async (session) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        await Session.setEngine({ sessionID: session.id, engine: { type: "codex", permission: "user" } })
        const engine = {
          type: "codex" as const,
          thread: `thread-${attempt}`,
          cursor: `cursor-${attempt}`,
          model: "native-model",
          effort: "high",
        }
        const writes = [
          () => Session.setEngine({ sessionID: session.id, engine, preserve: true }),
          () => Session.setNativePermission({ sessionID: session.id, permission: "full" }),
        ]
        await Promise.all((attempt % 2 ? writes.reverse() : writes).map((write) => write()))
        expect((await Session.get(session.id)).engine).toEqual({ ...engine, permission: "full" })
      }
      await Session.setEngine({ sessionID: session.id, engine: { type: "codex", thread: "legacy" } })
      await Session.setEngine({
        sessionID: session.id,
        engine: { type: "codex", thread: "legacy", cursor: "next" },
        preserve: true,
      })
      expect((await Session.get(session.id)).engine).toEqual({ type: "codex", thread: "legacy", cursor: "next" })
    })
  })

  test("permission changes apply to every next turn of the same warm thread and legacy omission remains user", async () => {
    await scenario("normal", async (session, dir) => {
      expect(session.engine?.permission).toBe("auto")
      for (const mode of ["auto", "full", "user"] as const) {
        await Session.setNativePermission({ sessionID: session.id, permission: mode })
        const result = await NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text: `Turn with ${mode} permission` }] },
          await Session.get(session.id),
          new AbortController().signal,
        )
        expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
        expect((await Session.get(session.id)).engine?.permission).toBe(mode)
      }
      const saved = (await Session.get(session.id)).engine!
      await Session.setEngine({ sessionID: session.id, engine: { ...saved, permission: undefined } })
      const result = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Legacy permission omission" }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      expect((await Session.get(session.id)).engine?.permission).toBeUndefined()
      const log = await calls(dir)
      const turns = log.filter((call) => call.method === "turn/start")
      expect(turns).toHaveLength(4)
      expect(log.filter((call) => call.method === "thread/start")).toHaveLength(1)
      expect(log.filter((call) => call.method === "thread/resume")).toHaveLength(0)
      expect(new Set(turns.map((call) => call.params?.threadId))).toEqual(new Set([saved.thread]))
      expect(new Set(turns.map((call) => call.pid)).size).toBe(1)
      expect(turns.map((call) => call.params?.approvalsReviewer)).toEqual(["auto_review", "user", "user", "user"])
      expect(turns.map((call) => call.params?.approvalPolicy)).toEqual([
        "on-request",
        "never",
        "on-request",
        "on-request",
      ])
      expect(turns.map((call) => call.params?.sandboxPolicy)).toEqual([
        {
          type: "workspaceWrite",
          writableRoots: [dir],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        { type: "dangerFullAccess" },
        {
          type: "workspaceWrite",
          writableRoots: [dir],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        {
          type: "workspaceWrite",
          writableRoots: [dir],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      ])
    })
  })

  test("a permission change during an active turn does not resolve its approval or overwrite the saved next-turn mode", async () => {
    await scenario("approval", async (session, dir) => {
      await Session.setNativePermission({ sessionID: session.id, permission: "user" })
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Ask before running" }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      const pending = await question()
      const before = (await Session.get(session.id)).engine!
      await Session.setNativePermission({ sessionID: session.id, permission: "full" })
      expect((await Session.get(session.id)).engine).toEqual({ ...before, permission: "full" })
      expect((await Question.list()).some((item) => item.id === pending.id)).toBe(true)
      expect(
        (await calls(dir)).filter((call) => call.method === "turn/start").map((call) => call.params?.approvalPolicy),
      ).toEqual(["on-request"])
      await Question.reply({ requestID: pending.id, answers: [["Allow once"]] })
      const result = await running
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      expect((await Session.get(session.id)).engine).toEqual({ ...before, permission: "full" })
      expect(await Question.list()).toHaveLength(0)
    })
  })

  test("disabling Codex preserves an active turn, retires its process, and rejects all new input before storage", async () => {
    await scenario("approval", async (session, dir) => {
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Wait for approval" }] },
        session,
        new AbortController().signal,
      )
      const pending = await question()
      const pid = (await calls(dir)).find((call) => call.method === "initialize")?.pid
      expect(pid).toBeNumber()
      await Config.updateGlobal({ native: { codex: { enabled: false } } })
      expect((await Config.getGlobal()).native?.codex?.enabled).toBe(false)
      expect(() => process.kill(pid!, 0)).not.toThrow()
      expect((await Question.list()).some((item) => item.id === pending.id)).toBe(true)
      await Question.reply({ requestID: pending.id, answers: [["Allow once"]] })
      const result = await running
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      await stopped(pid!)
      const count = (await Session.messages({ sessionID: session.id })).length
      for (const noReply of [false, true]) {
        await expect(
          NativeSession.prompt(
            { sessionID: session.id, noReply, parts: [{ type: "text", text: "Rejected" }] },
            await Session.get(session.id),
            new AbortController().signal,
          ),
        ).rejects.toThrow("disabled")
      }
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(count)
    })
  })

  test("deleting a session and disposing an instance release their idle processes", async () => {
    for (const action of ["delete", "dispose"]) {
      await scenario("normal", async (session, dir) => {
        await NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text: "Finish" }] },
          session,
          new AbortController().signal,
        )
        const pid = (await calls(dir)).find((call) => call.method === "initialize")?.pid
        expect(pid).toBeNumber()
        expect(() => process.kill(pid!, 0)).not.toThrow()
        if (action === "delete") await Session.remove(session.id)
        if (action === "dispose") await Instance.dispose()
        await stopped(pid!)
      })
    }
  })

  test("a model declaring text-only input rejects images before starting a thread", async () => {
    await scenario("normal", async (session, dir) => {
      const result = await NativeSession.prompt(
        {
          sessionID: session.id,
          model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("text-model") },
          parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" }],
        },
        session,
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" && result.info.error?.name).toBe("UnknownError")
      expect((await calls(dir)).some((call) => call.method === "thread/start")).toBe(false)
    })
  })

  test("an unloaded thread resumes on its retained connection without replaying the previous input", async () => {
    await scenario("unloaded", async (session, dir) => {
      for (const text of ["First", "Second"]) {
        const result = await NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text }] },
          await Session.get(session.id),
          new AbortController().signal,
        )
        expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      }
      const log = await calls(dir)
      expect(log.filter((call) => call.method === "initialize")).toHaveLength(1)
      expect(log.filter((call) => call.method === "thread/resume")).toHaveLength(1)
      expect(log.filter((call) => call.method === "turn/start").at(-1)?.params?.input).toEqual([
        { type: "text", text: "Second", text_elements: [] },
      ])
    })
  })

  test("switching models does not inherit an unsupported reasoning effort", async () => {
    await scenario("normal", async (session, dir) => {
      await Session.setEngine({
        sessionID: session.id,
        engine: { type: "codex", model: "native-model", effort: "high" },
      })
      const result = await NativeSession.prompt(
        {
          sessionID: session.id,
          model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("text-model") },
          parts: [{ type: "text", text: "Use the simpler model" }],
        },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      expect((await calls(dir)).find((call) => call.method === "turn/start")?.params?.effort).toBeUndefined()
      const engine = (await Session.get(session.id)).engine
      expect(engine?.model).toBe("text-model")
      expect(engine?.effort).toBeUndefined()
    })
  })

  test("persists real protocol events and reuses one initialized process and native thread across turns", async () => {
    await scenario("normal", async (session, dir) => {
      await Bun.write(
        path.join(dir, "aether.json"),
        JSON.stringify({ native: { codex: { path: path.join(dir, "untrusted.exe") } } }),
      )
      const result = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Read the paper" }] },
        session,
        new AbortController().signal,
      )
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("Missing assistant")
      expect(result.info.error).toBeUndefined()
      expect(result.info.tokens).toMatchObject({ input: 5, output: 5, cache: { read: 2 } })
      expect(result.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["Native response"])
      expect(result.parts.some((part) => part.type === "reasoning" && part.text === "Checking evidence.")).toBe(true)
      expect(result.parts.some((part) => part.type === "tool" && part.state.status === "completed")).toBe(true)
      const saved = await Session.get(session.id)
      expect(saved.engine?.model).toBe("native-model")
      expect(saved.engine?.thread).toBeTruthy()
      const next = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Continue" }] },
        saved,
        new AbortController().signal,
      )
      expect(next.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["Native response"])
      const log = await calls(dir)
      expect(log.filter((call) => call.method === "thread/start")).toHaveLength(1)
      expect(log.filter((call) => call.method === "thread/resume")).toHaveLength(0)
      expect(log.filter((call) => call.method === "initialize")).toHaveLength(1)
      expect(new Set(log.map((call) => call.pid)).size).toBe(1)
      expect(log.some((call) => call.method === "thread/read" && call.params?.threadId === saved.engine?.thread)).toBe(
        true,
      )
      expect(
        (await Session.messages({ sessionID: session.id })).filter((entry) => entry.info.role === "assistant"),
      ).toHaveLength(2)
    })
  })

  test("counts all requests in this turn without recounting cached or prior-turn tokens", async () => {
    await scenario("usage", async (session) => {
      const result = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Use tools" }] },
        session,
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" ? result.info.tokens : undefined).toEqual({
        total: 17,
        input: 7,
        output: 7,
        reasoning: 1,
        cache: { read: 3, write: 0 },
      })
    })
  })

  test("only offers native advertised approvals and returns the selected decision", async () => {
    await scenario("approval", async (session, dir) => {
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Run" }] },
        session,
        new AbortController().signal,
      )
      const pending = await question()
      expect(pending.questions[0].options.map((item) => item.label)).toEqual(["Allow once", "Decline", "Cancel turn"])
      await Question.reply({ requestID: pending.id, answers: [["Decline"]] })
      await running
      expect((await calls(dir)).some((call) => call.result?.decision === "decline")).toBe(true)
      expect(await Question.list()).toHaveLength(0)
    })
  })

  test("preserves native question ids when returning free text", async () => {
    await scenario("question", async (session, dir) => {
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Choose" }] },
        session,
        new AbortController().signal,
      )
      const pending = await question()
      await Question.reply({ requestID: pending.id, answers: [["A different paper"]] })
      await running
      const answer = (await calls(dir)).find((call) => call.result?.answers)?.result?.answers
      expect(answer).toEqual({ "paper-choice": { answers: ["A different paper"] } })
    })
  })

  test("command approval falls back to the associated command and directory", async () => {
    await scenario("approval-fallback", async (session, dir) => {
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Review the command" }] },
        session,
        new AbortController().signal,
      )
      const pending = await question()
      expect(pending.questions[0].question).toContain("execute a command")
      expect(pending.questions[0].question).toContain("Command:\npython -i")
      expect(pending.questions[0].question).toContain(`Working directory:\n${dir}`)
      expect(pending.questions[0].question).toContain("remote-research-host")
      await Question.reply({ requestID: pending.id, answers: [["Allow once"]] })
      await running
      expect((await calls(dir)).some((call) => call.result?.decision === "accept")).toBe(true)
    })
  })

  test("stdin approval displays the exact input request and existing terminal command", async () => {
    await scenario("approval-stdin", async (session, dir) => {
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Review terminal input" }] },
        session,
        new AbortController().signal,
      )
      const pending = await question()
      expect(pending.questions[0].question).toContain("send input to an existing terminal")
      expect(pending.questions[0].question).toContain("Existing command:\npython -i")
      expect(pending.questions[0].question).toContain("Input request:\nwrite_stdin --session-id 123 'print(42)'")
      expect(pending.questions[0].question).toContain("Terminal ID: 123")
      await Question.reply({ requestID: pending.id, answers: [["Cancel turn"]] })
      await running
      expect((await calls(dir)).some((call) => call.result?.decision === "cancel")).toBe(true)
    })
  })

  test("a network-only approval displays its destination without requiring a shell command", async () => {
    await scenario("approval-network", async (session, dir) => {
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Review network access" }] },
        session,
        new AbortController().signal,
      )
      const pending = await question()
      expect(pending.questions[0].question).toContain("approval for network access")
      expect(pending.questions[0].question).toContain("Network destination: api.example.test")
      expect(pending.questions[0].question).toContain("Protocol: https")
      expect(pending.questions[0].question).not.toContain("execute a command")
      await Question.reply({ requestID: pending.id, answers: [["Allow once"]] })
      await running
      expect((await calls(dir)).some((call) => call.result?.decision === "accept")).toBe(true)
    })
  })

  test("approvals without reviewable commands, input, destinations, or a known kind fail closed", async () => {
    for (const mode of [
      "approval-missing",
      "approval-stdin-missing-input",
      "approval-stdin-missing-item",
      "approval-network-invalid",
      "approval-kind",
    ]) {
      await scenario(mode, async (session, dir) => {
        await NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text: "Reject an incomplete action" }] },
          session,
          new AbortController().signal,
        )
        expect(await Question.list()).toHaveLength(0)
        expect((await calls(dir)).some((call) => call.error?.code === -32602)).toBe(true)
        expect((await calls(dir)).some((call) => call.result?.decision === "accept")).toBe(false)
      })
    }
  }, 15_000)

  test("file approvals show the associated changes and retain them in a native tool card", async () => {
    await scenario("file-approval", async (session, dir) => {
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Update the paper" }] },
        session,
        new AbortController().signal,
      )
      const pending = await question()
      expect(pending.questions[0].question).toContain("paper.tex")
      expect(pending.questions[0].question).toContain("-Old result")
      expect(pending.questions[0].question).toContain("+Verified result")
      await Question.reply({ requestID: pending.id, answers: [["Allow once"]] })
      const result = await running
      const part = result.parts.find((part) => part.type === "tool" && part.tool === "codex.fileChange")
      expect(part?.type === "tool" && part.state.status).toBe("completed")
      if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Missing file changes")
      expect(part.state.input.changes).toEqual([
        { path: "paper.tex", kind: { type: "update", move_path: null }, diff: "-Old result\n+Verified result" },
      ])
      expect(part.state.output).toContain("Verified result")
      expect((await calls(dir)).some((call) => call.result?.decision === "accept")).toBe(true)
    })
  })

  test("cancels a pending approval without leaving a question or running tool", async () => {
    await scenario("approval", async (session, dir) => {
      const controller = new AbortController()
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Wait" }] },
        session,
        controller.signal,
      )
      await question()
      controller.abort()
      const result = await running
      expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
      expect(await Question.list()).toHaveLength(0)
      expect(result.parts.some((part) => part.type === "tool" && part.state.status === "running")).toBe(false)
      expect((await calls(dir)).some((call) => call.method === "turn/interrupt")).toBe(true)
    })
  })

  test("a native withdrawal removes the old approval while the turn continues", async () => {
    await scenario("withdrawal", async (session, dir) => {
      let completed = false
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Run" }] },
        session,
        new AbortController().signal,
      ).then((result) => {
        completed = true
        return result
      })
      const first = await question()
      await Bun.write(path.join(dir, "withdraw-approval"), "resolve")
      for (let i = 0; i < 200; i++) {
        const pending = await Question.list()
        if (pending.length === 1 && pending[0].id !== first.id) break
        await Bun.sleep(10)
      }
      const pending = await Question.list()
      expect(pending).toHaveLength(1)
      expect(pending[0].id).not.toBe(first.id)
      expect(pending[0].questions[0].question).toContain("echo replacement")
      expect(completed).toBe(false)
      await Question.reply({ requestID: pending[0].id, answers: [["Allow once"]] })
      expect((await running).info.role).toBe("assistant")
      expect(await Question.list()).toHaveLength(0)
    })
  })

  test("root completion waits for a verified child and preserves its approval and response source", async () => {
    await scenario("subagent", async (session, dir) => {
      let completed = false
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Delegate the evidence review" }] },
        session,
        new AbortController().signal,
      ).then((result) => {
        completed = true
        return result
      })
      const pending = await question()
      expect(pending.questions[0].question).toContain("Evidence reader")
      expect(pending.questions[0].question).toContain("echo evidence")
      await Bun.sleep(30)
      expect(completed).toBe(false)
      await Question.reply({ requestID: pending.id, answers: [["Allow once"]] })
      const result = await running
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      const texts = result.parts.filter((part) => part.type === "text").map((part) => part.text)
      expect(texts).toContain("Native response")
      expect(texts).toContain('Codex agent ("Evidence reader"):\n\nChild evidence')
      expect((await calls(dir)).some((call) => call.result?.decision === "accept")).toBe(true)
      expect(await Question.list()).toHaveLength(0)
    })
  })

  test("cancellation interrupts the root and every verified descendant", async () => {
    await scenario("subagent-running", async (session, dir) => {
      const controller = new AbortController()
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Review with two agents" }] },
        session,
        controller.signal,
      )
      const pending = await question()
      expect(pending.questions[0].question).toContain("Equation checker")
      controller.abort()
      const result = await running
      expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
      const ids = (await calls(dir))
        .filter((call) => call.method === "turn/interrupt")
        .map((call) => call.params?.threadId)
      expect(ids).toHaveLength(3)
      expect(ids).toContain("child-thread")
      expect(ids).toContain("grandchild-thread")
      expect(await Question.list()).toHaveLength(0)
      expect(result.parts.some((part) => part.type === "tool" && part.state.status === "running")).toBe(false)
    })
  })

  test("a replacement prompt waits until cancellation has closed the previous native process", async () => {
    await scenario("approval", async (session, dir) => {
      const running = SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Wait for approval" }],
      })
      await question()
      const stopping = SessionPrompt.cancel(session.id)
      await expect(
        SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "Too early" }] }),
      ).rejects.toThrow()
      await stopping
      await running
      await Bun.write(path.join(dir, "scenario.json"), JSON.stringify({ mode: "normal" }))
      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Continue after cancellation" }],
      })
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      const messages = await Session.messages({ sessionID: session.id })
      expect(
        messages.some((entry) => entry.parts.some((part) => part.type === "text" && part.text === "Too early")),
      ).toBe(false)
      expect((await calls(dir)).filter((call) => call.method === "thread/resume")).toHaveLength(1)
    })
  })

  test("records premature process exit and explicit turn failure", async () => {
    for (const mode of ["crash", "fail"]) {
      await scenario(mode, async (session) => {
        const result = await NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text: "Fail" }] },
          session,
          new AbortController().signal,
        )
        expect(result.info.role === "assistant" && result.info.error?.name).toBe("UnknownError")
        expect(result.info.role === "assistant" && result.info.time.completed).toBeTruthy()
      })
    }
  })

  test("an interrupted native collaboration tool is not displayed as successful", async () => {
    await scenario("interrupted-tool", async (session) => {
      const result = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Wait for the child" }] },
        session,
        new AbortController().signal,
      )
      const part = result.parts.find((part) => part.type === "tool" && part.callID === "wait")
      expect(part?.type === "tool" && part.state.status).toBe("error")
      expect(part?.type === "tool" && part.state.status === "error" && part.state.error).toContain("interrupted")
    })
  })

  test("a missing native thread fails instead of silently starting another conversation", async () => {
    await scenario("resume-fail", async (session, dir) => {
      await Session.setEngine({
        sessionID: session.id,
        engine: { type: "codex", thread: "missing-thread", model: "native-model" },
      })
      const result = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Resume" }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" && result.info.error?.name).toBe("UnknownError")
      expect((await calls(dir)).some((call) => call.method === "thread/start")).toBe(false)
    })
  })

  test("another native writer refuses sending without starting a replacement or dispatching input", async () => {
    await scenario("writer", async (session, dir) => {
      await Session.setEngine({ sessionID: session.id, engine: { type: "codex", thread: "external-thread" } })
      const result = await NativeSession.prompt(
        {
          sessionID: session.id,
          parts: [{ type: "text", text: "Do not dispatch while another client owns the chat" }],
        },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" && result.info.error?.name).toBe("UnknownError")
      expect(JSON.stringify(result.info)).toContain("held by another client")
      expect((await calls(dir)).some((call) => call.method === "thread/start" || call.method === "turn/start")).toBe(
        false,
      )
      expect((await Session.get(session.id)).engine?.thread).toBe("external-thread")
    })
  })

  test("noReply context is persisted without launching Codex and reaches the next turn", async () => {
    await scenario("normal", async (session, dir) => {
      await NativeSession.prompt(
        { sessionID: session.id, noReply: true, parts: [{ type: "text", text: "Paper context" }] },
        session,
        new AbortController().signal,
      )
      expect(await Bun.file(path.join(dir, "calls.jsonl")).exists()).toBe(false)
      await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Now answer" }] },
        session,
        new AbortController().signal,
      )
      const input = (await calls(dir)).find((call) => call.method === "turn/start")?.params?.input
      expect(input).toEqual([
        { type: "text", text: "Paper context", text_elements: [] },
        { type: "text", text: "Now answer", text_elements: [] },
      ])
    })
  })

  test("invalid queued context is rejected before it is persisted", async () => {
    await scenario("normal", async (session, dir) => {
      await expect(
        NativeSession.prompt(
          {
            sessionID: session.id,
            noReply: true,
            parts: [{ type: "file", mime: "application/pdf", url: "https://example.com/private.pdf" }],
          },
          session,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Unsupported attachment URL")
      expect(await Session.messages({ sessionID: session.id })).toEqual([])
      expect(await Bun.file(path.join(dir, "calls.jsonl")).exists()).toBe(false)
    })
  })

  test("queued context survives a failed model validation before native submission", async () => {
    await scenario("normal", async (session, dir) => {
      await NativeSession.prompt(
        { sessionID: session.id, noReply: true, parts: [{ type: "text", text: "Paper context" }] },
        session,
        new AbortController().signal,
      )
      const failed = await NativeSession.prompt(
        {
          sessionID: session.id,
          model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("unavailable-model") },
          parts: [{ type: "text", text: "Original question" }],
        },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(failed.info.role === "assistant" && failed.info.error?.name).toBe("UnknownError")
      expect((await Session.get(session.id)).engine?.cursor).toBeUndefined()
      await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Now answer" }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      const input = (await calls(dir)).find((call) => call.method === "turn/start")?.params?.input
      expect(input).toEqual([
        { type: "text", text: "Paper context", text_elements: [] },
        { type: "text", text: "Now answer", text_elements: [] },
      ])
      expect((await Session.get(session.id)).engine?.cursor).toBeTruthy()
    })
  })

  test("unsupported content in a failed prompt cannot poison later messages", async () => {
    await scenario("normal", async (session, dir) => {
      const failed = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "agent", name: "legacy-agent" }] },
        session,
        new AbortController().signal,
      )
      expect(failed.info.role === "assistant" && failed.info.error?.name).toBe("UnknownError")
      const result = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Continue with supported content" }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      expect((await calls(dir)).find((call) => call.method === "turn/start")?.params?.input).toEqual([
        { type: "text", text: "Continue with supported content", text_elements: [] },
      ])
    })
  })

  test("a crashed dispatched turn is not replayed on the next message", async () => {
    await scenario("crash", async (session, dir) => {
      await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Do this once" }] },
        session,
        new AbortController().signal,
      )
      expect((await Session.get(session.id)).engine?.cursor).toBeTruthy()
      await Bun.write(path.join(dir, "scenario.json"), JSON.stringify({ mode: "normal" }))
      await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Continue" }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      const input = (await calls(dir)).filter((call) => call.method === "turn/start").at(-1)?.params?.input
      expect(input).toEqual([{ type: "text", text: "Continue", text_elements: [] }])
      const log = await calls(dir)
      expect(log.filter((call) => call.method === "initialize")).toHaveLength(2)
      expect(new Set(log.map((call) => call.pid)).size).toBe(2)
      expect(log.filter((call) => call.method === "thread/resume")).toHaveLength(1)
    })
  })

  test("oversized queued context and normal messages cannot consume or poison accepted context", async () => {
    await scenario("normal", async (session, dir) => {
      await NativeSession.prompt(
        { sessionID: session.id, noReply: true, parts: [{ type: "text", text: "a".repeat(5 * 1024 * 1024) }] },
        session,
        new AbortController().signal,
      )
      await expect(
        NativeSession.prompt(
          { sessionID: session.id, noReply: true, parts: [{ type: "text", text: "b".repeat(5 * 1024 * 1024) }] },
          await Session.get(session.id),
          new AbortController().signal,
        ),
      ).rejects.toThrow("transport buffer limit")
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      expect(await Bun.file(path.join(dir, "calls.jsonl")).exists()).toBe(false)
      const result = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "c".repeat(5 * 1024 * 1024) }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(result.info.role === "assistant" && result.info.error?.name).toBe("UnknownError")
      expect((await calls(dir)).filter((call) => call.method === "turn/start")).toHaveLength(0)
      expect((await Session.get(session.id)).engine?.cursor).toBeUndefined()
      const recovered = await NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Use the queued context" }] },
        await Session.get(session.id),
        new AbortController().signal,
      )
      expect(recovered.info.role === "assistant" && recovered.info.error).toBeUndefined()
      const input = (await calls(dir)).find((call) => call.method === "turn/start")?.params?.input
      if (!Array.isArray(input)) throw new Error("Missing dispatched input")
      expect(input).toHaveLength(2)
      expect(input[0].text.length).toBe(5 * 1024 * 1024)
      expect(input[0].text.startsWith("aaa")).toBe(true)
      expect(input[1].text).toBe("Use the queued context")
    })
  })

  test("a missing input cursor fails closed without replaying history", async () => {
    await scenario("normal", async (session, dir) => {
      await Session.setEngine({
        sessionID: session.id,
        engine: { type: "codex", thread: "existing-thread", cursor: MessageID.ascending() },
      })
      await expect(
        NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text: "Continue" }] },
          await Session.get(session.id),
          new AbortController().signal,
        ),
      ).rejects.toThrow("input cursor is missing")
      expect(await Session.messages({ sessionID: session.id })).toEqual([])
      expect(await Bun.file(path.join(dir, "calls.jsonl")).exists()).toBe(false)
    })
  })

  test("reusing a message id cannot overwrite persisted content", async () => {
    await scenario("normal", async (session) => {
      const id = MessageID.ascending()
      await NativeSession.prompt(
        { sessionID: session.id, messageID: id, noReply: true, parts: [{ type: "text", text: "Original" }] },
        session,
        new AbortController().signal,
      )
      await expect(
        NativeSession.prompt(
          { sessionID: session.id, messageID: id, noReply: true, parts: [{ type: "text", text: "Replacement" }] },
          session,
          new AbortController().signal,
        ),
      ).rejects.toThrow("already been submitted")
      expect((await Session.messages({ sessionID: session.id }))[0].parts[0]).toMatchObject({
        type: "text",
        text: "Original",
      })
    })
  })
})
