import path from "path"
import { Storage } from "./storage"
import { createEmbedder, listEmbeddingModels, getEmbeddingModel } from "./embedding"
import { processDocument, extractChunkContents } from "./document"
import { quickSearch } from "./search"
import { Log } from "../util/log"

const log = Log.create({ service: "knowledge" })
import type { KnowledgeIndex, DocumentMeta, SearchResult, SyncResult, EmbeddingProvider } from "./types"

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

    // 获取文件夹中的可索引文档
    log.info("Listing document files...", { dir })
    const files = await Storage.listDocumentFiles(dir)
    log.info("Found document files", { count: files.length, files })

    const existingFiles = new Map<string, (typeof index.documents)[0]>()

    for (const doc of index.documents) {
      existingFiles.set(doc.meta.filePath, doc)
    }

    // 处理新增和修改的文件
    const dimensions = index.config.embeddingDimensions

    // 本地模型不支持并发，API provider 最多 100 并发
    const CONCURRENCY = index.config.embeddingProvider === "local" ? 1 : 100

    // 先跳过已存在文件，收集待处理列表
    let processed = 0
    const filesToProcess: string[] = []
    for (const filePath of files) {
      if (existingFiles.has(filePath)) {
        log.info("Skipping existing file", { file: filePath })
        processed++
        await opts?.onProgress?.({ phase: "processing", current: processed, total: files.length })
      } else {
        filesToProcess.push(filePath)
      }
    }

    // 分批并发处理
    for (let batchStart = 0; batchStart < filesToProcess.length; batchStart += CONCURRENCY) {
      if (opts?.signal?.aborted) {
        log.info("Sync aborted by signal", { processed, total: files.length })
        break
      }

      const batch = filesToProcess.slice(batchStart, batchStart + CONCURRENCY)
      log.info("Processing batch", { batchStart, batchSize: batch.length, concurrency: CONCURRENCY })

      // 并发解析文档 + 生成嵌入向量
      const batchResults = await Promise.allSettled(
        batch.map(async (filePath) => {
          log.info("Parsing document...", { file: filePath })
          const fileInfo = await Storage.getFileInfo(filePath)
          const docId = Storage.genDocId()
          const { chunks, pageCount } = await processDocument(filePath, {
            chunkSize: index.config.chunkSize,
            chunkOverlap: index.config.chunkOverlap,
            documentId: docId,
          })
          log.info("Document parsed", { file: filePath, chunks: chunks.length, pages: pageCount })

          if (chunks.length === 0) {
            return { type: "empty" as const, filePath }
          }

          log.info("Generating embeddings...", { file: filePath, chunks: chunks.length })
          const contents = extractChunkContents(chunks)
          const embeddings = await embedder.embed(contents)
          log.info("Embeddings generated", { file: filePath, count: embeddings.length })

          return { type: "success" as const, filePath, fileInfo, docId, chunks, pageCount, embeddings }
        }),
      )

      // 顺序写入（保证嵌入文件偏移量正确）
      for (let j = 0; j < batchResults.length; j++) {
        const res = batchResults[j]

        if (res.status === "rejected") {
          result.errors?.push(`Failed to process ${batch[j]}: ${res.reason?.message || res.reason}`)
        } else if (res.value.type === "empty") {
          result.errors?.push(
            `No text extracted from ${path.basename(res.value.filePath)}: document may be image-only or use unsupported encoding`,
          )
        } else {
          const { filePath, fileInfo, docId, chunks, pageCount, embeddings } = res.value

          // 写入嵌入向量并获取偏移量
          const offset = await Storage.appendEmbeddings(dir, embeddings)
          for (let k = 0; k < chunks.length; k++) {
            chunks[k].embeddingOffset = offset + k * dimensions
            chunks[k].embeddingLength = dimensions
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

          // 更新索引并保存
          index.documents.push({ meta: docMeta, chunks })
          index.stats.totalDocuments = index.documents.length
          index.stats.totalChunks = index.documents.reduce((sum, doc) => sum + doc.chunks.length, 0)
          await Storage.saveIndex(dir, index)

          result.added++
        }

        processed++
        await opts?.onProgress?.({ phase: "processing", current: processed, total: files.length })
      }
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
    // 获取文件夹中实际可索引文档数量
    const docs = await Storage.listDocumentFiles(index.config.path)

    return {
      totalDocuments: index.stats.totalDocuments,
      totalChunks: index.stats.totalChunks,
      pdfFileCount: docs.length,
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

  // 更新知识库配置（模型变更时重建索引）
  export async function updateConfig(
    dir: string,
    index: KnowledgeIndex,
    opts: {
      embeddingProvider: EmbeddingProvider
      embeddingModel: string
      embeddingDimensions: number
      apiKey?: string
      baseURL?: string
    },
  ): Promise<KnowledgeIndex> {
    const rebuild =
      index.config.embeddingProvider !== opts.embeddingProvider ||
      index.config.embeddingModel !== opts.embeddingModel ||
      index.config.embeddingDimensions !== opts.embeddingDimensions

    index.config.embeddingProvider = opts.embeddingProvider
    index.config.embeddingModel = opts.embeddingModel
    index.config.embeddingDimensions = opts.embeddingDimensions
    index.config.apiKey = opts.apiKey
    index.config.baseURL = opts.baseURL

    if (rebuild) {
      index.documents = []
      index.stats.totalDocuments = 0
      index.stats.totalChunks = 0
      index.stats.lastSyncedAt = undefined
      await Storage.clearEmbeddings(dir)
    }

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
