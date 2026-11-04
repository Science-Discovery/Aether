import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { LatexRealtime } from "../../src/latex/rtex/session"
import { tmpdir } from "../fixture/fixture"

function wrapper(script: string) {
  return process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`
}

describe("realtime session", () => {
  test("runs the JSON-lines protocol and forwards document updates", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    const script = path.join(dir.path, "rtex-fake.ts")
    await Bun.write(
      script,
      [
        `console.log(JSON.stringify({ event: "EngineState", engine_generation: 1, state: "Ready", reason: null }))`,
        `const decoder = new TextDecoder()`,
        `let buffer = ""`,
        `for await (const chunk of Bun.stdin.stream()) {`,
        `  buffer += decoder.decode(chunk, { stream: true })`,
        `  while (true) {`,
        `    const at = buffer.indexOf("\\n")`,
        `    if (at < 0) break`,
        `    const line = buffer.slice(0, at).trim()`,
        `    buffer = buffer.slice(at + 1)`,
        `    if (!line) continue`,
        `    const command = JSON.parse(line)`,
        `    if (command.cmd === "set_document") console.log(JSON.stringify({ event: "Diagnostics", source: "test", items: [{ severity: "info", message: command.text }] }))`,
        `    if (command.cmd === "quit") process.exit(0)`,
        `  }`,
        `}`,
      ].join("\n"),
    )
    const binary = path.join(dir.path, process.platform === "win32" ? "rtex.cmd" : "rtex")
    const lualatex = path.join(dir.path, process.platform === "win32" ? "lualatex.cmd" : "lualatex")
    await Promise.all([Bun.write(binary, wrapper(script)), Bun.write(lualatex, wrapper(script))])
    await Promise.all([fs.chmod(binary, 0o700), fs.chmod(lualatex, 0o700)])
    const previous = process.env.PATH
    process.env.PATH = `${dir.path}${path.delimiter}${previous ?? ""}`
    try {
      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          const session = await LatexRealtime.open({
            root: ".",
            main: "main.tex",
            cfg: { rtex: { path: binary } },
          })
          try {
            let current = LatexRealtime.get(session.id)
            for (
              let index = 0;
              index < 100 && !current.events.some((event) => event.event === "EngineState");
              index++
            ) {
              await Bun.sleep(10)
              current = LatexRealtime.get(session.id)
            }
            expect(current.events.some((event) => event.event === "EngineState")).toBe(true)
            LatexRealtime.document(session.id, "main.tex", "realtime text")
            for (
              let index = 0;
              index < 100 && !current.events.some((event) => event.event === "Diagnostics");
              index++
            ) {
              await Bun.sleep(10)
              current = LatexRealtime.get(session.id)
            }
            expect(current.events.find((event) => event.event === "Diagnostics")).toMatchObject({
              source: "test",
              items: [{ message: "realtime text" }],
            })
          } finally {
            await LatexRealtime.close(session.id)
          }
          expect(() => LatexRealtime.get(session.id)).toThrow("does not exist")
          await Instance.dispose()
        },
      })
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  })
})
