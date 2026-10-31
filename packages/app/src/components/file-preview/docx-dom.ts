import type { HElement } from "docx-preview"

export const source = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'"><style>
html{color-scheme:light;background:transparent}body{margin:0;background:transparent}#document{width:max-content;margin:auto;transform-origin:top left}.docx-wrapper{padding:16px!important;background:transparent!important}.docx-wrapper>section.docx{margin-bottom:16px!important;flex-shrink:0}*{animation:none!important;transition:none!important}
</style></head><body><main id="document"></main></body></html>`

const html = new Set(
  "div span section article header footer p table colgroup col tr td th ol ul li br wbr sup sub ins del img style".split(
    " ",
  ),
)
const svg = new Set(
  "svg g path rect circle ellipse line polyline polygon text tspan defs clipPath mask pattern marker linearGradient radialGradient stop image use"
    .toLowerCase()
    .split(" "),
)
const math = new Set(
  "math mfrac mrow mn mi mo ms mtext msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd menclose mpadded mphantom mspace mstyle".split(
    " ",
  ),
)
const attrs = new Set(["id", "title", "alt", "colSpan", "rowSpan", "xmlns"])

/** Create even detached nodes inside the restricted frame, never in the application document. */
export function factory(doc: Document, alive: () => boolean) {
  const make = (value: HElement | Node | string): Node => {
    if (!alive()) throw new DOMException("Preview cancelled", "AbortError")
    if (typeof value === "string") return doc.createTextNode(value)
    if ("nodeType" in value) return value as Node
    if (value.tagName === "#comment") return doc.createComment(String(value.children?.[0] ?? ""))
    if (value.tagName === "#fragment") {
      const result = doc.createDocumentFragment()
      value.children?.forEach((child) => result.appendChild(make(child)))
      return result
    }
    const name = value.tagName.toLowerCase()
    const ns =
      value.ns === "http://www.w3.org/2000/svg"
        ? value.ns
        : value.ns === "http://www.w3.org/1998/Math/MathML"
          ? value.ns
          : "http://www.w3.org/1999/xhtml"
    const allowed = ns.endsWith("svg") ? svg.has(name) : ns.endsWith("MathML") ? math.has(name) : html.has(name)
    const result = doc.createElementNS(ns, allowed ? value.tagName : ns.endsWith("svg") ? "g" : "span")
    if (value.className) result.setAttribute("class", value.className)
    if (typeof value.style === "string") result.setAttribute("style", value.style)
    if (value.style && typeof value.style === "object") Object.assign((result as HTMLElement).style, value.style)
    Object.entries(value).forEach(([key, item]) => {
      if (attrs.has(key) && (typeof item === "string" || typeof item === "number")) {
        result.setAttribute(key === "colSpan" ? "colspan" : key === "rowSpan" ? "rowspan" : key, String(item))
      }
    })
    value.children?.forEach((child) => result.appendChild(make(child)))
    return result
  }
  return make
}
