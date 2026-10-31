import { parse, serialize, type DefaultTreeAdapterMap } from "parse5"
// The browser bundle avoids css-tree's optional CommonJS source-map import in
// module workers during Vite development, without loading it into the app.
import * as css from "css-tree/dist/csstree.esm"

type Node = DefaultTreeAdapterMap["node"]
type Element = DefaultTreeAdapterMap["element"]
export type HtmlRead = (path: string, signal: AbortSignal) => Promise<{ data: ArrayBuffer; mime: string }>

const image = /^image\/(?:png|apng|jpeg|gif|webp|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon|avif)$/i
const font = /^(?:font\/[a-z0-9.+-]+|application\/(?:font-[a-z0-9.+-]+|vnd\.ms-fontobject|x-font-[a-z0-9.+-]+))$/i
const dropped = new Set([
  "script",
  "base",
  "meta",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "audio",
  "video",
  "track",
  "foreignObject",
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
  "discard",
])
const addresses = new Set([
  "src",
  "srcset",
  "href",
  "poster",
  "data",
  "background",
  "codebase",
  "archive",
  "action",
  "formaction",
  "ping",
  "manifest",
  "profile",
  "longdesc",
  "lowsrc",
  "dynsrc",
  "srcdoc",
  "target",
  "download",
])
const policy =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'"

function element(node: Node): node is Element {
  return "tagName" in node
}

function directory(path: string) {
  return path.slice(0, path.lastIndexOf("/") + 1)
}

/** Filesystem paths are opaque; only URL attribute segments are decoded. */
export function htmlPath(input: string, base: string) {
  const value = input.trim()
  if (!value || value.startsWith("#") || /[\u0000-\u001f\u007f\\]/.test(value)) return
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return
  const hash = value.includes("#") ? value.slice(value.indexOf("#")) : ""
  const raw = value.split(/[?#]/)[0]!
  const parts = raw.startsWith("/") ? [] : directory(base).split("/").filter(Boolean)
  for (const segment of raw.split("/")) {
    const part = decodeURIComponent(segment)
    if (/[\\/\u0000-\u001f\u007f:]/.test(part)) return
    if (!part || part === ".") continue
    if (part === "..") {
      if (!parts.length) return
      parts.pop()
      continue
    }
    parts.push(part)
  }
  const path = parts.join("/")
  return path ? { path, hash } : undefined
}

/** The URL token may contain commas (notably data URLs); descriptors may not. */
function candidates(value: string) {
  const out: Array<{ url: string; descriptor: string }> = []
  let pos = 0
  while (pos < value.length) {
    while (/[\s,]/.test(value[pos] ?? "") && pos < value.length) pos++
    const start = pos
    while (pos < value.length && !/\s/.test(value[pos]!)) pos++
    const token = value.slice(start, pos)
    if (!token) break
    if (token.endsWith(",")) {
      out.push({ url: token.replace(/,+$/, ""), descriptor: "" })
      continue
    }
    const from = pos
    while (pos < value.length && value[pos] !== ",") pos++
    const descriptor = value.slice(from, pos).trim()
    pos++
    if (!descriptor || /^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) out.push({ url: token, descriptor })
  }
  return out
}

function encoded(data: Uint8Array) {
  const chunks = []
  for (let i = 0; i < data.length; i += 0x8000) chunks.push(String.fromCharCode(...data.subarray(i, i + 0x8000)))
  return btoa(chunks.join(""))
}

function mime(input: string) {
  return input.split(";")[0]!.trim().toLowerCase()
}

function content(data: ArrayBuffer, type: string) {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] ?? "utf-8"
  return new TextDecoder(charset).decode(data)
}

export async function htmlConvert(input: {
  path: string
  source: string
  signal: AbortSignal
  read: HtmlRead
  draft?: (path: string) => string | undefined
}) {
  const deps = new Set<string>()
  const cache = new Map<string, Promise<{ data: ArrayBuffer; mime: string }>>()
  const styles = new Map<string, Promise<string>>()
  const stats = { missing: 0, blocked: 0, bytes: 0 }
  const check = () => input.signal.throwIfAborted()
  const read = (path: string) => {
    check()
    const saved = cache.get(path)
    if (saved) return saved
    // Bound the dependency graph, not ordinary application startup or other previews.
    if (deps.size >= 256) throw new Error("HTML preview contains too many local resources (maximum 256)")
    deps.add(path)
    const task = input.read(path, input.signal).then((file) => {
      check()
      stats.bytes += file.data.byteLength
      if (stats.bytes > 64 * 1024 * 1024) throw new Error("HTML preview resources exceed 64 MiB")
      return file
    })
    cache.set(path, task)
    return task
  }
  const address = (value: string, base: string) => {
    try {
      return htmlPath(value, base)
    } catch {
      return undefined
    }
  }
  const asset = async (value: string, base: string, fonts = false) => {
    check()
    const raw = value.trim()
    if (raw.startsWith("#")) return raw
    if (/^data:/i.test(raw)) {
      const type = mime(raw.slice(5, raw.indexOf(",")).split(";")[0] ?? "")
      if (image.test(type) || (fonts && font.test(type))) return raw
      stats.blocked++
      return ""
    }
    const target = address(raw, base)
    if (!target) {
      stats.blocked++
      return ""
    }
    try {
      const file = await read(target.path)
      const type = mime(file.mime)
      if (!image.test(type) && !(fonts && font.test(type))) {
        stats.blocked++
        return ""
      }
      return `data:${type};base64,${encoded(new Uint8Array(file.data))}${target.hash}`
    } catch (error) {
      check()
      if (error instanceof Error && /HTML preview/.test(error.message)) throw error
      stats.missing++
      return ""
    }
  }
  const sheet = async (source: string, base: string, stack: ReadonlySet<string>, inline = false): Promise<string> => {
    check()
    if (source.length > 4 * 1024 * 1024 || new TextEncoder().encode(source).byteLength > 4 * 1024 * 1024) {
      throw new Error("HTML preview stylesheet exceeds 4 MiB")
    }
    const tree = css.parse(source, {
      context: inline ? "declarationList" : "stylesheet",
      parseCustomProperty: true,
      onParseError: (error) => {
        throw error
      },
    })
    const imports: Array<{ node: css.Atrule; item: css.ListItem<css.CssNode>; list: css.List<css.CssNode> }> = []
    const urls: css.Url[] = []
    const strings: css.StringNode[] = []
    css.walk(tree, {
      enter(node: css.CssNode, item: css.ListItem<css.CssNode>, list: css.List<css.CssNode>) {
        if (node.type === "Raw") throw new Error("Unsupported CSS syntax")
        if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
          if (item && list) imports.push({ node, item, list })
          return css.walk.skip
        }
        if (node.type === "Url") urls.push(node)
        if (node.type === "Function" && /^(?:-webkit-)?image-set$|^image$|^src$/i.test(node.name)) {
          node.children.forEach((child) => {
            if (child.type === "String") strings.push(child)
          })
        }
      },
    })
    await Promise.all(
      urls.map(async (node) => {
        node.value = await asset(node.value, base, true)
      }),
    )
    await Promise.all(
      strings.map(async (node) => {
        node.value = await asset(node.value, base, true)
      }),
    )
    for (const entry of imports) {
      const prelude = entry.node.prelude
      const first = prelude?.type === "AtrulePrelude" ? prelude.children.first : undefined
      if (!first || (first.type !== "String" && first.type !== "Url")) {
        entry.list.remove(entry.item)
        stats.blocked++
        continue
      }
      const target = address(first.value, base)
      if (!target || stack.has(target.path) || stack.size >= 16) {
        entry.list.remove(entry.item)
        stats.blocked++
        continue
      }
      const next = new Set(stack).add(target.path)
      const body = await load(target.path, next)
      const conditions = prelude!.type === "AtrulePrelude" ? prelude!.children.toArray().slice(1) : []
      let result = body
      const layer = conditions[0]
      const layered = layer?.type === "Identifier" && layer.name.toLowerCase() === "layer"
      const named = layer?.type === "Function" && layer.name.toLowerCase() === "layer"
      if (layered || named) conditions.shift()
      const supports = conditions[0]
      const supported = supports?.type === "Function" && supports.name.toLowerCase() === "supports"
      if (supported) conditions.shift()
      if (conditions.length) result = `@media ${conditions.map((node) => css.generate(node)).join(" ")}{${result}}`
      if (supported)
        result = `@supports (${supports.children
          .toArray()
          .map((node) => css.generate(node))
          .join("")}){${result}}`
      if (layered || named)
        result = `@layer${
          named
            ? ` ${layer.children
                .toArray()
                .map((node) => css.generate(node))
                .join("")}`
            : ""
        }{${result}}`
      const parsed = css.parse(result)
      if (parsed.type === "StyleSheet") entry.list.replace(entry.item, parsed.children)
    }
    check()
    return css.generate(tree)
  }
  const load = (path: string, stack: ReadonlySet<string>): Promise<string> => {
    // Imports are cached only within an acyclic branch: a global in-flight cache
    // would deadlock when two top-level stylesheets import each other.
    const key = `${path}\0${[...stack].sort().join("\0")}`
    const saved = styles.get(key)
    if (saved) return saved
    const task = (async () => {
      try {
        const draft = input.draft?.(path)
        if (draft !== undefined) {
          deps.add(path)
          return await sheet(draft, path, stack)
        }
        const file = await read(path)
        if (mime(file.mime) !== "text/css") {
          stats.blocked++
          return ""
        }
        return await sheet(content(file.data, file.mime), path, stack)
      } catch (error) {
        check()
        if (error instanceof Error && /HTML preview/.test(error.message)) throw error
        stats.missing++
        return ""
      }
    })()
    styles.set(key, task)
    return task
  }
  const safeStyle = async (source: string, base: string, inline = false) => {
    try {
      return await sheet(source, base, new Set(), inline)
    } catch (error) {
      check()
      if (error instanceof Error && /HTML preview/.test(error.message)) throw error
      stats.blocked++
      return ""
    }
  }
  const doc = parse(input.source, { scriptingEnabled: false })
  const visit = async (node: Node): Promise<void> => {
    check()
    if (element(node)) {
      const style = node.attrs.find((attr) => attr.name === "style")
      if (style) style.value = await safeStyle(style.value, input.path, true)
      const attrs = [...node.attrs]
      node.attrs = node.attrs.filter(
        (attr) =>
          !attr.name.toLowerCase().startsWith("on") &&
          !addresses.has(attr.name.toLowerCase()) &&
          !attr.name.toLowerCase().startsWith("shadowroot") &&
          attr.name !== "autofocus" &&
          attr.name !== "contenteditable" &&
          !(attr.prefix === "xml" && attr.name === "base"),
      )
      const set = (name: string, value: string) => {
        if (value) node.attrs.push({ name, value })
      }
      if (node.tagName === "a") {
        const href = attrs.find((attr) => attr.name === "href")?.value.trim()
        if (href?.startsWith("#")) set("href", `about:srcdoc${href}`)
      }
      if (node.tagName === "img" || node.tagName === "image" || node.tagName === "input" || node.tagName === "source") {
        const src = attrs.find((attr) => attr.name === (node.tagName === "image" ? "href" : "src"))
        if (src) set(node.tagName === "image" ? "href" : "src", await asset(src.value, input.path))
        const srcset = attrs.find((attr) => attr.name === "srcset")
        if (srcset) {
          const choices = await Promise.all(
            candidates(srcset.value).map(async (choice) => {
              const url = await asset(choice.url, input.path)
              return url ? `${url}${choice.descriptor ? ` ${choice.descriptor}` : ""}` : ""
            }),
          )
          set("srcset", choices.filter(Boolean).join(", "))
        }
      }
      if (node.tagName === "use") {
        const href = attrs.find((attr) => attr.name === "href")?.value.trim()
        if (href?.startsWith("#")) set("href", href)
      }
      if (node.tagName === "link") {
        const rel =
          attrs
            .find((attr) => attr.name === "rel")
            ?.value.toLowerCase()
            .split(/\s+/) ?? []
        const href = attrs.find((attr) => attr.name === "href")?.value
        const disabled = attrs.some((attr) => attr.name === "disabled") || rel.includes("alternate")
        const target = !disabled && rel.includes("stylesheet") && href ? address(href, input.path) : undefined
        const body = target ? await load(target.path, new Set([target.path])) : ""
        if (!target && !disabled) stats.blocked++
        node.tagName = "style"
        node.nodeName = "style"
        node.attrs = attrs.filter((attr) => attr.name === "media")
        node.childNodes = [{ nodeName: "#text", value: body.replaceAll("<", "\\3c "), parentNode: node }]
      }
      if (node.tagName === "style") {
        const source = node.childNodes
          .filter((child) => child.nodeName === "#text")
          .map((child) => ("value" in child ? child.value : ""))
          .join("")
        const body = await safeStyle(source, input.path)
        node.childNodes = [{ nodeName: "#text", value: body.replaceAll("<", "\\3c "), parentNode: node }]
      }
      if ("content" in node && node.content) await visit(node.content as Node)
    }
    if (!("childNodes" in node)) return
    node.childNodes = node.childNodes.filter((child) => {
      if (!element(child) || !dropped.has(child.tagName)) return true
      stats.blocked++
      return false
    })
    for (const child of node.childNodes) await visit(child)
  }
  await visit(doc)
  const head = doc.childNodes
    .flatMap((node) => (element(node) ? node.childNodes : []))
    .find((node) => element(node) && node.tagName === "head")
  if (!head || !element(head)) throw new Error("HTML preview could not create a document")
  const prefix = parse(
    `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head>`,
  )
    .childNodes.flatMap((node) => (element(node) ? node.childNodes : []))
    .find((node) => element(node) && node.tagName === "head")
  if (prefix && element(prefix)) {
    prefix.childNodes.forEach((node) => {
      node.parentNode = head
    })
    head.childNodes.unshift(...prefix.childNodes)
  }
  check()
  return { html: serialize(doc), deps, missing: stats.missing, blocked: stats.blocked }
}
