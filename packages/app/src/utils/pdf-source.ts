export type LatexQuote = {
  root: string
  main: string
  build: string
  hash: string
}

export type PdfSource = { kind: "file"; path: string } | { kind: "latex"; root: string; main: string }

const prefix = "aether-latex:"

export function quote(value: unknown): LatexQuote | undefined {
  if (!value || typeof value !== "object") return
  if (!("root" in value) || typeof value.root !== "string") return
  if (!("main" in value) || typeof value.main !== "string") return
  if (!("build" in value) || typeof value.build !== "string" || !value.build) return
  if (!("hash" in value) || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/i.test(value.hash)) return
  return { root: value.root, main: value.main, build: value.build, hash: value.hash }
}

export function paper(root: string, main: string) {
  return `${prefix}${encodeURIComponent(root)}/${encodeURIComponent(main)}.pdf`
}

export function identity(server: string, directory: string, root: string, main: string) {
  return JSON.stringify([server, directory, root, main])
}

export function source(path: string): PdfSource | undefined {
  if (!path.startsWith(prefix)) return { kind: "file", path }
  const match = path.slice(prefix.length).match(/^([^/]+)\/(.+)\.pdf$/)
  if (!match) return
  try {
    return { kind: "latex", root: decodeURIComponent(match[1]!), main: decodeURIComponent(match[2]!) }
  } catch {
    return
  }
}
