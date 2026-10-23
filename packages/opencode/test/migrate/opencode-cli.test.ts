import { describe, expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import * as kilo from "../../src/migrate/adapters/kilo"
import * as opencode from "../../src/migrate/adapters/opencode"
import { tmpdir } from "../fixture/fixture"

const fixture = (file: string) => path.join(import.meta.dir, "fixtures", file)
const win = process.platform === "win32"

async function script(dir: string, name: string, version: string) {
  const file = path.join(dir, name + (win ? ".cmd" : ""))
  const body = win
    ? [
        "@echo off",
        'if "%~1"=="--version" goto version',
        'if "%~1"=="session" goto session',
        'if "%~1"=="export" goto export',
        "echo unexpected: %* 1>&2",
        "exit /b 2",
        ":version",
        `echo ${version}`,
        "exit /b 0",
        ":session",
        'echo [{"id":"ses_cli_fixture","title":"CLI Fixture","time":{"updated":1787054403000}}]',
        "exit /b 0",
        ":export",
        `type "${fixture("opencode/basic.json")}"`,
        "exit /b 0",
        "",
      ].join("\r\n")
    : `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  session) printf '%s\\n' '[{"id":"ses_cli_fixture","title":"CLI Fixture","time":{"updated":1787054403000}}]' ;;\n  export) cat ${JSON.stringify(fixture("opencode/basic.json"))} ;;\n  *) echo "unexpected: $@" >&2; exit 2 ;;\nesac\n`
  await Bun.write(file, body)
  if (!win) await chmod(file, 0o755)
  return file
}

describe("OpenCode/Kilo CLI adapter", () => {
  test("lists and exports through an explicit CLI", async () => {
    await using dir = await tmpdir()
    const open = await script(dir.path, "opencode", opencode.pinned.opencode)
    const refs = await opencode.list("opencode", { cli: open })
    expect(refs).toEqual([
      {
        source: "opencode",
        id: "ses_cli_fixture",
        path: "opencode:ses_cli_fixture",
        title: "CLI Fixture",
        updated: 1787054403000,
      },
    ])
    const session = await opencode.exportSession("ses_ignored", "opencode", { cli: open })
    expect(session.source).toBe("opencode")
    expect(session.path).toBe("opencode:ses_ignored")
    expect(session.sessionID).toBe("ses_11111111111141118111111111111111")
    expect(session.title).toBe("SYNTHETIC_IMPORTED_NAME")
  })

  test("works with an untested CLI version", async () => {
    await using dir = await tmpdir()
    const open = await script(dir.path, "opencode", "9.9.9")
    const refs = await opencode.list("opencode", { cli: open })
    expect(refs[0]?.id).toBe("ses_cli_fixture")
    const session = await opencode.exportSession("ses_ignored", "opencode", { cli: open })
    expect(session.sessionID).toBe("ses_11111111111141118111111111111111")
  })

  test("supports Kilo through its own CLI", async () => {
    await using dir = await tmpdir()
    const file = await script(dir.path, "kilo", kilo.pinned)
    const refs = await kilo.list({ cli: file })
    expect(refs[0]?.id).toBe("ses_cli_fixture")
    const session = await kilo.exportSession("ses_ignored", { cli: file })
    expect(session.source).toBe("kilo")
  })
})
