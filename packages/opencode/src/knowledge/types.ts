import z from "zod"

// 嵌入模型提供商类型
export const EmbeddingProviderSchema = z.enum(["openai", "local", "custom"])
export type EmbeddingProvider = z.infer<typeof EmbeddingProviderSchema>

// 知识库配置
export const KnowledgeBaseConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  embeddingProvider: EmbeddingProviderSchema,
  embeddingModel: z.string(),
  embeddingDimensions: z.number(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  chunkSize: z.number().default(512),
  chunkOverlap: z.number().default(50),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type KnowledgeBaseConfig = z.infer<typeof KnowledgeBaseConfigSchema>

// 文档状态
export const DocumentStatusSchema = z.enum(["pending", "processing", "ready", "error"])
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>

// 文档元数据
export const DocumentMetaSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  pageCount: z.number().optional(),
  status: DocumentStatusSchema,
  errorMessage: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>

// Chunk 元数据
export const ChunkMetaSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  index: z.number(),
  content: z.string(),
  pageNumber: z.number().optional(),
  embeddingOffset: z.number(),
  embeddingLength: z.number(),
})
export type ChunkMeta = z.infer<typeof ChunkMetaSchema>

// 索引文件结构
export const KnowledgeIndexSchema = z.object({
  version: z.literal(1),
  config: KnowledgeBaseConfigSchema,
  documents: z.array(
    z.object({
      meta: DocumentMetaSchema,
      chunks: z.array(ChunkMetaSchema),
    }),
  ),
  stats: z.object({
    totalDocuments: z.number(),
    totalChunks: z.number(),
    lastSyncedAt: z.number().optional(),
  }),
})
export type KnowledgeIndex = z.infer<typeof KnowledgeIndexSchema>

// 嵌入模型信息
export const EmbeddingModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: EmbeddingProviderSchema,
  dimensions: z.number(),
  description: z.string().optional(),
})
export type EmbeddingModelInfo = z.infer<typeof EmbeddingModelInfoSchema>

// 检索结果
export const SearchResultSchema = z.object({
  chunk: ChunkMetaSchema,
  document: DocumentMetaSchema,
  score: z.number(),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

// 同步结果
export const SyncResultSchema = z.object({
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
  errors: z.array(z.string()).optional(),
})
export type SyncResult = z.infer<typeof SyncResultSchema>