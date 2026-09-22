import { expect, test } from "bun:test"
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
