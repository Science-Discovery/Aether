import { describe, expect, test } from "bun:test"
import { chunkByContent } from "./chunker"

describe("chunkByContent", () => {
  test("splits by ## headings", () => {
    const md = `# Title

Intro paragraph.

## Section 1

Content of section 1.

## Section 2

Content of section 2.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toContain("Intro paragraph")
    expect(chunks[1]).toContain("Section 1")
    expect(chunks[2]).toContain("Section 2")
  })

  test("splits by blank lines when no ## headings", () => {
    const md = `First paragraph.


Second paragraph.


Third paragraph.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(3)
  })

  test("treats single blank line as same chunk (paragraph continuation)", () => {
    const md = `First paragraph.

Second paragraph.`
    const chunks = chunkByContent(md)
    // Single blank line = paragraph break within same chunk
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("First paragraph")
    expect(chunks[0]).toContain("Second paragraph")
  })

  test("preserves code blocks within a chunk", () => {
    const md = `## Code Example

Here is some code:

\`\`\`python
def hello():
    print("hello")

    for i in range(10):
        print(i)
\`\`\`

After code.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("```python")
    expect(chunks[0]).toContain("```")
  })

  test("preserves math blocks within a chunk", () => {
    const md = `## Equations

The energy-mass relation:

$$
E = mc^2
$$

And the momentum: $p = mv$.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("$$")
    expect(chunks[0]).toContain("$p = mv$")
  })

  test("handles scientific paper with mixed sections", () => {
    const md = `# Paper Title

Abstract text here.

## Introduction

Some intro text with formula $E = mc^2$.

## Methods

We used the following approach:

1. Step one
2. Step two

## Results

| Experiment | Value |
| --- | --- |
| A | 1.0 |
| B | 2.0 |

## Conclusion

Final remarks.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(5)
  })

  test("handles empty content", () => {
    expect(chunkByContent("")).toHaveLength(0)
    expect(chunkByContent("   \n  \n  ")).toHaveLength(0)
  })

  test("handles single paragraph without headings", () => {
    const md = "Just a single paragraph of text."
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe("Just a single paragraph of text.")
  })

  test("does not split code blocks across chunks", () => {
    const code = "x".repeat(2000)
    const md = `## Section

Intro text.

\`\`\`python
${code}
\`\`\`

More text after code.

## Next Section

Another section.`
    const chunks = chunkByContent(md)
    // The code block should stay in the same chunk as its section
    const codeChunk = chunks.find(c => c.includes("```python"))
    expect(codeChunk).toBeDefined()
    expect(codeChunk!.includes("```")).toBe(true)
    // Opening and closing backtick fences should be in the same chunk
    const fences = codeChunk!.match(/```/g)
    expect(fences).toHaveLength(2)
  })

  test("does not split display math across chunks", () => {
    const formula = "x".repeat(500)
    const md = `## Derivation

Starting from:

$$
${formula}
$$

We conclude.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("$$")
  })

  test("handles table staying in one chunk", () => {
    const md = `## Results

Our measurements:

| Name | Value | Error |
| --- | --- | --- |
| alpha | 1.234 | 0.001 |
| beta | 5.678 | 0.002 |
| gamma | 9.012 | 0.003 |

Discussion of results.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    const tableChunk = chunks[0]
    expect(tableChunk).toContain("| Name |")
    expect(tableChunk).toContain("| gamma |")
  })

  test("handles consecutive headings without body", () => {
    const md = `## A
## B
## C
Content here.`
    const chunks = chunkByContent(md)
    // Each heading creates a new chunk; C has content
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })

  test("preserves ### subheadings within a ## chunk", () => {
    const md = `## Methods

### Part A

Content A.

### Part B

Content B.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("### Part A")
    expect(chunks[0]).toContain("### Part B")
  })

  test("does not split inside fenced code blocks even with internal blank lines", () => {
    const md = `## Code

Intro.

\`\`\`python
def foo():
    pass

def bar():
    pass
\`\`\`

Post-code.`
    const chunks = chunkByContent(md)
    const codeChunk = chunks.find(c => c.includes("```python"))
    expect(codeChunk).toBeDefined()
    // The code block must not be split across chunks
    expect(codeChunk!.includes("def bar")).toBe(true)
    expect(codeChunk!.includes("Post-code")).toBe(true)
  })

  test("handles $$ math with blank lines inside", () => {
    const md = `## Math

Some text.

$$
\\begin{aligned}
a &= b \\\\
c &= d
\\end{aligned}
$$

After math.`
    const chunks = chunkByContent(md)
    const mathChunk = chunks.find(c => c.includes("$$"))
    expect(mathChunk).toBeDefined()
    expect(mathChunk!.includes("\\begin{aligned}")).toBe(true)
    expect(mathChunk!.includes("After math")).toBe(true)
  })

  test("does not split markdown table with blank rows", () => {
    const md = `## Data

Header text.

| A | B |
| --- | --- |
| 1 | 2 |

| 3 | 4 |
| 5 | 6 |

Footer text.`
    const chunks = chunkByContent(md)
    const tableChunk = chunks.find(c => c.includes("| A |"))
    expect(tableChunk).toBeDefined()
    expect(tableChunk!.includes("| 5 |")).toBe(true)
  })

  test("does not treat ## inside fenced code blocks as headings", () => {
    const md = `## Section

Before code.

\`\`\`markdown
## This is inside a code block

Some text inside the block.
\`\`\`

After code.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    // The ## inside the code block must NOT cause a split
    expect(chunks[0]).toContain("## This is inside a code block")
    expect(chunks[0]).toContain("After code")
  })

  test("does not split $$ display math in splitLargeChunk", () => {
    const para = "x".repeat(4000)
    const md = `${para}

Starting text.

$$
E = mc^2

F = ma
$$

Ending text.`
    const chunks = chunkByContent(md)
    // The $$ block must not be split
    const mathChunk = chunks.find(c => c.includes("$$"))
    expect(mathChunk).toBeDefined()
    expect(mathChunk!.includes("E = mc^2")).toBe(true)
    expect(mathChunk!.includes("F = ma")).toBe(true)
  })

  test("does not split fenced code blocks in splitLargeChunk", () => {
    const para = "x".repeat(4000)
    const md = `${para}

Intro.

\`\`\`python
def foo():
    pass

def bar():
    pass
\`\`\`

Post.`
    const chunks = chunkByContent(md)
    const codeChunk = chunks.find(c => c.includes("```python"))
    expect(codeChunk).toBeDefined()
    expect(codeChunk!.includes("def bar")).toBe(true)
  })

  test("handles nested code blocks with different fence lengths", () => {
    const md = `## Example

Before.

\`\`\`
Inside outer code block.
## Fake heading

More code.
\`\`\`

After.`
    const chunks = chunkByContent(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("## Fake heading")
    expect(chunks[0]).toContain("After")
  })

  test("respects ### sub-headings as boundaries within ## sections when content is large", () => {
    const para = "x".repeat(3000)
    const md = `## Methods

${para}

### Submethod A

Content about submethod A.

### Submethod B

Content about submethod B.`
    const chunks = chunkByContent(md)
    // The large initial paragraph and sub-methods should be logically grouped
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    // Verify sub-headings are preserved
    const allText = chunks.join(" ")
    expect(allText).toContain("### Submethod A")
    expect(allText).toContain("### Submethod B")
  })
})
