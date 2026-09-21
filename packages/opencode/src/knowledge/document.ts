import type { ChunkMeta } from "./types"
import { Storage } from "./storage"
import { extractText, getDocumentProxy } from "unpdf"
import path from "path"
import { existsSync } from "fs"

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

// CID 字体（中日韩 PDF 常见）需要 Adobe CMap 表才能映射回 Unicode，缺失时
// pdf.js 会静默丢弃汉字。cmaps 已随 web 资源分发，这里按编译产物 / 源码树
// 两种布局定位；都找不到时返回 undefined，退化为原有行为。
let cmaps: string | undefined

function cMapUrl() {
  if (cmaps !== undefined) return cmaps || undefined
  const candidates = [
    path.join(path.dirname(process.execPath), "web", "pdfjs-ref", "web", "cmaps"),
    Bun.fileURLToPath(new URL("../../../app/public/pdfjs-ref/web/cmaps", import.meta.url)),
  ]
  const found = candidates.find((item) => existsSync(item))
  // pdf.js 要求 cMapUrl 以 "/" 结尾并按 baseUrl + name 拼接后交给 fs.readFile，
  // Windows 下 readFile 接受正斜杠，但 path.sep 会被其 URL 校验拒绝。
  cmaps = found ? `${found.replaceAll("\\", "/")}/` : ""
  return cmaps || undefined
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
        cMapUrl: cMapUrl(),
        cMapPacked: true,
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

// CJK 与全角标点同样作为句子边界；lookbehind 切分保证不丢尾部文本
const SENTENCE = /(?<=[。！？；．.!?;])/
const LINE = /(?<=\n)/

function sentences(para: string) {
  const parts = para.split(SENTENCE).filter((item) => item.length > 0)
  if (parts.length > 1) return parts
  // PDF 提取的正文常无空行也无句末标点，退化为按行切分
  return para.split(LINE).filter((item) => item.length > 0)
}

// 文本分块
export function chunkText(
  text: string,
  options: {
    chunkSize: number
    chunkOverlap: number
  },
): Chunk[] {
  const size = Math.max(1, options.chunkSize)
  const overlap = Math.min(Math.max(0, options.chunkOverlap), size - 1)
  const chunks: Chunk[] = []

  const paras = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
  const units = paras.length > 0 ? paras : [text]

  let cur = ""

  for (const para of units) {
    if (cur.trim()) cur += "\n\n"

    for (let part of sentences(para.trim())) {
      // 无句末标点的超长单元必须硬切，否则 chunkSize 会被静默突破
      while (part.length > size) {
        if (cur.trim()) chunks.push({ content: cur.trim() })
        const head = part.slice(0, size).trim()
        if (head) chunks.push({ content: head })
        part = part.slice(size - overlap)
        cur = ""
      }

      if (cur.length + part.length > size) {
        if (cur.trim()) chunks.push({ content: cur.trim() })
        const tail = cur.slice(Math.max(0, cur.length - overlap))
        cur = tail.length + part.length > size ? part : tail + part
        continue
      }
      cur += part
    }
  }

  if (cur.trim()) chunks.push({ content: cur.trim() })

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
