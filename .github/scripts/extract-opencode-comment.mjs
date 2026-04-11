import fs from "fs"

const file = process.argv[2]

if (!file) {
  console.error("usage: extract-opencode-comment.mjs <jsonl-file>")
  process.exit(1)
}

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
let text = ""

for (const line of lines) {
  let item
  try {
    item = JSON.parse(line)
  } catch {
    continue
  }

  if (item.type !== "text") continue
  if (!item.part || item.part.type !== "text") continue
  if (typeof item.part.text !== "string") continue

  const next = item.part.text.trim()
  if (!next) continue
  text = next
}

if (!text) {
  console.error("no final assistant text found in opencode output")
  process.exit(1)
}

process.stdout.write(text + "\n")
