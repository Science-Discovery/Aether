import { describe, expect, test } from "bun:test"
import { parse, type DefaultTreeAdapterMap } from "parse5"
import { htmlConvert, htmlPath, type HtmlRead } from "./html-convert"

function setup(files: Record<string, { source: string; mime: string }> = {}) {
  const paths: string[] = []
  const read: HtmlRead = async (path, signal) => {
    signal.throwIfAborted()
    paths.push(path)
    const file = files[path]
    if (!file) throw new Error("File not found")
    return { data: new TextEncoder().encode(file.source).buffer, mime: file.mime }
  }
  const render = (source: string, draft?: (path: string) => string | undefined) =>
    htmlConvert({
      path: "site/pages/index.html",
      source,
      signal: new AbortController().signal,
      read,
      draft,
    })
  return { paths, render }
}

function tags(html: string) {
  const out: DefaultTreeAdapterMap["element"][] = []
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) out.push(node)
    if ("childNodes" in node) node.childNodes.forEach(visit)
    if ("content" in node) visit(node.content)
  }
  visit(parse(html))
  return out
}

describe("HTML resource paths", () => {
  test("resolves relative URLs and workspace-root URLs without decoding the source path", () => {
    expect(htmlPath("../assets/%E5%9B%BE%20a.png?v=2#icon", "site/pages/index.html")).toEqual({
      path: "site/assets/图 a.png",
      hash: "#icon",
    })
    expect(htmlPath("/assets/a.png", "site/pages/index.html")).toEqual({ path: "assets/a.png", hash: "" })
    expect(htmlPath("photo%2520x.png", "literal%20/pages/index.html")).toEqual({
      path: "literal%20/pages/photo%20x.png",
      hash: "",
    })
    expect(htmlPath("image%23a%3Fb.png", "site/index.html")).toEqual({ path: "site/image#a?b.png", hash: "" })
  })
  test("rejects protocols, UNC paths, encoded separators and upward escape", () => {
    for (const value of [
      "https://example.com/x",
      "//example.com/a",
      "file:///C:/a",
      "data:text/html,test",
      "C:/a",
      "\\\\host/a",
      "../../../secret.png",
      "/%2e%2e/secret.png",
      "x%2fy.png",
      "x%5cy.png",
    ]) {
      expect(htmlPath(value, "site/pages/index.html")).toBeUndefined()
    }
  })
})

describe("static offline HTML conversion", () => {
  test("keeps content and prepends the restrictive policy before page styles", async () => {
    const result = await setup().render(
      '<!doctype html><html lang="zh"><head><style>h1{color:red}</style></head><body><h1>你好</h1><p>可复制的内容</p></body></html>',
    )
    expect(result.html).toContain("你好")
    expect(result.html).toContain("可复制的内容")
    expect(result.html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(result.html.indexOf("<style>"))
    expect(result.html).toContain("connect-src 'none'")
    expect(result.html).toContain("script-src 'none'")
  })
  test("removes scripts, active embeds, resource hints and navigations before DOM rendering", async () => {
    const fixture = setup()
    const result = await fixture.render(
      '<base href="https://example.com"><meta http-equiv="refresh" content="0;url=https://example.com"><link rel="preload" href="https://example.com/a"><script>window.test=1</script><iframe srcdoc="test"></iframe><object data="file.html"></object><img src="https://example.com/p.png" onerror="void 0"><a href="https://example.com" ping="https://example.com/p" target="_top">link</a><a href="#local">anchor</a><form action="https://example.com"><button formaction="https://example.com">submit</button></form>',
    )
    const nodes = tags(result.html)
    expect(nodes.some((node) => ["script", "base", "iframe", "object", "link"].includes(node.tagName))).toBe(false)
    expect(
      nodes
        .flatMap((node) => node.attrs)
        .some((attr) => ["onerror", "action", "formaction", "ping", "target", "srcdoc"].includes(attr.name)),
    ).toBe(false)
    expect(
      nodes
        .filter((node) => node.tagName === "a")
        .map((node) => node.attrs.find((attr) => attr.name === "href")?.value),
    ).toEqual([undefined, "about:srcdoc#local"])
    expect(fixture.paths).toEqual([])
  })
  test("inlines linked nested CSS, local images and fonts with each stylesheet's own base", async () => {
    const fixture = setup({
      "site/theme/main.css": {
        source:
          '@import "nested/extra.css" screen; @font-face{font-family:test;src:url(font.woff2)} .x{background:url(../assets/a.png)}',
        mime: "text/css; charset=utf-8",
      },
      "site/theme/nested/extra.css": { source: ".nested{background:url(../../assets/a.png)}", mime: "text/css" },
      "site/theme/font.woff2": { source: "font-data", mime: "font/woff2" },
      "site/assets/a.png": { source: "image-data", mime: "image/png" },
    })
    const result = await fixture.render('<link rel="stylesheet" href="../theme/main.css"><p class="x">text</p>')
    expect(result.html).toContain("@media screen")
    expect(result.html).toContain(".nested")
    expect(result.html).toContain("data:font/woff2;base64,")
    expect(result.html).toContain("data:image/png;base64,")
    expect(result.html).not.toContain("@import")
    expect(fixture.paths.filter((path) => path === "site/assets/a.png")).toHaveLength(1)
    expect(result.deps).toEqual(
      new Set(
        Object.keys({
          "site/theme/main.css": 1,
          "site/theme/nested/extra.css": 1,
          "site/theme/font.woff2": 1,
          "site/assets/a.png": 1,
        }),
      ),
    )
  })
  test("preserves import layer and supports conditions", async () => {
    const result = await setup({ "site/pages/a.css": { source: ".x{color:blue}", mime: "text/css" } }).render(
      '<style>@import "a.css" layer(theme) supports(display:grid) screen;</style>',
    )
    expect(result.html).toContain("@layer theme")
    expect(result.html).toContain("@supports (display:grid)")
    expect(result.html).toContain("@media screen")
  })
  test("does not load or apply disabled and alternate stylesheets", async () => {
    const fixture = setup({ "site/pages/off.css": { source: "body{display:none}", mime: "text/css" } })
    const result = await fixture.render(
      '<link rel="stylesheet" href="off.css" disabled><link rel="alternate stylesheet" href="off.css" title="other"><p>visible content</p>',
    )
    expect(fixture.paths).toEqual([])
    expect(result.html).not.toContain("display:none")
    expect(result.html).toContain("visible content")
  })
  test("does not fetch remote CSS imports, CSS urls, source sets or inline image-set strings", async () => {
    const fixture = setup()
    const result = await fixture.render(
      '<style>@import "https://example.com/a.css"; .x{background:url(https://example.com/a.png);background-image:image-set("https://example.com/b.png" 2x)}</style><p style="background:url(//example.com/c.png)">text</p><img srcset="https://example.com/d.png 1x, https://example.com/e.png 2x">',
    )
    expect(fixture.paths).toEqual([])
    expect(result.html).not.toContain("https://example.com")
    expect(result.html).not.toContain("//example.com")
    expect(result.blocked).toBeGreaterThanOrEqual(5)
  })
  test("supports responsive local picture sources and data image URLs containing commas", async () => {
    const fixture = setup({
      "site/pages/a.png": { source: "a", mime: "image/png" },
      "site/pages/b.png": { source: "b", mime: "image/png" },
    })
    const result = await fixture.render(
      '<picture><source srcset="a.png 1x, b.png 2x"><img src="a.png" srcset="data:image/png;base64,YQ== 1x, b.png 2x"></picture>',
    )
    expect(result.html).toContain('srcset="data:image/png;base64,YQ== 1x, data:image/png;base64,Yg== 2x"')
    expect(fixture.paths.sort()).toEqual(["site/pages/a.png", "site/pages/b.png"])
  })
  test("does not execute or navigate through SVG and template content", async () => {
    const result = await setup().render(
      '<svg><script>void 0</script><foreignObject><iframe src="https://example.com"></iframe></foreignObject><use href="https://example.com/x.svg#x"/><a href="https://example.com"><text>x</text></a></svg><template shadowrootmode="open"><img src="https://example.com/x.png" onload="void 0"></template>',
    )
    expect(result.html).not.toContain("https://example.com")
    expect(result.html).not.toContain("shadowrootmode")
    expect(result.html).not.toContain("onload")
    expect(result.html).not.toContain("foreignObject")
  })
  test("uses an empty unsaved CSS draft and tracks its dependency without a disk read", async () => {
    const fixture = setup()
    const result = await fixture.render('<link rel="stylesheet" href="draft.css"><p>text</p>', (path) =>
      path === "site/pages/draft.css" ? "" : undefined,
    )
    expect(fixture.paths).toEqual([])
    expect(result.missing).toBe(0)
    expect(result.deps.has("site/pages/draft.css")).toBe(true)
  })
  test("keeps the readable document when a local resource is missing or has the wrong MIME", async () => {
    const result = await setup({ "site/pages/a.png": { source: "secret", mime: "text/plain" } }).render(
      '<img src="missing.png"><img src="a.png"><p>remaining text</p>',
    )
    expect(result.html).toContain("remaining text")
    expect(result.html).not.toContain("secret")
    expect(result.missing).toBe(1)
    expect(result.blocked).toBe(1)
    expect(result.deps.has("site/pages/missing.png")).toBe(true)
  })
  test("terminates cyclic CSS imports without deadlocking concurrent roots", async () => {
    const fixture = setup({
      "site/pages/a.css": { source: '@import "b.css"; .a{color:red}', mime: "text/css" },
      "site/pages/b.css": { source: '@import "a.css"; .b{color:blue}', mime: "text/css" },
    })
    const result = await fixture.render('<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css">')
    expect(result.html).toContain(".a")
    expect(result.html).toContain(".b")
    expect(result.blocked).toBeGreaterThan(0)
    expect(fixture.paths).toHaveLength(2)
  })
  test("escapes style closing text in external CSS before it reaches the HTML parser", async () => {
    const result = await setup({
      "site/pages/a.css": { source: '.x::after{content:"</style><img src=test>"}', mime: "text/css" },
    }).render('<link rel="stylesheet" href="a.css"><p>x</p>')
    expect(tags(result.html).filter((node) => node.tagName === "img")).toHaveLength(0)
    expect(result.html).toContain("\\3c ")
  })
  test("aborts before starting any resource work", async () => {
    const controller = new AbortController()
    controller.abort()
    let reads = 0
    await expect(
      htmlConvert({
        path: "a.html",
        source: '<img src="a.png">',
        signal: controller.signal,
        read: async () => {
          reads++
          throw new Error("unexpected")
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(reads).toBe(0)
  })
  test("fails explicitly when a local dependency graph exceeds the resource budget", async () => {
    const read: HtmlRead = async () => ({ data: new TextEncoder().encode("a").buffer, mime: "image/png" })
    await expect(
      htmlConvert({
        path: "a.html",
        source: Array.from({ length: 257 }, (_, i) => `<img src="${i}.png">`).join(""),
        signal: new AbortController().signal,
        read,
      }),
    ).rejects.toThrow("maximum 256")
  })
  test("measures the CSS budget in UTF-8 bytes, including unsaved Chinese text", async () => {
    await expect(setup().render(`<style>/*${"中".repeat(1_400_000)}*/</style>`)).rejects.toThrow(
      "stylesheet exceeds 4 MiB",
    )
  })
  test("keeps local APNG resources in the passive image preview", async () => {
    const fixture = setup({ "site/pages/animation.apng": { source: "image", mime: "image/apng" } })
    const result = await fixture.render('<img src="animation.apng">')
    expect(result.html).toContain("data:image/apng;base64,")
    expect(fixture.paths).toEqual(["site/pages/animation.apng"])
  })
})
