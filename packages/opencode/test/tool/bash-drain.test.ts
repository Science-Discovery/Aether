import { expect, test } from "bun:test"
import path from "node:path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { Shell } from "../../src/shell/shell"
import { ShellOutput } from "../../src/shell/output"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

async function wait(file: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

test.skipIf(!/(?:^|[/\\])(?:bash|zsh|sh)(?:\.exe)?$/i.test(Shell.acceptable())).each(["timeout", "abort"])(
  "%s releases inherited output pipes after the shell exits and preserves buffered Unicode",
  async (mode) => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "child.ts"),
          `process.stdout.write("stdout 中文")
process.stderr.write("stderr 错误")
await Bun.write("ready", "ready")
await Bun.sleep(2500)
await Bun.write("done", "done")
`,
        )
      },
      dispose: async (dir) => {
        if (await Bun.file(path.join(dir, "ready")).exists()) await wait(path.join(dir, "done"))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await BashTool.init()
        await ShellOutput.encoding()
        const abort = new AbortController()
        const task = tool.execute(
          {
            command: `"${process.execPath.replaceAll("\\", "/")}" child.ts & while [ ! -f ready ]; do sleep 0.01; done`,
            timeout: mode === "timeout" ? 1000 : 4000,
            description: "Read inherited output pipes",
          },
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make(""),
            callID: "",
            agent: "build",
            abort: abort.signal,
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
        await wait(path.join(tmp.path, "ready"))
        // Give the shell time to exit while its descendant still owns the pipes.
        await Bun.sleep(100)
        if (mode === "abort") abort.abort()
        const result = await task
        expect(result.metadata.exit).toBe(0)
        expect(await Bun.file(path.join(tmp.path, "done")).exists()).toBe(false)
        expect(result.output).toContain("stdout ")
        expect(result.output).toContain("stderr ")
        expect(result.output).toContain("中文")
        expect(result.output).toContain("错误")
        expect(result.output).not.toContain("�")
        expect(result.output).toContain(mode === "timeout" ? "exceeding timeout 1000 ms" : "User aborted")
      },
    })
  },
  10_000,
)
