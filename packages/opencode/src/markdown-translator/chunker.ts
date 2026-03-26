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
    // 按连续空行分块
    rawChunks = content.split(/\n{3,}/).filter((c) => c.trim().length > 0)
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

/** 按 ## 标题分块 */
function splitByHeading(content: string): string[] {
  const lines = content.split("\n")
  const chunks: string[] = []
  let current: string[] = []

  for (const line of lines) {
    if (/^## /.test(line) && current.length > 0) {
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

/** 在段落边界处拆分超大块 */
function splitLargeChunk(chunk: string): string[] {
  const paragraphs = chunk.split(/\n\n+/)
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
