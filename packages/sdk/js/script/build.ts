#!/usr/bin/env bun
import fs from "fs"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"
import prettier from "prettier"
import ts from "typescript"

import { createClient } from "@hey-api/openapi-ts"

const list = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(dir, item.name)
    if (item.isDirectory()) return list(file)
    return file.endsWith(".ts") ? [file] : []
  })

const spec = path.resolve(dir, "../openapi.json")
const offline = process.argv.includes("--offline") || process.env.OPENCODE_SDK_OFFLINE === "1"
function openapi(input: string) {
  const marker = '{\n  "openapi"'
  const idx = input.indexOf(marker)
  if (idx < 0) return input
  return input.slice(idx)
}

const json = await (async () => {
  if (offline) {
    if (!fs.existsSync(spec)) throw new Error(`missing offline spec: ${spec}`)
    return Bun.file(spec).text()
  }
  try {
    return await $`bun dev generate`.cwd(path.resolve(dir, "../../opencode")).text()
  } catch (err) {
    if (process.platform !== "win32" || !fs.existsSync(spec)) throw err
    console.warn("failed to generate openapi from source, using packages/sdk/openapi.json")
    return Bun.file(spec).text()
  }
})()

await Bun.write(
  path.join(dir, "openapi.json"),
  openapi(json),
)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const cfg = (await prettier.resolveConfig(dir)) ?? {}
await Promise.all(
  [...list(path.join(dir, "src/gen")), ...list(path.join(dir, "src/v2"))].map(async (file) =>
    Bun.write(file, await prettier.format(await Bun.file(file).text(), { ...cfg, filepath: file })),
  ),
)

fs.rmSync("dist", { recursive: true, force: true })

const parsed = ts.getParsedCommandLineOfConfigFile("tsconfig.json", {}, ts.sys)
if (!parsed) throw new Error("failed to load tsconfig.json")

const app = ts.createProgram({
  options: parsed.options,
  rootNames: parsed.fileNames,
  projectReferences: parsed.projectReferences,
})
const out = app.emit()
const errs = ts.getPreEmitDiagnostics(app).concat(out.diagnostics)
if (errs.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(errs, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => dir,
      getNewLine: () => "\n",
    }),
  )
  process.exit(1)
}

fs.rmSync("openapi.json", { force: true })
