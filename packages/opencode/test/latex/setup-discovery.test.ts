import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { LatexCompiler } from "../../src/latex/compiler"
import { LatexSetup } from "../../src/latex/setup"
import { tmpdir } from "../fixture/fixture"

const binding = {
  root: ".",
  main: "main.tex",
  driver: "tectonic" as const,
  program: "xelatex" as const,
  revision: "test",
  updatedAt: 0,
}

test("compiler automatically uses managed Tectonic while preserving explicit configuration", async () => {
  await using dir = await tmpdir()
  const managed = path.join(dir.path, "managed.exe")
  const custom = path.join(dir.path, "custom.exe")
  await Promise.all([Bun.write(managed, "fixture"), Bun.write(custom, "fixture")])
  const discover = spyOn(LatexSetup, "executable").mockResolvedValue(managed)
  try {
    expect((await LatexCompiler.select(binding, "", {})).path).toBe(managed)
    expect((await LatexCompiler.select(binding, "", { tectonic: { path: custom } })).path).toBe(custom)
    await expect(
      LatexCompiler.select(binding, "", { tectonic: { path: path.join(dir.path, "missing.exe") } }),
    ).rejects.toThrow("No compatible LaTeX compiler")
  } finally {
    discover.mockRestore()
  }
})
