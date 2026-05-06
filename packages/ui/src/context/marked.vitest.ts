import { describe, expect, test } from "vitest"
import { decodeMath, normalizeMath, renderMathInText } from "./marked"

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
})
