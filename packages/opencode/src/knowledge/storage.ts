import path from "path"
import { mkdir, rm, readdir, stat } from "fs/promises"
import { existsSync } from "fs"
import { Filesystem } from "../util/filesystem"
import { Identifier } from "../id/id"
import type { KnowledgeIndex, KnowledgeBaseConfig } from "./types"
import { KB, LEGACY_KB } from "@/persist/naming"

const INDEX_FILE = "index.json"
const EMBEDDING_FILE = "embedding.bin"
const DOC_EXT = new Set([".pdf", ".md", ".markdown", ".txt", ".tex", ".rst", ".json", ".yml", ".yaml", ".csv"])

export namespace Storage {
  function next(dir: string) {
    return path.join(dir, KB)
  }

  function prev(dir: string) {
    return path.join(dir, LEGACY_KB)
  }

  // 获取知识库元数据文件夹路径
  export function kbPath(dir: string): string {
    return next(dir)
  }

  // 获取索引文件路径
  export function indexPath(dir: string): string {
    return path.join(kbPath(dir), INDEX_FILE)
  }

  // 获取嵌入向量文件路径
  export function embeddingPath(dir: string): string {
    return path.join(kbPath(dir), EMBEDDING_FILE)
  }

  // 检查是否是知识库
  export async function isKnowledgeBase(dir: string): Promise<boolean> {
    if (await Filesystem.exists(indexPath(dir))) return true
    return Filesystem.exists(path.join(prev(dir), INDEX_FILE))
  }

  // 初始化知识库
  export async function init(
    dir: string,
    config: Omit<KnowledgeBaseConfig, "path" | "createdAt" | "updatedAt">,
  ): Promise<KnowledgeIndex> {
    const kbDir = kbPath(dir)
    const now = Date.now()

    const fullConfig: KnowledgeBaseConfig = {
      ...config,
      path: dir,
      createdAt: now,
      updatedAt: now,
    }

    const index: KnowledgeIndex = {
      version: 1,
      config: fullConfig,
      documents: [],
      stats: {
        totalDocuments: 0,
        totalChunks: 0,
      },
    }

    // 创建 .aether-kb 目录
    if (!existsSync(kbDir)) {
      await mkdir(kbDir, { recursive: true })
    }

    // 写入索引文件
    await Filesystem.writeJson(indexPath(dir), index)

    // 创建空的嵌入向量文件
    await Bun.write(embeddingPath(dir), new Uint8Array(0))

    return index
  }

  // 加载索引
  export async function loadIndex(dir: string): Promise<KnowledgeIndex | null> {
    const idx = indexPath(dir)
    if (await Filesystem.exists(idx)) return Filesystem.readJson<KnowledgeIndex>(idx)
    const legacy = path.join(prev(dir), INDEX_FILE)
    if (!(await Filesystem.exists(legacy))) return null
    return Filesystem.readJson<KnowledgeIndex>(legacy)
  }

  // 保存索引
  export async function saveIndex(dir: string, index: KnowledgeIndex): Promise<void> {
    index.config.updatedAt = Date.now()
    await Filesystem.writeJson(indexPath(dir), index)
  }

  // 追加嵌入向量
  export async function appendEmbeddings(dir: string, embeddings: Float32Array[]): Promise<number> {
    const embPath = embeddingPath(dir)
    const file = Bun.file(embPath)
    const existingSize = (await file.exists()) ? file.size : 0
    const offset = existingSize / 4 // Float32 的偏移量

    // 合并所有向量
    const totalLength = embeddings.reduce((sum, e) => sum + e.length, 0)
    const buffer = new Float32Array(totalLength)
    let pos = 0
    for (const emb of embeddings) {
      buffer.set(emb, pos)
      pos += emb.length
    }

    // 读取现有内容并追加
    const existing = (await file.exists()) ? await file.arrayBuffer() : new ArrayBuffer(0)
    const newBuffer = new Uint8Array(existing.byteLength + buffer.byteLength)
    newBuffer.set(new Uint8Array(existing), 0)
    newBuffer.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), existing.byteLength)

    await Bun.write(embPath, newBuffer)

    return offset
  }

  // 读取所有嵌入向量
  export async function readAllEmbeddings(dir: string): Promise<Float32Array | null> {
    const embPath = embeddingPath(dir)
    const file = Bun.file(embPath)
    if (!(await file.exists()) || file.size === 0) {
      const legacy = Bun.file(path.join(prev(dir), EMBEDDING_FILE))
      if (!(await legacy.exists()) || legacy.size === 0) return null
      return new Float32Array(await legacy.arrayBuffer())
    }
    const buffer = await file.arrayBuffer()
    return new Float32Array(buffer)
  }

  // 清空嵌入向量文件
  export async function clearEmbeddings(dir: string): Promise<void> {
    await Bun.write(embeddingPath(dir), new Uint8Array(0))
  }

  // 读取指定范围的嵌入向量
  export async function readEmbeddings(
    dir: string,
    offset: number,
    count: number,
    dimensions: number,
  ): Promise<Float32Array[]> {
    const all = await readAllEmbeddings(dir)
    if (!all) return []

    const result: Float32Array[] = []
    for (let i = 0; i < count; i++) {
      const start = offset + i * dimensions
      const end = start + dimensions
      if (end <= all.length) {
        result.push(all.slice(start, end))
      }
    }
    return result
  }

  // 删除文档的嵌入向量（需要重建整个文件）
  export async function removeDocumentEmbeddings(
    dir: string,
    index: KnowledgeIndex,
    documentId: string,
  ): Promise<void> {
    const doc = index.documents.find((d) => d.meta.id === documentId)
    if (!doc || doc.chunks.length === 0) return

    const dimensions = index.config.embeddingDimensions
    const all = await readAllEmbeddings(dir)
    if (!all) return

    // 重建向量文件
    const newEmbeddings: Float32Array[] = []
    const offsetMap = new Map<number, number>()

    // 按偏移量排序
    const sortedChunks = index.documents
      .filter((d) => d.meta.id !== documentId)
      .flatMap((d) => d.chunks)
      .sort((a, b) => a.embeddingOffset - b.embeddingOffset)

    for (const chunk of sortedChunks) {
      const start = chunk.embeddingOffset
      const end = start + dimensions
      if (end <= all.length) {
        offsetMap.set(chunk.embeddingOffset, newEmbeddings.length * dimensions)
        newEmbeddings.push(all.slice(start, end))
      }
    }

    // 写入新文件
    const embPath = embeddingPath(dir)
    if (newEmbeddings.length === 0) {
      await Bun.write(embPath, new Uint8Array(0))
    } else {
      const totalLength = newEmbeddings.reduce((sum, e) => sum + e.length, 0)
      const buffer = new Float32Array(totalLength)
      let pos = 0
      for (const emb of newEmbeddings) {
        buffer.set(emb, pos)
        pos += emb.length
      }
      const uint8Buffer = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      await Bun.write(embPath, uint8Buffer)
    }

    // 更新索引中的偏移量
    for (const d of index.documents) {
      if (d.meta.id !== documentId) {
        for (const chunk of d.chunks) {
          const newOffset = offsetMap.get(chunk.embeddingOffset)
          if (newOffset !== undefined) {
            chunk.embeddingOffset = newOffset
          }
        }
      }
    }
  }

  // 列出文件夹中的可索引文档（递归扫描子目录）
  export async function listDocumentFiles(dir: string): Promise<string[]> {
    const files: string[] = []

    async function scan(currentDir: string) {
      const entries = await readdir(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === KB || entry.name === LEGACY_KB) continue
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          await scan(fullPath)
        } else if (entry.isFile() && DOC_EXT.has(path.extname(entry.name).toLowerCase())) {
          files.push(fullPath)
        }
      }
    }

    await scan(dir)
    return files
  }

  // 兼容旧命名
  export async function listPdfFiles(dir: string): Promise<string[]> {
    return listDocumentFiles(dir)
  }

  // 获取文件信息
  export async function getFileInfo(filePath: string): Promise<{ size: number; name: string }> {
    const s = await stat(filePath)
    return {
      size: s.size,
      name: path.basename(filePath),
    }
  }

  // 删除知识库（仅删除 .aether-kb 目录）
  export async function deleteKnowledgeBase(dir: string): Promise<void> {
    const kbDir = kbPath(dir)
    if (existsSync(kbDir)) {
      await rm(kbDir, { recursive: true })
    }
  }

  // 生成唯一 ID
  const KB_PREFIX = "kb"
  const DOC_PREFIX = "doc"
  const CHUNK_PREFIX = "chunk"

  export function genKBId(): string {
    return Identifier.create(KB_PREFIX as any, false)
  }

  export function genDocId(): string {
    return Identifier.create(DOC_PREFIX as any, false)
  }

  export function genChunkId(): string {
    return Identifier.create(CHUNK_PREFIX as any, false)
  }
}
