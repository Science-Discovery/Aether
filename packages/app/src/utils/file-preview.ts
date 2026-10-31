import { checksum } from "@opencode-ai/util/encode"

export function preview(path: string) {
  const ext = path.split(".").pop()?.toLowerCase()
  if (ext === "docx" || ext === "xlsx" || ext === "pptx") return ext
  if (ext === "html" || ext === "htm") return "html"
}

export function draft(input: { value?: string; base?: string; content?: string; editing: boolean }) {
  if (!input.editing || input.value === undefined || input.content === undefined) return
  if (input.base === undefined || input.base !== (checksum(input.content) ?? "")) return
  return input.value
}
