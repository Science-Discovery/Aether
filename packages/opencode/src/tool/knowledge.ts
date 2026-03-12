import z from "zod"
import { Tool } from "./tool"
import { Knowledge } from "../knowledge"
import { Storage } from "../knowledge/storage"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import path from "path"

const DESCRIPTION = `Search the knowledge base for relevant information.

This tool searches through indexed documents (PDFs, papers, etc.) that have been synced to the knowledge base. Use this when the user asks questions about topics that might be in their uploaded documents or papers.

The knowledge base uses semantic search with embeddings, so you can search by meaning, not just exact keywords.

Parameters:
- query: The search query describing what information you're looking for
- topK: Number of results to return (default: 10, max: 20)

Returns relevant document chunks with their source filenames and similarity scores.

IMPORTANT: When answering based on search results, you MUST:
1. Read and consider ALL returned results, not just the top few
2. Cite ALL source documents that contributed to your answer
3. Use this exact format for citations: [filename.pdf](file:///full/path/to/file.pdf)
4. Include a "Sources:" section at the end listing ALL referenced documents

Do not ignore any relevant results - synthesize information from all returned chunks.`

// 全局知识库配置存储
let globalKnowledgeConfig: {
  path: string
  apiKey?: string
  baseURL?: string
} | null = null

export function setKnowledgeConfig(config: { path: string; apiKey?: string; baseURL?: string } | null) {
  globalKnowledgeConfig = config
}

export function getKnowledgeConfig() {
  return globalKnowledgeConfig
}

// 在 Instance 目录中查找知识库
async function findKnowledgeBase(): Promise<string | null> {
  // 优先使用全局配置
  if (globalKnowledgeConfig?.path) {
    const kbPath = Storage.kbPath(globalKnowledgeConfig.path)
    if (await Filesystem.exists(kbPath)) {
      return globalKnowledgeConfig.path
    }
  }

  // 在当前工作目录查找
  const cwd = Instance.directory
  const cwdKbPath = Storage.kbPath(cwd)
  if (await Filesystem.exists(cwdKbPath)) {
    return cwd
  }

  // 在父目录中查找（最多向上 3 层）
  let dir = cwd
  for (let i = 0; i < 3; i++) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    const kbPath = Storage.kbPath(dir)
    if (await Filesystem.exists(kbPath)) {
      return dir
    }
  }

  return null
}

interface KnowledgeMetadata {
  configured: boolean
  exists?: boolean
  documents?: number
  chunks?: number
  results?: number
  sources?: string[]
}

export const KnowledgeTool = Tool.define("knowledge_search", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("The search query to find relevant information in the knowledge base"),
    topK: z.coerce.number().describe("Number of results to return (default: 10)").optional().default(10),
  }),
  async execute(params, ctx) {
    // 查找知识库
    const kbPath = await findKnowledgeBase()
    
    if (!kbPath) {
      return {
        title: "Knowledge base not configured",
        output: `Knowledge base is not configured or not found.

To use the knowledge base:
1. Open the Knowledge Base dialog in the UI
2. Select a folder containing your PDF documents
3. Configure the embedding provider (OpenAI, Local, or Custom)
4. Click Sync to index your documents

Once synced, you can search the knowledge base using this tool.`,
        metadata: {
          configured: false,
        } as KnowledgeMetadata,
      }
    }

    // 加载知识库索引
    const index = await Knowledge.load(kbPath)
    if (!index) {
      return {
        title: "Knowledge base not found",
        output: `Knowledge base index not found at ${kbPath}. Please sync documents first.`,
        metadata: {
          configured: true,
          exists: false,
        } as KnowledgeMetadata,
      }
    }

    // 检查是否有文档
    if (index.stats.totalDocuments === 0 || index.stats.totalChunks === 0) {
      return {
        title: "Knowledge base empty",
        output: `Knowledge base at "${kbPath}" is empty. No documents have been synced yet.

Please run sync to index your documents:
1. Open the Knowledge Base dialog
2. Click the Sync button to index your PDFs`,
        metadata: {
          configured: true,
          exists: true,
          documents: 0,
          chunks: 0,
        } as KnowledgeMetadata,
      }
    }

    // 执行搜索 - 优先使用 index.config 中保存的 apiKey/baseURL
    const topK = Math.min(params.topK || 10, 20)
    const results = await Knowledge.search(kbPath, index, params.query, {
      apiKey: index.config.apiKey || globalKnowledgeConfig?.apiKey,
      baseURL: index.config.baseURL || globalKnowledgeConfig?.baseURL,
      topK,
    })

    if (results.length === 0) {
      return {
        title: "No results found",
        output: `No relevant information found for query: "${params.query}"

The knowledge base contains ${index.stats.totalDocuments} documents with ${index.stats.totalChunks} chunks, but none matched your query.

Try:
- Using different keywords
- Making your query more general
- Checking if the topic exists in your synced documents`,
        metadata: {
          configured: true,
          exists: true,
          documents: index.stats.totalDocuments,
          chunks: index.stats.totalChunks,
          results: 0,
        } as KnowledgeMetadata,
      }
    }

    // 格式化输出
    const outputParts: string[] = [
      `<knowledge_search query="${params.query}" results="${results.length}">`,
      "",
    ]

    // 收集所有来源文件（用于生成来源链接）
    const sourceFiles = new Map<string, string>() // fileName -> filePath

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const filePath = result.document.filePath
      const fileName = result.document.fileName
      
      // 记录来源文件
      if (!sourceFiles.has(fileName)) {
        sourceFiles.set(fileName, filePath)
      }
      
      // 生成 file:// URL
      const fileUrl = `file://${filePath}`
      
      outputParts.push(`<result index="${i + 1}" score="${result.score.toFixed(4)}">`)
      outputParts.push(`  <source link="${fileUrl}">${fileName}</source>`)
      if (result.chunk.pageNumber) {
        outputParts.push(`  <page>${result.chunk.pageNumber}</page>`)
      }
      outputParts.push(`  <content>`)
      outputParts.push(`    ${result.chunk.content.trim()}`)
      outputParts.push(`  </content>`)
      outputParts.push(`</result>`)
      outputParts.push("")
    }

    outputParts.push(`</knowledge_search>`)
    outputParts.push("")
    
    // 生成来源链接列表（Markdown 格式，可点击）
    outputParts.push(`<sources>`)
    outputParts.push(`Referenced documents (click to open):`)
    for (const [fileName, filePath] of sourceFiles) {
      outputParts.push(`- [${fileName}](file://${filePath})`)
    }
    outputParts.push(`</sources>`)
    outputParts.push("")
    
    outputParts.push(`<summary>`)
    outputParts.push(`Found ${results.length} relevant chunks from ${sourceFiles.size} documents.`)
    outputParts.push(`Knowledge base: ${kbPath}`)
    outputParts.push(`Total: ${index.stats.totalDocuments} documents, ${index.stats.totalChunks} chunks.`)
    outputParts.push(`</summary>`)

    return {
      title: `Found ${results.length} results`,
      output: outputParts.join("\n"),
      metadata: {
        configured: true,
        exists: true,
        documents: index.stats.totalDocuments,
        chunks: index.stats.totalChunks,
        results: results.length,
        sources: [...new Set(results.map(r => r.document.fileName))],
      } as KnowledgeMetadata,
    }
  },
})