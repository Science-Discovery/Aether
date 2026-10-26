import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { PDFDocument } from "pdf-lib"

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log("Aether test compiler 1.0")
  process.exit(0)
}
if (process.argv.includes("--child")) {
  console.log("child-ready")
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
const args = process.argv.slice(2)
const position = args.indexOf("--outdir")
const output =
  position >= 0
    ? args[position + 1]
    : args
        .find((arg) => arg.startsWith("-output-directory="))
        ?.split("=")
        .slice(1)
        .join("=")
if (!output) process.exit(2)
const input = args.at(-1)!
const options: { mode?: string; marker?: string; delay?: number; files?: number } = await Bun.file(
  path.join(process.cwd(), "scenario.json"),
)
  .json()
  .catch(() => ({}))
const child =
  options.mode === "tree" ? spawn(process.execPath, [import.meta.filename, "--child"], { stdio: "inherit" }) : undefined
if (options.marker)
  await Bun.write(options.marker, JSON.stringify({ pid: process.pid, child: child?.pid, args, cwd: process.cwd() }))
if (options.delay) await Bun.sleep(options.delay)
if (options.mode === "wait" || options.mode === "tree") {
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
const name = path.parse(input).name
await fs.mkdir(output, { recursive: true })
await Promise.all(
  Array.from({ length: options.files ?? 0 }, (_, index) =>
    Bun.write(path.join(output, `auxiliary-${index}.aux`), "fixture"),
  ),
)
const pdf = await PDFDocument.create()
pdf.addPage().drawText("Aether LaTeX regression fixture")
await Bun.write(
  path.join(output, `${name}.pdf`),
  options.mode === "invalid" ? "%PDF-not-a-valid-file" : await pdf.save(),
)
const log =
  options.mode === "warning"
    ? "Missing character: There is no 中 in font cmr10!"
    : options.mode === "fail"
      ? "./main.tex:4: Undefined control sequence."
      : options.mode === "bare"
        ? "error: section:2: Undefined control sequence"
        : "Output written on document.pdf"
await Bun.write(path.join(output, `${name}.log`), log)
console.log(log)
process.exit(options.mode === "fail" || options.mode === "bare" ? 1 : 0)
