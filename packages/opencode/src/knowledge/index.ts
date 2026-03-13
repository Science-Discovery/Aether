import path from "path"
import { Storage } from "./storage"
import { createEmbedder, listEmbeddingModels, getEmbeddingModel } from "./embedding"
import { processDocument, extractChunkContents } from "./document"
import { quickSearch } from "./search"
import { Log } from "../util/log"

const log = Log.create({ service: "knowledge" })
import type {
  KnowledgeIndex,
  DocumentMeta,
  SearchResult,
  SyncResult,
  EmbeddingProvider,
} from "./types"

export namespace Knowledge {
  // 创建新知识库
  export async function create(opts: {
    path: string
    name: string
    embeddingProvider: EmbeddingProvider
    embeddingModel: string
    embeddingDimensions: number
    apiKey?: string
    baseURL?: string
    chunkSize?: number
    chunkOverlap?: number
  }): Promise<KnowledgeIndex> {
    // 检查路径是否存在
    const dirExists = await Storage.isKnowledgeBase(opts.path)
    if (dirExists) {
      throw new Error(`Knowledge base already exists at ${opts.path}`)
    }

    // 初始化知识库
    const index = await Storage.init(opts.path, {
      id: Storage.genKBId(),
      name: opts.name,
      embeddingProvider: opts.embeddingProvider,
      embeddingModel: opts.embeddingModel,
      embeddingDimensions: opts.embeddingDimensions,
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      chunkSize: opts.chunkSize ?? 512,
      chunkOverlap: opts.chunkOverlap ?? 50,
    })

    return index
  }

  // 加载知识库
  export async function load(dir: string): Promise<KnowledgeIndex | null> {
    return Storage.loadIndex(dir)
  }

  // 删除知识库
  export async function remove(dir: string): Promise<void> {
    await Storage.deleteKnowledgeBase(dir)
  }

  // 同步文件夹（检测新增/修改/删除的文件）
  export async function sync(
    dir: string,
    index: KnowledgeIndex,
    opts?: {
      apiKey?: string
      baseURL?: string
      signal?: AbortSignal
      onProgress?: (status: { phase: string; current: number; total: number }) => void | Promise<void>
    },
  ): Promise<SyncResult> {
    const result: SyncResult = { added: 0, updated: 0, removed: 0, errors: [] }

    log.info("Starting sync", { dir, provider: index.config.embeddingProvider, model: index.config.embeddingModel })

    // 创建嵌入器
    log.info("Creating embedder...")
    const embedder = createEmbedder({
      provider: index.config.embeddingProvider,
      model: index.config.embeddingModel,
      dimensions: index.config.embeddingDimensions,
      apiKey: opts?.apiKey,
      baseURL: opts?.baseURL,
    })
    log.info("Embedder created")

    // 获取文件夹中的 PDF 文件
    log.info("Listing PDF files...", { dir })
    const pdfFiles = await Storage.listPdfFiles(dir)
    log.info("Found PDF files", { count: pdfFiles.length, files: pdfFiles })

    const existingFiles = new Map<string, typeof index.documents[0]>()

    for (const doc of index.documents) {
      existingFiles.set(doc.meta.filePath, doc)
    }

    // 处理新增和修改的文件
    const dimensions = index.config.embeddingDimensions

    for (let i = 0; i < pdfFiles.length; i++) {
      if (opts?.signal?.aborted) {
        log.info("Sync aborted by signal", { processed: i, total: pdfFiles.length })
        break
      }

      const filePath = pdfFiles[i]

      log.info("Processing file", { index: i + 1, total: pdfFiles.length, file: filePath })

      const fileInfo = await Storage.getFileInfo(filePath)
      const existing = existingFiles.get(filePath)

      // 检查文件是否需要更新
      if (existing) {
        log.info("Skipping existing file", { file: filePath })
        await opts?.onProgress?.({ phase: "processing", current: i + 1, total: pdfFiles.length })
        continue
      }

      try {
        // 处理文档
        log.info("Parsing PDF...", { file: filePath })
        const docId = Storage.genDocId()
        const { chunks, pageCount } = await processDocument(filePath, {
          chunkSize: index.config.chunkSize,
          chunkOverlap: index.config.chunkOverlap,
          documentId: docId,
        })
        log.info("PDF parsed", { file: filePath, chunks: chunks.length, pages: pageCount })

        if (chunks.length === 0) {
          result.errors?.push(`No text extracted from ${path.basename(filePath)}: PDF may be scanned image or use unsupported encoding`)
          await opts?.onProgress?.({ phase: "processing", current: i + 1, total: pdfFiles.length })
          continue
        }

        // 生成嵌入向量
        log.info("Generating embeddings...", { file: filePath, chunks: chunks.length })
        const contents = extractChunkContents(chunks)
        const embeddings = await embedder.embed(contents)
        log.info("Embeddings generated", { file: filePath, count: embeddings.length })

        // 立即写入嵌入向量并更新偏移量
        const offset = await Storage.appendEmbeddings(dir, embeddings)
        for (let j = 0; j < chunks.length; j++) {
          chunks[j].embeddingOffset = offset + j * dimensions
          chunks[j].embeddingLength = dimensions
        }

        // 创建文档元数据
        const docMeta: DocumentMeta = {
          id: docId,
          filePath,
          fileName: fileInfo.name,
          fileSize: fileInfo.size,
          pageCount,
          status: "ready",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        // 立即更新索引并保存
        index.documents.push({ meta: docMeta, chunks })
        index.stats.totalDocuments = index.documents.length
        index.stats.totalChunks = index.documents.reduce((sum, doc) => sum + doc.chunks.length, 0)
        await Storage.saveIndex(dir, index)

        result.added++
      } catch (e: any) {
        result.errors?.push(`Failed to process ${filePath}: ${e?.message || e}`)
      }

      await opts?.onProgress?.({ phase: "processing", current: i + 1, total: pdfFiles.length })
    }

    // 更新最终同步时间
    index.stats.lastSyncedAt = Date.now()
    await Storage.saveIndex(dir, index)

    return result
  }

  // 检索
  export async function search(
    dir: string,
    index: KnowledgeIndex,
    query: string,
    opts?: {
      apiKey?: string
      baseURL?: string
      topK?: number
    },
  ): Promise<SearchResult[]> {
    const embedder = createEmbedder({
      provider: index.config.embeddingProvider,
      model: index.config.embeddingModel,
      dimensions: index.config.embeddingDimensions,
      apiKey: opts?.apiKey,
      baseURL: opts?.baseURL,
    })

    return quickSearch(query, index, dir, embedder, opts?.topK ?? 5)
  }

  // 构建 RAG 上下文
  export function buildRAGContext(results: SearchResult[], maxLength: number = 50000): string {
    if (results.length === 0) {
      return ""
    }

    const parts: string[] = []
    let totalLength = 0

    for (const result of results) {
      const header = `[文档: ${result.document.fileName}]`
      const content = result.chunk.content
      const part = `${header}\n${content}\n`

      if (totalLength + part.length > maxLength) {
        break
      }

      parts.push(part)
      totalLength += part.length
    }

    return parts.join("\n---\n\n")
  }

  // 列出可用嵌入模型
  export function listModels() {
    return listEmbeddingModels()
  }

  // 获取嵌入模型信息
  export function getModel(modelId: string) {
    return getEmbeddingModel(modelId)
  }

  // 获取知识库统计信息
  export async function getStats(index: KnowledgeIndex) {
    // 获取文件夹中实际 PDF 文件数量
    const pdfFiles = await Storage.listPdfFiles(index.config.path)
    
    return {
      totalDocuments: index.stats.totalDocuments,
      totalChunks: index.stats.totalChunks,
      pdfFileCount: pdfFiles.length,
      lastSyncedAt: index.stats.lastSyncedAt,
      embeddingModel: index.config.embeddingModel,
      embeddingProvider: index.config.embeddingProvider,
      chunkSize: index.config.chunkSize,
      chunkOverlap: index.config.chunkOverlap,
    }
  }

  // 删除文档
  export async function removeDocument(
    dir: string,
    index: KnowledgeIndex,
    documentId: string,
  ): Promise<KnowledgeIndex> {
    const docIndex = index.documents.findIndex((d) => d.meta.id === documentId)
    if (docIndex === -1) {
      throw new Error(`Document not found: ${documentId}`)
    }

    // 删除嵌入向量
    await Storage.removeDocumentEmbeddings(dir, index, documentId)

    // 从索引中删除文档
    index.documents.splice(docIndex, 1)

    // 更新统计
    index.stats.totalDocuments = index.documents.length
    index.stats.totalChunks = index.documents.reduce((sum, doc) => sum + doc.chunks.length, 0)

    // 保存索引
    await Storage.saveIndex(dir, index)

    return index
  }
}

// 导出类型和工具
export { Storage } from "./storage"
export { createEmbedder, listEmbeddingModels, getEmbeddingModel } from "./embedding"
export { parsePDF, chunkText, processDocument } from "./document"
export { createRetriever, quickSearch, cosineSimilarity } from "./search"
export * from "./types"