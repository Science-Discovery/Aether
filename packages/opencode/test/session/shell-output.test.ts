import { expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Shell } from "../../src/shell/shell"
import { tmpdir } from "../fixture/fixture"

test("session shell preserves independent split Unicode output through EOF", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "output.ts")
  await Bun.write(
    file,
    `const out = Buffer.from("中文🙂")
const err = Buffer.from("错误🚀")
process.stdout.write(out.subarray(0, 1))
await Bun.sleep(30)
process.stderr.write(err.subarray(0, 2))
await Bun.sleep(30)
process.stdout.write(out.subarray(1))
await Bun.sleep(30)
process.stderr.write(err.subarray(2))
`,
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const prefix = /(?:powershell|pwsh)(?:\.exe)?$/i.test(Shell.preferred()) ? "& " : ""
      const result = await SessionPrompt.shell({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        command: `${prefix}"${process.execPath.replaceAll("\\", "/")}" "${file.replaceAll("\\", "/")}"`,
      })
      const part = result.parts[0]
      expect(part.type).toBe("tool")
      if (part.type !== "tool") throw new Error("Expected shell tool output")
      expect(part.state.status).toBe("completed")
      if (part.state.status !== "completed") throw new Error("Expected completed shell output")
      expect(part.state.output).toContain("中文🙂")
      expect(part.state.output).toContain("错误🚀")
      expect(part.state.output).not.toContain("�")
      expect(part.state.metadata.output).toBe(part.state.output)
    },
  })
})
