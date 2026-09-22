import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Shell } from "../../src/shell/shell"
import { Truncate } from "../../src/tool/truncate"
import { tmpdir } from "../fixture/fixture"

const prefix = () => (/(?:powershell|pwsh)(?:\.exe)?$/i.test(Shell.preferred()) ? "& " : "")

const emitScript = async (dir: string, body: string) => {
  const file = path.join(dir, "emit.js")
  await Bun.write(file, body)
  return file
}

test("shell caps runaway output and spills full output to file", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const lines: string[] = []
      for (let i = 0; i < 6000; i++) lines.push(`line-${i}-${"x".repeat(50)}`)
      const full = "HEAD-MARKER\n" + lines.join("\n") + "\nTAIL-MARKER-END\n"
      const script = await emitScript(tmp.path, `process.stdout.write(Buffer.from(${JSON.stringify(full)}))`)
      const result = await SessionPrompt.shell({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        command: `${prefix()}"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`,
      })
      const part = result.parts[0]
      if (part.type !== "tool") throw new Error("Expected shell tool output")
      if (part.state.status !== "completed") throw new Error("Expected completed shell output")
      const output = part.state.output
      expect(output).toContain("HEAD-MARKER")
      expect(output).not.toContain("TAIL-MARKER-END")
      expect(output).toContain("bytes truncated")
      expect(output).toContain("Full output saved to: ")
      expect(Buffer.byteLength(output)).toBeLessThan(Truncate.MAX_BYTES + 1000)
      const saved = output.match(/Full output saved to: (.+)/)?.[1]
      expect(saved).toBeTruthy()
      const stored = await Bun.file(saved!).text()
      expect(stored).toBe(full)
    },
  })
})

test("shell byte-cuts multibyte output at cap boundary without corruption", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const full = "a".repeat(49999) + "😀".repeat(3000) + "TAIL-OK"
      const script = await emitScript(tmp.path, `process.stdout.write(Buffer.from(${JSON.stringify(full)}))`)
      const result = await SessionPrompt.shell({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        command: `${prefix()}"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`,
      })
      const part = result.parts[0]
      if (part.type !== "tool") throw new Error("Expected shell tool output")
      if (part.state.status !== "completed") throw new Error("Expected completed shell output")
      const output = part.state.output
      expect(output).not.toContain("TAIL-OK")
      expect(output).not.toContain("\uFFFD")
      const marker = output.indexOf("\n\n...")
      expect(marker).toBeGreaterThan(0)
      const preview = output.slice(0, marker)
      expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(Truncate.MAX_BYTES)
      expect(Buffer.byteLength(preview)).toBeGreaterThanOrEqual(Truncate.MAX_BYTES - 4)
      const saved = output.match(/Full output saved to: (.+)/)?.[1]
      expect(saved).toBeTruthy()
      const stored = await Bun.file(saved!).text()
      expect(stored).toBe(full)
    },
  })
})

test("shell abort during spill keeps both truncation note and abort marker", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const list = () =>
        fs
          .readdir(Truncate.DIR)
          .then((names) => names.filter((name) => name.startsWith("tool_")))
          .catch(() => [])
      const before = new Set(await list())
      const script = await emitScript(
        tmp.path,
        `for (let i = 0; i < 200; i++) {
  process.stdout.write("z".repeat(2000) + "\\n")
  await Bun.sleep(30)
}`,
      )
      const run = SessionPrompt.shell({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        command: `${prefix()}"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`,
      })
      let spilled: string | undefined
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        spilled = (await list()).find((name) => !before.has(name))
        if (spilled) break
        await Bun.sleep(25)
      }
      expect(spilled).toBeDefined()
      await SessionPrompt.cancel(session.id)
      const result = await run
      const part = result.parts[0]
      if (part.type !== "tool") throw new Error("Expected shell tool output")
      if (part.state.status !== "completed") throw new Error("Expected completed shell output")
      expect(part.state.output).toContain("bytes truncated")
      expect(part.state.output).toContain("Full output saved to: ")
      expect(part.state.output).toContain("User aborted the command")
      const stored = await Bun.file(path.join(Truncate.DIR, spilled!)).text()
      expect(stored.length).toBeGreaterThan(Truncate.MAX_BYTES)
    },
  })
})

test("shell throttles streaming updates and persists final output in order", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const updates: { status: string; output: string }[] = []
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
        const part = evt.properties.part
        if (part.type !== "tool") return
        if (part.state.status === "completed") {
          updates.push({ status: "completed", output: part.state.output })
          return
        }
        if (part.state.status === "running") {
          const text = part.state.metadata?.output
          if (typeof text === "string") updates.push({ status: "running", output: text })
        }
      })
      const script = await emitScript(
        tmp.path,
        `for (let i = 0; i < 200; i++) {
  process.stdout.write("chunk-" + i + "-" + "y".repeat(40) + "\\n")
  await Bun.sleep(2)
}`,
      )
      try {
        const result = await SessionPrompt.shell({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          command: `${prefix()}"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`,
        })
        const part = result.parts[0]
        if (part.type !== "tool") throw new Error("Expected shell tool output")
        if (part.state.status !== "completed") throw new Error("Expected completed shell output")
        expect(part.state.output).toContain("chunk-0-")
        expect(part.state.output).toContain("chunk-199-")
        expect(updates.length).toBeGreaterThan(1)
        expect(updates.length).toBeLessThanOrEqual(25)
        for (let i = 1; i < updates.length; i++) {
          expect(updates[i].output.startsWith(updates[i - 1].output)).toBe(true)
        }
        expect(updates.at(-1)!.status).toBe("completed")
        expect(updates.at(-1)!.output).toBe(part.state.output)
      } finally {
        unsub()
      }
    },
  })
})
