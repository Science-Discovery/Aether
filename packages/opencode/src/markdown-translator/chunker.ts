/**
 * Markdown 分块器
 *
 * 两种模式：
 * A. 从 _data.json 获取分页（用于 PDF 转换产物）
 * B. 按内容分块（用于普通 .md 文件）
 */

import fs from "fs/promises"
import type { ConvertDataJSON } from "../pdf-converter/types"

const MAX_CHUNK_SIZE = 8000

/**
 * 检测是否存在对应的 _data.json 文件。
 * 给定 .md 文件路径，检查同目录下是否存在 {basename}_data.json。
 */
export async function detectDataJson(mdPath: string): Promise<string | null> {
  const ext = mdPath.match(/\.[^.]+$/)?.[0] ?? ""
  const base = mdPath.slice(0, mdPath.length - ext.length)
  const dataJsonPath = `${base}_data.json`
  if (await Bun.file(dataJsonPath).exists()) {
    return dataJsonPath
  }
  return null
}

/**
 * 模式 A：从 _data.json 获取分页
 * 每页的 final_content 作为一个独立的翻译块。
 */
export async function chunksFromDataJson(dataJsonPath: string): Promise<string[]> {
  const raw = await fs.readFile(dataJsonPath, "utf-8")
  const data: ConvertDataJSON = JSON.parse(raw)
  return data.pages.map((p) => p.final_content).filter((c) => c.trim().length > 0)
}

/**
 * 模式 B：按内容分块
 * - 优先按 ## 二级标题分块
 * - 如果没有二级标题，按连续空行分块
 * - 如果单块超过 MAX_CHUNK_SIZE 字符，在段落边界处进一步拆分
 */
export function chunkByContent(content: string): string[] {
  let rawChunks: string[]

  // 检查是否有二级标题
  if (/^## /m.test(content)) {
    // 按 ## 标题分块
    rawChunks = splitByHeading(content)
  } else {
    // 按连续空行分块（保护代码块、公式、表格）
    rawChunks = splitSafeParagraphs(content)
  }

  // 如果只有一个块且内容为空，返回空
  if (rawChunks.length === 0) return []

  // 对超大块进一步拆分
  const result: string[] = []
  for (const chunk of rawChunks) {
    if (chunk.length <= MAX_CHUNK_SIZE) {
      result.push(chunk)
    } else {
      result.push(...splitLargeChunk(chunk))
    }
  }

  return result
}

/** Track whether a line is inside a fenced code block */
function isInCodeBlock(lines: string[]): boolean[] {
  const flags: boolean[] = new Array(lines.length).fill(false)
  let inside = false
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!inside) {
      const m = line.match(/^(>{0,3})\s*(`{3,}|~{3,})/)
      if (m) {
        inside = true
        fenceLen = m[2]!.length
        flags[i] = false // opening fence itself is not "inside"
        continue
      }
    } else {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*$/)
      if (m && m[1]!.length >= fenceLen) {
        inside = false
        flags[i] = false
        continue
      }
    }
    flags[i] = inside
  }
  return flags
}

/** 按 ## 标题分块（不拆分代码块内部） */
function splitByHeading(content: string): string[] {
  const lines = content.split("\n")
  const codeFlags = isInCodeBlock(lines)
  const chunks: string[] = []
  let current: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Only split on ## headings that are NOT inside a fenced code block
    if (/^## /.test(line) && current.length > 0 && !codeFlags[i]) {
      const text = current.join("\n").trim()
      if (text) chunks.push(text)
      current = []
    }
    current.push(line)
  }

  if (current.length > 0) {
    const text = current.join("\n").trim()
    if (text) chunks.push(text)
  }

  return chunks
}

/**
 * Split a string by triple-or-more newlines while keeping $$ math blocks,
 * fenced code blocks, and tables intact as single units.
 */
function splitSafeParagraphs(chunk: string): string[] {
  // Collect ranges that must not be split across
  const protectedRanges: [number, number][] = []

  // Protect fenced code blocks
  for (const m of chunk.matchAll(/```[\s\S]*?```/g)) {
    if (m.index !== undefined) protectedRanges.push([m.index, m.index + m[0].length])
  }

  // Protect $$ ... $$ (non-greedy, including newlines)
  for (const m of chunk.matchAll(/\$\$[\s\S]*?\$\$/g)) {
    if (m.index !== undefined) protectedRanges.push([m.index, m.index + m[0].length])
  }

  // Protect single-dollar block math ($ on its own line)
  for (const m of chunk.matchAll(/^\$\s*\n[\s\S]*?\n\$\s*$/gm)) {
    if (m.index !== undefined) protectedRanges.push([m.index, m.index + m[0].length])
  }

  // Protect tables: lines starting with | (header + separator + data rows)
  // Find contiguous groups of | lines
  const lines = chunk.split("\n")
  let tableStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i]!)) {
      if (tableStart === -1) tableStart = i
    } else {
      if (tableStart !== -1) {
        const startIdx = chunk.indexOf(lines[tableStart]!)
        const endLine = lines[i - 1]!
        const endIdx = chunk.indexOf(endLine, startIdx) + endLine.length
        protectedRanges.push([startIdx, endIdx])
        tableStart = -1
      }
    }
  }
  if (tableStart !== -1) {
    const startIdx = chunk.indexOf(lines[tableStart]!)
    const endLine = lines[lines.length - 1]!
    const endIdx = chunk.indexOf(endLine, startIdx) + endLine.length
    protectedRanges.push([startIdx, endIdx])
  }

  // Split by 3+ newlines (two or more blank lines)
  const result: string[] = []
  let lastEnd = 0
  for (const m of chunk.matchAll(/\n{3,}/g)) {
    const splitAt = m.index!
    // Check if this split point is inside a protected range
    const inProtected = protectedRanges.some(
      ([start, end]) => splitAt >= start && splitAt < end,
    )
    if (!inProtected) {
      const segment = chunk.slice(lastEnd, splitAt)
      if (segment.trim()) result.push(segment)
      lastEnd = splitAt + m[0].length
    }
  }
  const tail = chunk.slice(lastEnd)
  if (tail.trim()) result.push(tail)
  return result
}

/** 在安全段落边界处拆分超大块（保护代码、公式、表格） */
function splitLargeChunk(chunk: string): string[] {
  const paragraphs = splitSafeParagraphs(chunk)
  const result: string[] = []
  let current: string[] = []
  let currentSize = 0

  for (const para of paragraphs) {
    if (currentSize + para.length > MAX_CHUNK_SIZE && current.length > 0) {
      result.push(current.join("\n\n"))
      current = []
      currentSize = 0
    }
    current.push(para)
    currentSize += para.length
  }

  if (current.length > 0) {
    result.push(current.join("\n\n"))
  }

  return result
}

/**
 * 获取分块（统一入口）
 * 自动检测 _data.json，有则按页分块，否则按内容分块。
 */
export async function getChunks(mdPath: string): Promise<{ chunks: string[]; hasDataJson: boolean }> {
  const dataJsonPath = await detectDataJson(mdPath)
  if (dataJsonPath) {
    const chunks = await chunksFromDataJson(dataJsonPath)
    return { chunks, hasDataJson: true }
  }
  const content = await fs.readFile(mdPath, "utf-8")
  const chunks = chunkByContent(content)
  return { chunks, hasDataJson: false }
}
