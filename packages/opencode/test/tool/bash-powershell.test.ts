import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { Shell } from "../../src/shell/shell"
import { BashTool } from "../../src/tool/bash"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform !== "win32")(
  "PowerShell -File preserves script variables, quoting, and UTF-8 BOM",
  async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "syntax check.ps1"),
          "\uFEFF" +
            [
              "$b = [System.IO.File]::ReadAllBytes($PSCommandPath)[0..2]",
              'Write-Output (($b | ForEach-Object { $_.ToString("X2") }) -join " ")',
              "$word = '中文'",
              'Write-Output (($word.ToCharArray() | ForEach-Object { "{0:X4}" -f [int]$_ }) -join " ")',
            ].join("\r\n"),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        expect(bash.description).toContain(Shell.acceptable())
        expect(bash.description).not.toContain("${shell}")
        expect(bash.description).toContain('powershell.exe -NoProfile -File "script.ps1"')
        const result = await bash.execute(
          {
            // Limit the policy override to this child process and the fixture we just wrote.
            command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "syntax check.ps1"',
            description: "Check PowerShell script bytes and Unicode literals",
          },
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make(""),
            callID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
        expect(result.metadata.exit, result.metadata.output).toBe(0)
        expect(result.metadata.output.replaceAll("\r\n", "\n").trim()).toBe("EF BB BF\n4E2D 6587")
      },
    })
  },
)
