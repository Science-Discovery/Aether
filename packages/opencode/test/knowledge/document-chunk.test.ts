import { describe, expect, test } from "bun:test"
import path from "path"
import { chunkText, parsePDF } from "../../src/knowledge/document"

const fixture = path.join(import.meta.dir, "..", "tool", "fixtures", "cid-chinese.pdf")

const opts = { chunkSize: 500, chunkOverlap: 50 }

function join(chunks: { content: string }[]) {
  return chunks.map((item) => item.content).join("")
}

describe("chunkText", () => {
  test("splits on CJK sentence punctuation", () => {
    // Regression: the ASCII-only /[^.!?]+[.!?]+/ pattern matched nothing here,
    // collapsing the whole document into a single oversized chunk.
    const text = "第一句话。第二句话。第三句话。".repeat(60)
    const chunks = chunkText(text, opts)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(opts.chunkSize)
  })

  test("splits on fullwidth period and semicolon", () => {
    // Chinese journals often typeset ．(U+FF0E) and ；instead of 。
    const text = "量子色动力学取得了成功；但其非微扰问题仍有困难．胶子球便是典型例子．".repeat(40)
    const chunks = chunkText(text, opts)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(opts.chunkSize)
  })

  test("keeps trailing text that has no sentence terminator", () => {
    // Regression: `match(...) || [paraText]` only fell back when there were zero
    // matches, so text after the last ASCII period was silently dropped.
    const text = "Head clause. ".repeat(80) + "UNIQUE_TAIL_WITHOUT_TERMINATOR"
    const chunks = chunkText(text, opts)
    expect(join(chunks)).toContain("UNIQUE_TAIL_WITHOUT_TERMINATOR")
  })

  test("drops nothing when the only ASCII period sits mid-number", () => {
    // The real-world failure: a 9-page policy PDF whose single ASCII period was
    // inside "×1.75", so 75% of the document was discarded.
    const head = "学业能力测评分数等于加权平均分减六十再乘以一点七五"
    const tail = "其中实行等级制考核的课程依据研究生课程学习与成绩管理办法执行"
    const text = `${head}×1.75\n${tail.repeat(80)}`
    const chunks = chunkText(text, opts)
    const kept = join(chunks)
    expect(kept).toContain("×1.75")
    expect(kept).toContain("成绩管理办法执行")
    expect(chunks.length).toBeGreaterThan(1)
  })

  test("hard-splits a long run with no punctuation at all", () => {
    const text = "无标点连续中文字符".repeat(400)
    const chunks = chunkText(text, opts)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(opts.chunkSize)
  })

  test("hard-splits a long unbreakable line", () => {
    // PDF extraction yields one \n per line and no blank lines, so paragraph
    // splitting produces a single unit that must fall back to line splitting.
    const text = Array.from({ length: 200 }, (_, i) => `第${i}行内容没有句末标点`).join("\n")
    const chunks = chunkText(text, opts)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(opts.chunkSize)
    for (let i = 0; i < 200; i++) expect(join(chunks)).toContain(`第${i}行`)
  })

  test("never exceeds chunkSize", () => {
    const samples = [
      "English sentences with periods. ".repeat(200),
      "中文句子带句号。".repeat(200),
      "Mixed 中英 mixed。with periods. ".repeat(200),
      "x".repeat(5000),
    ]
    for (const text of samples) {
      for (const chunk of chunkText(text, opts)) {
        expect(chunk.content.length).toBeLessThanOrEqual(opts.chunkSize)
      }
    }
  })

  test("preserves every line of the source", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `第${i}条 学生素质综合测评内容包括基本素质与学业学术。`)
    const text = lines.join("\n")
    const kept = join(chunkText(text, opts))
    for (const line of lines) expect(kept).toContain(line)
  })

  test("handles degenerate options without overflowing", () => {
    const text = "一些中文内容。另一些内容。"
    // overlap >= size would loop forever or emit empty chunks; clamp instead
    const chunks = chunkText(text, { chunkSize: 10, chunkOverlap: 50 })
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(10)
      expect(chunk.content.length).toBeGreaterThan(0)
    }
  })

  test("returns no chunks for blank input", () => {
    expect(chunkText("", opts)).toEqual([])
    expect(chunkText("   \n  \n ", opts)).toEqual([])
  })

  test("breaks chunks at CJK sentence boundaries", () => {
    // Without CJK punctuation in the split class, chunks get cut mid-sentence.
    const text = "第一句话内容。第二句话内容。第三句话内容。".repeat(60)
    const chunks = chunkText(text, opts)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.content.endsWith("。")).toBe(true)
  })

  test("keeps English chunking behaviour unchanged", () => {
    const text = "Quantum computing is based on quantum mechanics. It uses superposition of qubits. ".repeat(60)
    const chunks = chunkText(text, opts)
    const lens = chunks.map((item) => item.content.length)
    expect(chunks.length).toBeGreaterThan(10)
    expect(Math.max(...lens)).toBeLessThanOrEqual(opts.chunkSize)
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length
    // Previously avg ~423 with max 1137; chunk density must not regress.
    expect(avg).toBeGreaterThan(350)
  })
})

describe("parsePDF", () => {
  test("extracts CJK text from a CID-font PDF via cmaps", async () => {
    // The fixture uses STSong-Light with predefined UniGB-UCS2-H encoding and no
    // ToUnicode map, so decoding requires the vendored Adobe CMap tables.
    // Without cMapUrl pdf.js yields an empty string here.
    const parsed = await parsePDF(fixture)
    expect(parsed.pageCount).toBe(1)
    expect(parsed.text).toContain("测试中文字形提取")
  })

  test("chunks the extracted CJK text", async () => {
    const parsed = await parsePDF(fixture)
    const chunks = chunkText(parsed.text, opts)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.content).toBe("测试中文字形提取")
  })
})
