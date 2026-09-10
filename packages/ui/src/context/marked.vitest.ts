import { describe, expect, test } from "vitest"
import { parseMarkdown, joinMath, guardPipes, decodeMath, normalizeMath, renderMathInText } from "./marked"

describe("marked math", () => {
  test("decodes html entities inside math", () => {
    expect(decodeMath("a &amp; b")).toBe("a & b")
    expect(decodeMath(String.raw`k&#39; &lt; \Lambda &quot;x&quot; &gt; 0`)).toBe(String.raw`k' < \Lambda "x" > 0`)
  })

  test("normalizes tex delimiters", () => {
    expect(normalizeMath(String.raw`consider \(SO(2)\)`)).toBe("consider $SO(2)$")
    expect(
      normalizeMath(String.raw`\[
a+b
\]`),
    ).toContain("$$\na+b\n$$")
  })

  test("joins line-wrapped inline math", () => {
    expect(joinMath("$a+b\n=c$ x")).toBe("$a+b =c$ x")
    expect(joinMath("$a+b\n=c\n+d$ x")).toBe("$a+b =c +d$ x")
    expect(joinMath("$a+b$ and $c\n=d$")).toBe("$a+b$ and $c =d$")
    expect(joinMath("$a\r\n=b$ x")).toBe("$a =b$ x")
    expect(joinMath("prev $x$ tail\nnext $y\n=z$ end")).toBe("prev $x$ tail\nnext $y =z$ end")
    expect(joinMath("$$\na+b\n$$")).toBe("$$ a+b $$")
    expect(joinMath("$$a+b$$")).toBe("$$a+b$$")
  })

  test("joins display math not alone on its lines", () => {
    expect(joinMath("text $$a+b\n=c$$ tail")).toBe("text $$a+b =c$$ tail")
    expect(joinMath("$$\\underbrace{x}_{y}\n+z$$")).toBe("$$\\underbrace{x}_{y} +z$$")
    expect(joinMath("$$a\n=b\n$$")).toBe("$$a =b $$")
    expect(joinMath("$$a\n\nb$$")).toBe("$$a\n\nb$$")
    expect(joinMath("para text\n$$\na+b\n$$\ntail text")).toBe("para text\n$$ a+b $$\ntail text")
  })

  test("escapes pipes inside math on table rows", () => {
    expect(guardPipes("| a | $|x|$ |\n|---|---|")).toBe("| a | $\\|x\\|$ |\n|---|---|")
    expect(guardPipes("| h |\n|---|\n| $|y|$ |")).toBe("| h |\n|---|\n| $\\|y\\|$ |")
    expect(guardPipes("| h | $|z|$ |\n---|---")).toBe("| h | $\\|z\\|$ |\n---|---")
    expect(guardPipes("| $a$ |\n| $|x|$ |")).toBe("| $a$ |\n| $|x|$ |")
    expect(guardPipes("| $|x|$ |\nprose\n| $|y|$ |")).toBe("| $|x|$ |\nprose\n| $|y|$ |")
    expect(guardPipes("code:\n```\n| $|x|$ |\n```")).toBe("code:\n```\n| $|x|$ |\n```")
    expect(guardPipes("$|x|$ plain paragraph")).toBe("$|x|$ plain paragraph")
  })

  test("does not join inline math across block boundaries", () => {
    expect(joinMath("$a\n\nb$")).toBe("$a\n\nb$")
    expect(joinMath("$a\r\n\r\nb$")).toBe("$a\n\nb$")
    expect(joinMath("$a\n```js\nb\n```\nc$")).toBe("$a\n```js\nb\n```\nc$")
    expect(joinMath("$a\n| b$")).toBe("$a\n| b$")
    expect(joinMath("$a\n- b$")).toBe("$a\n- b$")
    expect(joinMath("$a\n# b$")).toBe("$a\n# b$")
    expect(joinMath("$a\n1. b$")).toBe("$a\n1. b$")
  })

  test("joins math wrapped across blockquote lines", () => {
    expect(joinMath("> $a+b\n> =c$ tail")).toBe("> $a+b =c$ tail")
    expect(joinMath("> $$a+b\n> =c$$ tail")).toBe("> $$a+b =c$$ tail")
    expect(joinMath("$a\n> =b$")).toBe("$a =b$")
  })

  test("escapes bare stars inside math but not in text-mode groups", () => {
    expect(joinMath("*em* $(x)^*=-y$")).toBe("*em* $(x)^\\ast =-y$")
    expect(joinMath("$$a*b$$")).toBe("$$a\\ast b$$")
    expect(joinMath("$\\text{a*b}$")).toBe("$\\text{a*b}$")
    expect(joinMath("$\\mathrm{conv*}$")).toBe("$\\mathrm{conv*}$")
    expect(joinMath("plain *em* text")).toBe("plain *em* text")
  })

  test("keeps prose between dollars as text, not math", () => {
    expect(joinMath("costs $5 and $10 total")).toBe("costs \\$5 and \\$10 total")
    expect(joinMath("from $5\nup to $10 total")).toBe("from \\$5 up to \\$10 total")
    expect(joinMath("between $a and b$ here")).toBe("between \\$a and b\\$ here")
    expect(joinMath("价格 $5 和 $10 左右")).toContain("\\$")
    expect(joinMath("math $x$ and $a + b$ stay")).toBe("math $x$ and $a + b$ stay")
    expect(joinMath("$E=mc^2$ stays")).toBe("$E=mc^2$ stays")
    expect(joinMath("products $E L$ and $M L$ stay")).toBe("products $E L$ and $M L$ stay")
    expect(joinMath("scaling $(mv, mv, mv)$ stays")).toBe("scaling $(mv, mv, mv)$ stays")
  })

  test("does not join or escape dollars inside indented code", () => {
    const src = ["para:", "", "    code $a", "    b$ code", "", "after"].join("\n")
    expect(joinMath(src)).toBe(src)
    const wrapped = "$a\n    =b$ x"
    expect(joinMath(wrapped)).toBe("$a =b$ x")
  })

  test("renders wrapped inline math without html leakage", async () => {
    const out = await parseMarkdown(
      [
        "text $x\\to\\ell\\infty$ then $W_\\ell^\\dagger T",
        "W_\\ell$ and $\\mathrm{Poles}^{(n)}\\propto c_n\\times",
        "(\\gamma\\coth\\gamma-1)/\\epsilon_{\\rm IR}$ end",
      ].join("\n"),
    )

    expect(out).not.toContain("<em>")
    expect(out).not.toContain("&lt;span")
    expect(out).not.toContain("$")
    expect((out.match(/class="katex"/g) ?? []).length).toBe(3)
  })

  test("single tilde is not strikethrough, double tilde is", async () => {
    const html = await parseMarkdown("Eqs.~(15) and Eqs.~(16), also ~~gone~~ here")
    expect(html).toContain("<del>gone</del>")
    expect(html).not.toContain("<del>(15)")
    expect(html).toContain("~(15)")
  })

  test("renders wrapped display math with underbraces", async () => {
    const out = await parseMarkdown(
      [
        "$$\\underbrace{\\text{L1 eikonal}}_{\\text{established}}",
        "+\\underbrace{\\text{C2 completeness}}_{\\text{core}}",
        "\\Longrightarrow D_{i\\to H}=\\sum_n d_{i\\to n}.$$",
      ].join("\n"),
    )
    expect(out).toContain("katex-display")
    expect(out).not.toContain("<em>")
    expect(out).not.toContain("$")
  })

  test("paper-style fixture renders without corruption", async () => {
    const out = await parseMarkdown(
      [
        "# Note",
        "",
        "Refs with tildes: Eq.~(5), Eqs.~(15)–(16), keep ~~strike~~.",
        "",
        "Wrapped inline $W_\\ell^\\dagger T",
        "W_\\ell$ plus $\\mathrm{Poles}^{(n)}\\propto c_n$.",
        "",
        "$$\\underbrace{\\text{L1}}_{\\text{est}}",
        "+\\Longrightarrow D_{i\\to H}.$$ tail",
        "",
        "| k | v |",
        "|---|---|",
        "| 1 | $|x|\\sim 2$ |",
        "",
        "```ts",
        "const s = '$5 and $6'",
        "```",
        "",
        "Plain $a<b$ math and $\\ell\\cdot k$.",
      ].join("\r\n"),
    )

    expect((out.match(/<del>/g) ?? []).length).toBe(1)
    expect(out).toContain("<del>strike</del>")
    expect(out).toContain("~(5)")
    expect(out).toContain("katex-display")
    expect(out).not.toContain("&lt;span")
    expect(out).not.toContain("&lt;em")
    expect(out).toContain("$5 and $6")
    expect(out.replace(/<pre[\s\S]*?<\/pre>/g, "")).not.toContain("$")
  })

  test("star superscript inside math does not close surrounding italics", async () => {
    const out = await parseMarkdown("**Lemma S.** *With (1.1): (i) $(\\phi_{A,L})^*=-\\phi_{C,L}$ (the graded signs).*")
    expect(out).toContain("<em>With")
    expect(out).toContain("katex")
    expect(out).not.toContain("$")
  })

  test("renders math wrapped across blockquote lines", async () => {
    const out = await parseMarkdown(
      [
        "> **Corollary T2.** $W_F$ is *not* transverse:",
        "> $k\\big[(p\\!\\cdot\\!k_1)\\,q\\nu",
        "> =-\\,ig\\,f_{abc}\\big/\\delta$ tail",
      ].join("\n"),
    )
    expect(out).toContain("blockquote")
    expect(out).toContain("katex")
    expect(out).not.toContain("$")
  })

  test("currency amounts are not rendered as math", async () => {
    const out = await parseMarkdown("It costs $5 and $10 more, or $x$ in math.")
    expect(out).toContain("$5")
    expect(out).toContain("$10")
    expect((out.match(/class="katex"/g) ?? []).length).toBe(1)
    expect(out).not.toContain("katex-error")
  })

  test("fallback pass does not swallow html between stray dollars", () => {
    const out = renderMathInText('$a\nb$ <span class="katex">keep</span>')
    expect(out).toContain('<span class="katex">keep</span>')
    expect(out).not.toContain("&lt;span")

    const display = renderMathInText('$$a <span class="katex">x</span> b$$')
    expect(display).toContain('$$a <span class="katex">x</span> b$$')
    expect(display).not.toContain("&lt;span")
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
