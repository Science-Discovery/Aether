import type { KnowledgeIndex, SearchResult, ChunkMeta, DocumentMeta } from "./types"
import { Storage } from "./storage"
import { createEmbedder, type Embedder } from "./embedding"

// 余弦相似度计算
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same length")
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

// 检索器
export class Retriever {
  private index: KnowledgeIndex
  private dir: string
  private embedder: Embedder
  private embeddings: Float32Array | null = null

  constructor(opts: { index: KnowledgeIndex; dir: string; embedder: Embedder }) {
    this.index = opts.index
    this.dir = opts.dir
    this.embedder = opts.embedder
  }

  // 加载嵌入向量
  async loadEmbeddings(): Promise<void> {
    if (this.embeddings) return
    this.embeddings = await Storage.readAllEmbeddings(this.dir)
  }

  // 检索相关 chunks
  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    await this.loadEmbeddings()

    if (!this.embeddings || this.embeddings.length === 0) {
      return []
    }

    // 将查询向量化
    const queryEmbeddings = await this.embedder.embed([query])
    const queryVector = queryEmbeddings[0]

    const dimensions = this.index.config.embeddingDimensions
    const scores: { chunk: ChunkMeta; document: DocumentMeta; score: number }[] = []

    // 遍历所有 chunks 计算相似度
    for (const doc of this.index.documents) {
      for (const chunk of doc.chunks) {
        const start = chunk.embeddingOffset
        const end = start + dimensions

        if (end <= this.embeddings!.length) {
          const chunkVector = this.embeddings!.slice(start, end)
          const score = cosineSimilarity(queryVector, chunkVector)

          scores.push({
            chunk,
            document: doc.meta,
            score,
          })
        }
      }
    }

    // 按分数排序并返回 topK
    scores.sort((a, b) => b.score - a.score)
    return scores.slice(0, topK)
  }

  // 批量检索（多个查询）
  async batchSearch(queries: string[], topK: number = 5): Promise<Map<string, SearchResult[]>> {
    const results = new Map<string, SearchResult[]>()

    for (const query of queries) {
      const searchResults = await this.search(query, topK)
      results.set(query, searchResults)
    }

    return results
  }

  // 获取指定文档的所有 chunks
  getDocumentChunks(documentId: string): { chunk: ChunkMeta; document: DocumentMeta }[] {
    const doc = this.index.documents.find((d) => d.meta.id === documentId)
    if (!doc) return []

    return doc.chunks.map((chunk) => ({
      chunk,
      document: doc.meta,
    }))
  }
}

// 创建检索器
export function createRetriever(
  index: KnowledgeIndex,
  dir: string,
  embedder: Embedder,
): Retriever {
  return new Retriever({ index, dir, embedder })
}

// 快速检索函数（不创建 Retriever 实例）
export async function quickSearch(
  query: string,
  index: KnowledgeIndex,
  dir: string,
  embedder: Embedder,
  topK: number = 5,
): Promise<SearchResult[]> {
  const retriever = createRetriever(index, dir, embedder)
  return retriever.search(query, topK)
}