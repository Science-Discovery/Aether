import { describe, expect, test } from "vitest"
import { createMarkedParser, decodeMath, normalizeMath, prepareMathMarkdown, renderMathInText } from "./marked"

describe("marked math", () => {
  test("decodes html entities inside math", () => {
    expect(decodeMath("a &amp; b")).toBe("a & b")
    expect(decodeMath(String.raw`k&#39; &lt; \Lambda &quot;x&quot; &gt; 0`)).toBe(String.raw`k' < \Lambda "x" > 0`)
  })

  test("normalizes tex delimiters", () => {
    expect(normalizeMath(String.raw`consider \(SO(2)\)`)).toBe("consider $SO(2)$")
    expect(normalizeMath(String.raw`\[
a+b
\]`)).toContain("$$\na+b\n$$")
  })

  test("prepares display math blocks without requiring manual blank lines", () => {
    expect(prepareMathMarkdown("foo\n$$\na+b\n$$")).toBe("foo\n\n$$\na+b\n$$")
    expect(prepareMathMarkdown("$$\na+b\n$$\nbar")).toBe("$$\na+b\n$$\n\nbar")
  })

  test("renders matrix formulas without leaking html entities", () => {
    const html = renderMathInText(String.raw`
$$
\begin{pmatrix}
\cos\theta &amp; -\sin\theta \\
\sin\theta &amp; \cos\theta
\end{pmatrix}
$$
`)
    const root = document.createElement("div")
    root.innerHTML = html
    const text = root.querySelector(".katex-html")?.textContent ?? ""

    expect(html).toContain("katex-display")
    expect(text).toContain("cos")
    expect(text).toContain("sin")
    expect(text).not.toContain("amp;")
  })

  test("renders long formulas with primes and inequalities", () => {
    const html = renderMathInText(String.raw`
$$
S=\int_{|k&#39;|&lt;b\Lambda}\frac{\mathrm{d}^d k&#39;}{(2\pi)^d}\phi&#39;(-k&#39;)\phi&#39;(k&#39;)
$$
`)
    const root = document.createElement("div")
    root.innerHTML = html
    const text = root.querySelector(".katex-html")?.textContent ?? ""

    expect(html).toContain("katex-display")
    expect(text).toContain("′")
    expect(text).toContain("<")
    expect(text).not.toContain("&#39;")
    expect(text).not.toContain("&lt;")
  })

  test("renders big delimiters inside display math", () => {
    const html = renderMathInText(String.raw`
$$
\binom{N}{kN}\approx
\exp\Big\{N\Big[ ... \Big]\Big\}.
$$
`)
    expect(html).toContain("katex-display")
    expect(html).not.toContain("katex-error")
  })

  test("renders display math when equals is on its own line", () => {
    const html = renderMathInText(String.raw`
$$
\theta_{\gamma(k)}(-\epsilon(k))
=
\int_{-\infty}^{0} d\omega\,
\delta_{\gamma(k)}(\omega-\epsilon(k))
$$
`)
    expect(html).toContain("katex-display")
    expect(html).not.toContain("katex-error")
  })

  test("renders thin spaces inside display math", () => {
    const html = renderMathInText(String.raw`
$$
\langle x|\alpha\rangle =
\int d^3y\, \langle 0|\psi(x)\psi^\dagger(y)|0\rangle \phi_\alpha(y) ,
$$
`)
    expect(html).toContain("katex-display")
    expect(html).not.toContain("katex-error")
  })

  test("parses display math blocks without a blank line before them", async () => {
    const parser = createMarkedParser()
    const html = await parser.parse(String.raw`说明：
$$
\binom{N}{kN}\approx
\exp\Big\{N\Big[ ... \Big]\Big\}.
$$`)

    expect(html).toContain("katex-display")
    expect(html).toContain("说明：</p>")
    expect(html).not.toContain("$$")
  })

  test("keeps text between display math blocks renderable", async () => {
    const parser = createMarkedParser()
    const html = await parser.parse(String.raw`$$
\chi_s=\frac{1}{V}\left(\frac{\partial S}{\partial B}\right)_{T,V},
$$
其中总自旋（total spin）为
$$
S=\sum_{s=\pm 1}s\frac{1}{2}\int \frac{d^3k}{(2\pi)^3}\bar n_{ks},
$$`)

    expect(html.match(/katex-display/g)?.length).toBe(2)
    expect(html).toContain("其中总自旋")
  })

  test("does not treat fenced code blocks as math", async () => {
    const parser = createMarkedParser()
    const html = await parser.parse(["plain", "```tex", "$$", String.raw`\exp\Big\{x\Big\}`, "$$", "```"].join("\n"))

    expect(html).not.toContain("katex-display")
    expect(html).toContain("<pre")
  })

  test("parses plain markdown through the shared renderer", async () => {
    const parser = createMarkedParser()
    const html = await parser.parse(["# title", "", "plain text"].join("\n"))

    expect(html).toContain("<h1")
    expect(html).toContain("<p>plain text</p>")
  })
})
