import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Latex, LatexSchema } from "../../src/latex"
import { LatexCompiler } from "../../src/latex/compiler"
import { LatexProject } from "../../src/latex/project"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

const binary = await tmpdir()
const file = path.join(Global.Path.config, "config.json")
const original = await Bun.file(file)
  .text()
  .catch(() => undefined)
const executable = path.join(binary.path, process.platform === "win32" ? "tectonic.cmd" : "tectonic")
beforeAll(async () => {
  await Bun.write(
    executable,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${path.join(import.meta.dir, "fixture.ts")}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${path.join(import.meta.dir, "fixture.ts").replaceAll("'", "'\\''")}' "$@"\n`,
  )
  await fs.chmod(executable, 0o700)
  await Bun.write(
    file,
    JSON.stringify({ latex: { tectonic: { path: executable }, latexmk: { path: path.join(binary.path, "missing") } } }),
  )
  Config.global.reset()
})
afterAll(async () => {
  await Instance.disposeAll()
  if (original === undefined) await fs.rm(file, { force: true })
  else await Bun.write(file, original)
  Config.global.reset()
  await binary[Symbol.asyncDispose]()
})

async function terminal(id: string) {
  for (let count = 0; count < 400; count++) {
    const build = await Latex.get(id)
    if (build.state !== "preparing" && build.state !== "running") return build
    await Bun.sleep(25)
  }
  throw new Error("Fixture compilation did not finish")
}
async function marker(file: string) {
  for (let count = 0; count < 200; count++) {
    const data = (await Bun.file(file)
      .json()
      .catch(() => undefined)) as { pid: number; child?: number; args: string[]; cwd: string } | undefined
    if (data) return data
    await Bun.sleep(25)
  }
  throw new Error("Fixture process did not start")
}
const start = (binding: LatexSchema.Binding, sourceRevision?: string) =>
  Latex.start({ root: binding.root, bindingRevision: binding.revision, sourceRevision, allowDownloads: false })

describe("LaTeX compiler lifecycle", () => {
  test("publishes build-bound source positions, verifies freshness and survives scratch removal and instance reload", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "paper", "main.tex"), "\\documentclass{article}")
    await Bun.write(path.join(dir.path, "paper", "章节", "part.tex"), "One\nTwo\nThree\nFour\nFive")
    await Bun.write(
      path.join(dir.path, "paper", "scenario.json"),
      JSON.stringify({ mode: "sync", source: "章节/part.tex" }),
    )
    const id = await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: "paper", main: "main.tex", driver: "tectonic", program: "auto" }))
          .binding!
        const build = await terminal((await start(bound)).id)
        expect(build.state).toBe("succeeded")
        expect(build.sync).toEqual({ state: "ready" })
        expect(
          await Bun.file(path.join(Global.Path.cache, "latex", "jobs", build.id, "output", "main.synctex.gz")).exists(),
        ).toBe(false)
        const found = await Latex.forward(build.id, { path: "paper/章节/part.tex", line: 5 })
        expect(found.page).toBe(1)
        expect(found.rect[0]).toBeCloseTo(120, 4)
        expect(found.rect[1]).toBeCloseTo(628, 4)
        expect(await Latex.inverse(build.id, { page: 1, x: 140, y: 634 })).toEqual({
          path: "paper/章节/part.tex",
          line: 5,
        })
        await expect(Latex.forward(build.id, { path: "../outside.tex", line: 1 })).rejects.toThrow("outside")
        const root = await LatexProject.root("paper")
        const home = path.join(Global.Path.data, "latex", root.owner)
        const file = path.join(home, "sync", `${build.id}.json`)
        const original = await Bun.file(file).text()
        await Bun.write(file, `${original} `)
        await expect(Latex.forward(build.id, { path: "paper/章节/part.tex", line: 5 })).rejects.toThrow("changed")
        await Bun.write(file, original)
        const manifest = path.join(home, "manifests", `${build.id}.json`)
        const saved = await Bun.file(manifest).text()
        await Bun.write(manifest, saved.replace(root.owner, "different-workspace"))
        await expect(Latex.inverse(build.id, { page: 1, x: 140, y: 634 })).rejects.toThrow("manifest is invalid")
        await Bun.write(manifest, saved)
        await Instance.dispose()
        return build.id
      },
    })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        expect((await Latex.forward(id, { path: "paper/章节/part.tex", line: 5 })).page).toBe(1)
        await Bun.write(path.join(dir.path, "paper", "main.tex"), "\\documentclass{book}")
        await expect(Latex.inverse(id, { page: 1, x: 140, y: 634 })).rejects.toThrow("source has changed")
        await Bun.write(path.join(dir.path, "paper", "main.tex"), "\\documentclass{article}")
        const project = await Latex.inspect({ root: "paper" })
        await Latex.bind({ ...project.binding!, expectedRevision: project.binding!.revision })
        await expect(Latex.forward(id, { path: "paper/章节/part.tex", line: 5 })).rejects.toThrow("settings changed")
        await Instance.dispose()
      },
    })
    await using other = await tmpdir()
    await Instance.provide({
      directory: other.path,
      fn: async () => {
        await expect(Latex.inverse(id, { page: 1, x: 140, y: 634 })).rejects.toThrow("does not belong")
        await Instance.dispose()
      },
    })
  })

  test("unavailable or malformed source mapping does not fail a valid PDF build", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        for (const mode of ["success", "invalid-sync"]) {
          await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode }))
          const build = await terminal((await start(bound)).id)
          expect(build.state).toBe("succeeded")
          expect(build.sync?.state).toBe("unavailable")
          expect((await Latex.pdf(build.id)).bytes.length).toBeGreaterThan(100)
          await expect(Latex.forward(build.id, { path: "main.tex", line: 1 })).rejects.toThrow("no source mapping")
        }
        await Instance.dispose()
      },
    })
  })
  test("lastSuccessful always names a readable PDF through final cleanup", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        const first = await terminal((await start(bound)).id)
        await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ files: 500 }))
        const next = await start(bound)
        let polls = 0
        while (true) {
          const project = await Latex.inspect({})
          expect([first.id, next.id]).toContain(project.lastSuccessful?.id ?? "")
          expect(project.lastSuccessful?.state).toBe("succeeded")
          expect((await Latex.pdf(project.lastSuccessful!.id)).bytes.length).toBeGreaterThan(100)
          if (project.latest?.state === "succeeded") break
          if (++polls > 400) throw new Error("Publication fixture did not finish")
          await Bun.sleep(5)
        }
        expect(polls).toBeGreaterThan(0)
        expect((await Latex.inspect({})).lastSuccessful?.id).toBe(next.id)
        // A published terminal result also guarantees the project lock is released.
        await Latex.bind({
          root: ".",
          main: "main.tex",
          driver: "tectonic",
          program: "auto",
          expectedRevision: bound.revision,
        })
        await Instance.dispose()
      },
    })
  })
  test("publishes valid PDF, persists binding and detects dependency or binding changes", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    await Bun.write(path.join(dir.path, "refs.bib"), "First")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        const first = await terminal((await start(bound)).id)
        expect(first.state).toBe("succeeded")
        expect((await Latex.pdf(first.id)).bytes.subarray(0, 5).toString()).toBe("%PDF-")
        expect((await Latex.inspect({})).freshness.state).toBe("fresh")
        const changed = (
          await Latex.bind({
            root: ".",
            main: "main.tex",
            driver: "tectonic",
            program: "xelatex",
            expectedRevision: bound.revision,
          })
        ).binding!
        expect((await Latex.inspect({})).freshness.state).toBe("stale")
        await Bun.write(path.join(dir.path, "refs.bib"), "Other")
        const refresh = await Latex.refresh({ root: ".", editors: ["main.tex"] })
        expect(refresh.freshness.sourceRevision).not.toBe(first.sourceRevision)
        expect(refresh.editors[0].checksum).not.toBeNull()
        await Instance.dispose()
        await Instance.provide({
          directory: dir.path,
          fn: async () => {
            const restored = await Latex.inspect({})
            expect(restored.binding?.revision).toBe(changed.revision)
            expect(restored.lastSuccessful?.id).toBe(first.id)
            expect(restored.freshness.state).toBe("unknown")
            expect((await Latex.pdf(first.id)).bytes.length).toBeGreaterThan(100)
            await Instance.dispose()
          },
        })
      },
    })
  })

  test("failed output and invalid PDF preserve last success, warnings remain visible", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    await Bun.write(path.join(dir.path, "section.tex"), "Text\n\\undefinedaethercommand")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode: "warning" }))
        const first = await terminal((await start(bound)).id)
        expect(first.state).toBe("succeeded")
        expect(
          first.diagnostics.some(
            (entry) => entry.severity === "warning" && entry.message.includes("Missing character"),
          ),
        ).toBe(true)
        for (const mode of ["fail", "bare", "invalid"]) {
          await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode }))
          const next = await terminal((await start(bound)).id)
          expect(next.state).toBe("failed")
          expect(next.pdf).toBe(false)
          await expect(Latex.pdf(next.id)).rejects.toThrow("no successfully published PDF")
          expect((await Latex.inspect({})).lastSuccessful?.id).toBe(first.id)
          if (mode === "fail")
            expect(next.diagnostics).toContainEqual({
              severity: "error",
              message: "./main.tex:4: Undefined control sequence.",
              path: "main.tex",
              line: 4,
            })
          if (mode === "bare")
            expect(next.diagnostics).toContainEqual({
              severity: "error",
              message: "error: section:2: Undefined control sequence",
              path: "section.tex",
              line: 2,
            })
        }
        expect((await Latex.pdf(first.id)).bytes.length).toBeGreaterThan(100)
        await Instance.dispose()
      },
    })
  })

  test("source mismatch never runs compiler; modified sources during compilation produce stale preview", async () => {
    await using dir = await tmpdir()
    await using signals = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    const signal = path.join(signals.path, "started.json")
    await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ marker: signal, delay: 350 }))
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        const mismatch = await terminal((await start(bound, "not-current")).id)
        expect(mismatch.state).toBe("failed")
        expect(await Bun.file(signal).exists()).toBe(false)
        const next = await start(bound)
        await marker(signal)
        await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{book}")
        expect((await terminal(next.id)).state).toBe("succeeded")
        expect((await Latex.inspect({})).freshness.state).toBe("stale")
        await Instance.dispose()
      },
    })
  })

  test("cancel waits for actual parent and child exit, retains no scratch and releases build lock", async () => {
    await using dir = await tmpdir()
    await using signals = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    const signal = path.join(signals.path, "started.json")
    await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode: "tree", marker: signal }))
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        const build = await start(bound)
        const processes = await marker(signal)
        await expect(start(bound)).rejects.toThrow("already running")
        await expect(
          Latex.bind({
            root: ".",
            main: "main.tex",
            driver: "tectonic",
            program: "auto",
            expectedRevision: bound.revision,
          }),
        ).rejects.toThrow("busy")
        const cancelled = await Latex.cancel(build.id)
        expect(cancelled.error).toBe("LaTeX compilation cancelled.")
        expect(cancelled.state).toBe("cancelled")
        for (const pid of [processes.pid, processes.child!]) expect(() => process.kill(pid, 0)).toThrow()
        expect(
          await fs.stat(path.join(Global.Path.cache, "latex", "jobs", build.id)).catch(() => undefined),
        ).toBeUndefined()
        await Bun.write(path.join(dir.path, "scenario.json"), "{}")
        expect((await terminal((await start(bound)).id)).state).toBe("succeeded")
        await Instance.dispose()
      },
    })
  })

  test("workspace ownership, API errors and OpenAPI generation remain enforced", async () => {
    await using dir = await tmpdir()
    await using other = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    const id = await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        return (await terminal((await start(bound)).id)).id
      },
    })
    await Instance.provide({
      directory: other.path,
      fn: async () => {
        await expect(Latex.pdf(id)).rejects.toThrow("does not belong")
        await expect(Latex.get("../secret")).rejects.toThrow("identifier")
        const response = await Server.Default().request(
          `http://localhost/latex/project?root=..&directory=${encodeURIComponent(other.path)}`,
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toHaveProperty("error")
        await Instance.dispose()
      },
    })
    const spec = await Server.openapi()
    expect(spec.paths?.["/latex/project"]?.put?.operationId).toBe("latex.bind")
    expect(spec.paths?.["/latex/build/{id}/pdf"]?.get?.operationId).toBe("latex.pdf")
    expect(spec.paths?.["/latex/versions"]?.get?.operationId).toBe("latex.versions")
    expect(spec.paths?.["/latex/build/{id}/annotations"]?.put?.operationId).toBe("latex.annotate")
    expect(spec.paths?.["/latex/build/{id}/lease"]?.post?.operationId).toBe("latex.lease")
    expect(spec.paths?.["/latex/build/{id}/sync/forward"]?.post?.operationId).toBe("latex.forward")
    expect(spec.paths?.["/latex/build/{id}/sync/inverse"]?.post?.operationId).toBe("latex.inverse")
  })

  test("configured executable is probed without compiling and explicit pdfLaTeX is not silently changed", async () => {
    const result = await Latex.status()
    expect(result.tools.find((tool) => tool.driver === "tectonic")?.installed).toBe(true)
    expect(result.tools.find((tool) => tool.driver === "latexmk")?.installed).toBe(false)
    const binding: LatexSchema.Binding = {
      root: ".",
      main: "main.tex",
      revision: "test",
      updatedAt: Date.now(),
      driver: "tectonic",
      program: "auto",
    }
    await expect(
      LatexCompiler.select(binding, "% !TeX program = pdflatex", { tectonic: { path: executable } }),
    ).rejects.toThrow("requests pdfLaTeX")
    await expect(LatexCompiler.select(binding, "", { tectonic: { path: "definitely-missing" } })).rejects.toThrow(
      "No compatible",
    )
    expect(
      LatexCompiler.diagnostics(
        "./parts/chapter.tex:12: Undefined control sequence.\nwarning: ../outside.tex:2: Warning text",
        { path: "C:/work/paper", root: "paper", workspace: "C:/work", owner: "x", key: "x" },
        "C:/snapshot",
        "main.tex",
        ["parts/chapter.tex"],
      )[0],
    ).toEqual({
      severity: "error",
      message: "./parts/chapter.tex:12: Undefined control sequence.",
      path: "paper/parts/chapter.tex",
      line: 12,
    })
  })

  test("extensionless diagnostics require snapshot evidence and never point outside the project", () => {
    const root = {
      path: path.resolve("workspace/paper"),
      root: "paper",
      workspace: path.resolve("workspace"),
      owner: "x",
      key: "x",
    }
    const source = path.resolve("snapshot")
    const found = LatexCompiler.diagnostics(
      [
        "error: section:2: Undefined control sequence",
        "error: absent:3: Undefined control sequence",
        "error: ../outside:4: Undefined control sequence",
        "error: section:0: Undefined control sequence",
      ].join("\n"),
      root,
      source,
      "main.tex",
      ["main.tex", "section.tex"],
    )
    expect(found[0]).toMatchObject({ path: "paper/section.tex", line: 2 })
    expect(found[1].path).toBeUndefined()
    expect(found[2].path).toBeUndefined()
    expect(found[3].line).toBeUndefined()
  })

  test("termination failure is explicit and never pretends the compiler has stopped", async () => {
    const abort = new AbortController()
    const ready = Promise.withResolvers<void>()
    let pid = 0
    const result = LatexCompiler.run(process.execPath, [path.join(import.meta.dir, "fixture.ts"), "--child"], {
      signal: abort.signal,
      update: () => ready.resolve(),
      stop: async (value) => {
        pid = value
        throw new Error("Fixture termination refused")
      },
    })
    await ready.promise
    abort.abort()
    await expect(result).rejects.toBeInstanceOf(LatexCompiler.StopError)
    expect(pid).toBeGreaterThan(0)
    expect(process.kill(pid, 0)).toBe(true)
    if (process.platform === "win32") {
      const child = spawn("taskkill.exe", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" })
      await new Promise<void>((resolve) => child.once("close", () => resolve()))
    } else process.kill(-pid, "SIGKILL")
    for (let count = 0; count < 50; count++) {
      try {
        process.kill(pid, 0)
        await Bun.sleep(20)
      } catch {
        break
      }
    }
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("instance disposal waits for compiler exit and preserved PDF can be reopened", async () => {
    await using dir = await tmpdir()
    await using signals = await tmpdir()
    const signal = path.join(signals.path, "started.json")
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: "main.tex", driver: "tectonic", program: "auto" })).binding!
        const success = await terminal((await start(bound)).id)
        await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode: "wait", marker: signal }))
        const running = await start(bound)
        const process = await marker(signal)
        await Instance.dispose()
        expect(() => globalThis.process.kill(process.pid, 0)).toThrow()
        await Instance.provide({
          directory: dir.path,
          fn: async () => {
            expect((await Latex.get(running.id)).state).toBe("cancelled")
            expect((await Latex.inspect({})).lastSuccessful?.id).toBe(success.id)
            expect((await Latex.pdf(success.id)).bytes.length).toBeGreaterThan(100)
            await Instance.dispose()
          },
        })
      },
    })
  })

  test("main filenames are passed as literal arguments and all safety flags remain enabled", async () => {
    await using dir = await tmpdir()
    await using signals = await tmpdir()
    const name = "-paper & notes.tex"
    const signal = path.join(signals.path, "started.json")
    await Bun.write(path.join(dir.path, name), "\\documentclass{article}")
    await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ marker: signal }))
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bound = (await Latex.bind({ root: ".", main: name, driver: "tectonic", program: "auto" })).binding!
        expect((await terminal((await start(bound)).id)).state).toBe("succeeded")
        const data = await marker(signal)
        expect(data.args).toContain(`./${name}`)
        expect(data.args).toContain("--untrusted")
        expect(data.args).toContain("--only-cached")
        expect(data.args).toContain("--synctex")
        expect(data.cwd).not.toBe(dir.path)
        await Instance.dispose()
      },
    })
  })
})
