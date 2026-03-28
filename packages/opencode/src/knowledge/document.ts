import type { ChunkMeta } from "./types"
import { Storage } from "./storage"
import { extractText, getDocumentProxy } from "unpdf"
import path from "path"

// PDF 解析结果
export interface ParsedDocument {
  text: string
  pages: { pageNumber: number; text: string }[]
  pageCount: number
}

// 文档分块结果
export interface ChunkedDocument {
  chunks: Chunk[]
}

export interface Chunk {
  content: string
  pageNumber?: number
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".tex", ".rst", ".json", ".yml", ".yaml", ".csv"])

export function isTextDocument(filePath: string) {
  return TEXT_EXT.has(path.extname(filePath).toLowerCase())
}

export function isSupportedDocument(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === ".pdf" || isTextDocument(filePath)
}

// PDF 解析 - 使用 unpdf 库
export async function parsePDF(filePath: string): Promise<ParsedDocument> {
  try {
    const buffer = await Bun.file(filePath).arrayBuffer()

    // 15 秒超时，同时覆盖 getDocumentProxy 和 extractText，防止任一步骤 hang
    const TIMEOUT_MS = 15000
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`PDF parsing timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
    )
    const parsePromise = (async () => {
      // 不使用 standardFontDataUrl，避免版本不匹配导致字体加载 hang
      // verbosity: 0 抑制终端字体警告
      const pdf = await getDocumentProxy(new Uint8Array(buffer), {
        useSystemFonts: true,
        disableFontFace: true,
        fontExtraProperties: false,
        verbosity: 0,
      })
      return extractText(pdf, { mergePages: false })
    })()
    const { totalPages, text } = await Promise.race([parsePromise, timeoutPromise])

    // unpdf 返回的 text 是数组形式（每页一个）
    const pages: { pageNumber: number; text: string }[] = []
    let fullText = ""

    if (Array.isArray(text)) {
      for (let i = 0; i < text.length; i++) {
        const pageText = text[i] || ""
        pages.push({ pageNumber: i + 1, text: pageText })
        fullText += pageText + "\n"
      }
    } else {
      // 单页情况
      pages.push({ pageNumber: 1, text: String(text) })
      fullText = String(text)
    }

    return {
      text: fullText,
      pages,
      pageCount: totalPages,
    }
  } catch (e: any) {
    throw new Error(`Failed to parse PDF ${filePath}: ${e?.message || e}`)
  }
}

export async function parseText(filePath: string): Promise<ParsedDocument> {
  try {
    const text = await Bun.file(filePath).text()
    const body = text.trim()
    return {
      text,
      pages: [{ pageNumber: 1, text }],
      pageCount: body ? 1 : 0,
    }
  } catch (e: any) {
    throw new Error(`Failed to parse text document ${filePath}: ${e?.message || e}`)
  }
}

// 文本分块
export function chunkText(
  text: string,
  options: {
    chunkSize: number
    chunkOverlap: number
  },
): Chunk[] {
  const { chunkSize, chunkOverlap } = options
  const chunks: Chunk[] = []

  // 按段落分割
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

  let currentChunk = ""
  let currentLength = 0

  for (const para of paragraphs) {
    const paraText = para.trim()
    const paraLength = paraText.length

    // 如果当前段落超过了 chunk 大小，需要进一步分割
    if (paraLength > chunkSize) {
      // 先保存当前 chunk
      if (currentChunk.trim()) {
        chunks.push({ content: currentChunk.trim() })
        currentChunk = ""
        currentLength = 0
      }

      // 按句子分割大段落
      const sentences = paraText.match(/[^.!?]+[.!?]+/g) || [paraText]
      let sentenceChunk = ""

      for (const sentence of sentences) {
        if (sentenceChunk.length + sentence.length > chunkSize) {
          if (sentenceChunk.trim()) {
            chunks.push({ content: sentenceChunk.trim() })
          }
          // 添加重叠
          const overlapStart = Math.max(0, sentenceChunk.length - chunkOverlap)
          sentenceChunk = sentenceChunk.slice(overlapStart) + sentence
        } else {
          sentenceChunk += sentence
        }
      }

      if (sentenceChunk.trim()) {
        currentChunk = sentenceChunk
        currentLength = sentenceChunk.length
      }
    } else if (currentLength + paraLength + 2 > chunkSize) {
      // 当前 chunk 满了，保存并开始新的
      if (currentChunk.trim()) {
        chunks.push({ content: currentChunk.trim() })
      }

      // 添加重叠部分
      const overlapStart = Math.max(0, currentChunk.length - chunkOverlap)
      currentChunk = currentChunk.slice(overlapStart) + "\n\n" + paraText
      currentLength = currentChunk.length
    } else {
      // 添加到当前 chunk
      if (currentChunk) {
        currentChunk += "\n\n" + paraText
      } else {
        currentChunk = paraText
      }
      currentLength = currentChunk.length
    }
  }

  // 保存最后一个 chunk
  if (currentChunk.trim()) {
    chunks.push({ content: currentChunk.trim() })
  }

  return chunks
}

// 处理文档并创建 chunks
export async function processDocument(
  filePath: string,
  options: {
    chunkSize: number
    chunkOverlap: number
    documentId: string
  },
): Promise<{ chunks: ChunkMeta[]; pageCount: number }> {
  const { chunkSize, chunkOverlap, documentId } = options

  const parsed = filePath.toLowerCase().endsWith(".pdf") ? await parsePDF(filePath) : await parseText(filePath)

  // 分块
  const rawChunks = chunkText(parsed.text, { chunkSize, chunkOverlap })

  // 创建 ChunkMeta
  const chunks: ChunkMeta[] = rawChunks.map((chunk, index) => ({
    id: Storage.genChunkId(),
    documentId,
    index,
    content: chunk.content,
    pageNumber: chunk.pageNumber,
    embeddingOffset: 0, // 将在嵌入后更新
    embeddingLength: 0, // 将在嵌入后更新
  }))

  return {
    chunks,
    pageCount: parsed.pageCount,
  }
}

// 提取 chunk 内容用于嵌入
export function extractChunkContents(chunks: ChunkMeta[]): string[] {
  return chunks.map((chunk) => chunk.content)
}
