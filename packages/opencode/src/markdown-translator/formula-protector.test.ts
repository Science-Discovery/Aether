import { describe, expect, test } from "bun:test"
import { FormulaProtector } from "./formula-protector"

describe("FormulaProtector", () => {
  test("protects and restores inline formulas", () => {
    const fp = new FormulaProtector()
    const input = 'The energy is $E = mc^2$ and momentum is $p = mv$.'
    const protected_ = fp.protect(input)
    expect(protected_).not.toContain("$E = mc^2$")
    expect(protected_).not.toContain("$p = mv$")
    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })

  test("protects and restores block formulas", () => {
    const fp = new FormulaProtector()
    const input = "Some text\n$$\n\\int_0^1 f(x) dx\n$$\nMore text"
    const protected_ = fp.protect(input)
    expect(protected_).not.toContain("\\int_0^1")
    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })

  test("protects block formulas before inline to avoid $$ misparse", () => {
    const fp = new FormulaProtector()
    const input = "$$block$$ and $inline$"
    const protected_ = fp.protect(input)
    expect(protected_).toContain("FORMULA_BLOCK")
    expect(protected_).toContain("FORMULA_INLINE")
    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })

  test("protects and restores image references", () => {
    const fp = new FormulaProtector()
    const input = "See figure ![diagram](images/fig1.png) below."
    const protected_ = fp.protect(input)
    expect(protected_).not.toContain("![diagram](images/fig1.png)")
    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })

  test("protects and restores FIGURE placeholders", () => {
    const fp = new FormulaProtector()
    const input = "As shown in [FIGURE:fig_1] and [FORMULA_FIGURE:ffig_2]."
    const protected_ = fp.protect(input)
    expect(protected_).not.toContain("[FIGURE:fig_1]")
    expect(protected_).not.toContain("[FORMULA_FIGURE:ffig_2]")
    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })

  test("handles scientific literature with mixed formulas and images", () => {
    const fp = new FormulaProtector()
    const input = `# Quantum Field Theory

The Lagrangian is given by:

$$
\\mathcal{L} = \\bar{\\psi}(i\\gamma^\\mu\\partial_\\mu - m)\\psi
$$

As shown in ![Feynman diagram](images/feynman.png), the coupling constant $g$ determines the interaction strength.

The propagator is [FIGURE:fig_3] and the self-energy [FORMULA_FIGURE:ffig_1] is computed perturbatively.
`
    const protected_ = fp.protect(input)
    // All protected elements should be replaced with placeholders
    expect(protected_).not.toContain("$$")
    expect(protected_).not.toContain("![Feynman diagram]")
    expect(protected_).not.toContain("[FIGURE:fig_3]")
    expect(protected_).not.toContain("[FORMULA_FIGURE:ffig_1]")
    // Text content should remain
    expect(protected_).toContain("Quantum Field Theory")
    expect(protected_).toContain("The Lagrangian is given by")

    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })

  test("verify detects formula count mismatch", () => {
    const fp = new FormulaProtector()
    const original = "Test $a$ and $b$ formulas."
    fp.protect(original)
    // Simulate a translation that lost one formula
    const badTranslation = "Test ⟦FORMULA_INLINE_0⟧ formulas."
    const restored = fp.restore(badTranslation)
    const issues = fp.verify(original, restored)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain("行内公式数量不匹配")
  })

  test("verify passes when all formulas are preserved", () => {
    const fp = new FormulaProtector()
    const original = "Test $a$ and $b$ with $$c$$ block."
    const protected_ = fp.protect(original)
    const restored = fp.restore(protected_)
    const issues = fp.verify(original, restored)
    expect(issues).toHaveLength(0)
  })

  test("tolerates corrupted placeholders during restore", () => {
    const fp = new FormulaProtector()
    const input = "Energy $E=mc^2$ here."
    fp.protect(input)
    // Simulate LLM truncating closing bracket
    const corrupted = "Energy ⟦FORMULA_INLINE_0 here."
    const restored = fp.restore(corrupted)
    expect(restored).toContain("$E=mc^2$")
  })

  test("handles single-dollar block formulas from PDF conversion", () => {
    const fp = new FormulaProtector()
    const input = "Before\n$\nE = mc^2\n$\nAfter"
    const protected_ = fp.protect(input)
    expect(protected_).toContain("FORMULA_BLOCK")
    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })

  test("protects multi-line inline formula does not cross lines", () => {
    const fp = new FormulaProtector()
    const input = "Value $x$\nnot $y$ here"
    const protected_ = fp.protect(input)
    expect(protected_).toContain("FORMULA_INLINE_0")
    expect(protected_).toContain("FORMULA_INLINE_1")
    const restored = fp.restore(protected_)
    expect(restored).toBe(input)
  })
})
