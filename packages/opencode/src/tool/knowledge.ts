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

// 全局知识库配置存储（支持多个知识库）
let globalKnowledgeConfig: {
  paths: string[]  // 多个知识库路径
  apiKey?: string
  baseURL?: string
} | null = null

export function setKnowledgeConfig(config: { path?: string; paths?: string[]; apiKey?: string; baseURL?: string } | null) {
  if (!config) {
    globalKnowledgeConfig = null
    return
  }
  // 支持单个 path 或多个 paths
  const paths = config.paths || (config.path ? [config.path] : [])
  globalKnowledgeConfig = {
    paths,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  }
}

export function getKnowledgeConfig() {
  return globalKnowledgeConfig
}

// 获取所有激活的知识库路径
async function getActiveKnowledgeBases(): Promise<string[]> {
  const result: string[] = []
  
  // 优先使用全局配置中的路径
  if (globalKnowledgeConfig?.paths?.length) {
    for (const kbPath of globalKnowledgeConfig.paths) {
      const metaPath = Storage.kbPath(kbPath)
      if (await Filesystem.exists(metaPath)) {
        result.push(kbPath)
      }
    }
    if (result.length > 0) {
      return result
    }
  }

  // 回退：在当前工作目录查找
  const cwd = Instance.directory
  const cwdKbPath = Storage.kbPath(cwd)
  if (await Filesystem.exists(cwdKbPath)) {
    result.push(cwd)
  }

  // 在父目录中查找（最多向上 3 层）
  let dir = cwd
  for (let i = 0; i < 3; i++) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    const kbPath = Storage.kbPath(dir)
    if (await Filesystem.exists(kbPath)) {
      result.push(dir)
    }
  }

  return result
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
    // 获取所有激活的知识库
    const kbPaths = await getActiveKnowledgeBases()
    
    if (kbPaths.length === 0) {
      return {
        title: "Knowledge base not configured",
        output: `Knowledge base is not configured or not found.

To use the knowledge base:
1. Open the Knowledge Base dialog in the UI
2. Select folders containing your PDF documents
3. Configure the embedding provider (OpenAI, Local, or Custom)
4. Click Sync to index your documents

Once synced, you can search the knowledge base using this tool.`,
        metadata: {
          configured: false,
        } as KnowledgeMetadata,
      }
    }

    // 加载所有知识库索引
    const indexes: Array<{ path: string; index: typeof Knowledge.load extends (...args: any) => Promise<infer T> ? T : never }> = []
    for (const kbPath of kbPaths) {
      const index = await Knowledge.load(kbPath)
      if (index && index.stats.totalDocuments > 0 && index.stats.totalChunks > 0) {
        indexes.push({ path: kbPath, index: index as any })
      }
    }

    if (indexes.length === 0) {
      return {
        title: "Knowledge base empty",
        output: `All ${kbPaths.length} knowledge base(s) are empty. No documents have been synced yet.

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

    // 执行搜索 - 搜索所有激活的知识库
    const topK = Math.min(params.topK || 10, 20)
    const allResults: Array<{ result: typeof Knowledge.search extends (...args: any) => Promise<(infer T)[]> ? T : never; kbPath: string }> = []
    
    for (const { path: kbPath, index } of indexes) {
      const results = await Knowledge.search(kbPath, index as any, params.query, {
        apiKey: (index as any).config.apiKey || globalKnowledgeConfig?.apiKey,
        baseURL: (index as any).config.baseURL || globalKnowledgeConfig?.baseURL,
        topK,
      })
      for (const result of results) {
        allResults.push({ result: result as any, kbPath })
      }
    }

    // 按分数排序并取 topK
    allResults.sort((a, b) => (b.result as any).score - (a.result as any).score)
    const topResults = allResults.slice(0, topK)

    if (topResults.length === 0) {
      let totalDocs = 0
      let totalChunks = 0
      for (const { index } of indexes) {
        totalDocs += (index as any).stats.totalDocuments
        totalChunks += (index as any).stats.totalChunks
      }
      return {
        title: "No results found",
        output: `No relevant information found for query: "${params.query}"

The knowledge bases contain ${totalDocs} documents with ${totalChunks} chunks, but none matched your query.

Try:
- Using different keywords
- Making your query more general
- Checking if the topic exists in your synced documents`,
        metadata: {
          configured: true,
          exists: true,
          documents: totalDocs,
          chunks: totalChunks,
          results: 0,
        } as KnowledgeMetadata,
      }
    }

    // 格式化输出
    const outputParts: string[] = [
      `<knowledge_search query="${params.query}" results="${topResults.length}" bases="${indexes.length}">`,
      "",
    ]

    // 收集所有来源文件（用于生成来源链接）
    const sourceFiles = new Map<string, string>() // fileName -> filePath

    for (let i = 0; i < topResults.length; i++) {
      const { result } = topResults[i]
      const filePath = (result as any).document.filePath
      const fileName = (result as any).document.fileName
      
      // 记录来源文件
      if (!sourceFiles.has(fileName)) {
        sourceFiles.set(fileName, filePath)
      }
      
      // 生成 file:// URL
      const fileUrl = `file://${filePath}`
      
      outputParts.push(`<result index="${i + 1}" score="${(result as any).score.toFixed(4)}">`)
      outputParts.push(`  <source link="${fileUrl}">${fileName}</source>`)
      if ((result as any).chunk.pageNumber) {
        outputParts.push(`  <page>${(result as any).chunk.pageNumber}</page>`)
      }
      outputParts.push(`  <content>`)
      outputParts.push(`    ${(result as any).chunk.content.trim()}`)
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
    
    // 计算总数
    let totalDocs = 0
    let totalChunks = 0
    for (const { index } of indexes) {
      totalDocs += (index as any).stats.totalDocuments
      totalChunks += (index as any).stats.totalChunks
    }
    
    outputParts.push(`<summary>`)
    outputParts.push(`Found ${topResults.length} relevant chunks from ${sourceFiles.size} documents.`)
    outputParts.push(`Knowledge bases: ${kbPaths.join(", ")}`)
    outputParts.push(`Total: ${totalDocs} documents, ${totalChunks} chunks.`)
    outputParts.push(`</summary>`)

    return {
      title: `Found ${topResults.length} results`,
      output: outputParts.join("\n"),
      metadata: {
        configured: true,
        exists: true,
        documents: totalDocs,
        chunks: totalChunks,
        results: topResults.length,
        sources: [...new Set(topResults.map(r => (r.result as any).document.fileName))],
      } as KnowledgeMetadata,
    }
  },
})
