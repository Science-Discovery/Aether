import { createContext, useContext, createSignal, Component, JSX, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "./global-sdk"

// 知识库配置
export interface KnowledgeConfig {
  id: string
  path: string
  name: string
  embeddingProvider: "openai" | "local" | "custom"
  embeddingModel: string
  embeddingDimensions?: number
  apiKey?: string
  baseURL?: string
  chunkSize: number
  chunkOverlap: number
  // 统计信息
  documentCount?: number
  chunkCount?: number
  syncedAt?: number
}

// 知识库状态
export interface KnowledgeState {
  knowledgeBases: KnowledgeConfig[]
  activeId: string | null
}

// 知识库搜索结果
export interface KnowledgeSearchResult {
  chunk: {
    id: string
    documentId: string
    index: number
    content: string
    pageNumber?: number
  }
  document: {
    id: string
    filePath: string
    fileName: string
    fileSize: number
    pageCount: number
    status: string
  }
  score: number
}

// 嵌入模型信息
export interface EmbeddingModel {
  id: string
  name: string
  provider: "openai" | "local" | "custom"
  dimensions: number
  description: string
}

const DEFAULT_STATE: KnowledgeState = {
  knowledgeBases: [],
  activeId: null,
}

interface KnowledgeContextValue {
  state: KnowledgeState
  models: () => EmbeddingModel[]
  // 当前激活的知识库
  activeKnowledgeBase: () => KnowledgeConfig | null
  // 所有知识库
  knowledgeBases: () => KnowledgeConfig[]
  // 激活状态
  enabled: () => boolean
  // 同步进度
  syncProgress: () => { current: number; total: number } | null
  // 设置激活的知识库
  setActive: (id: string | null) => void
  // 添加知识库
  addKnowledgeBase: (config: Omit<KnowledgeConfig, "id">) => string
  // 更新知识库
  updateKnowledgeBase: (id: string, config: Partial<KnowledgeConfig>) => void
  // 删除知识库
  removeKnowledgeBase: (id: string) => Promise<void>
  // 加载知识库
  loadKnowledgeBase: (path: string) => Promise<any | null>
  // 创建知识库
  createKnowledgeBase: (config: KnowledgeConfig) => Promise<any>
  // 同步知识库
  syncKnowledgeBase: (id?: string) => Promise<{ added: number; updated: number; removed: number; errors?: string[] }>
  // 停止同步
  stopSync: () => void
  // 搜索
  search: (query: string, topK?: number) => Promise<KnowledgeSearchResult[]>
  // 构建 RAG 上下文
  buildRAGContext: (results: KnowledgeSearchResult[], maxLength?: number) => string
  // 刷新所有知识库统计信息
  refreshAllStats: () => Promise<void>
}

const KnowledgeContext = createContext<KnowledgeContextValue>()

export function useKnowledge() {
  const ctx = useContext(KnowledgeContext)
  if (!ctx) {
    throw new Error("useKnowledge must be used within a KnowledgeProvider")
  }
  return ctx
}

function generateId(): string {
  return `kb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export const KnowledgeProvider: Component<{ children: JSX.Element }> = (props) => {
  const sdk = useGlobalSDK()

  const [state, setState] = persisted(
    Persist.global("knowledge-state"),
    createStore<KnowledgeState>(DEFAULT_STATE),
  )

  const [models] = createSignal<EmbeddingModel[]>([
    {
      id: "text-embedding-3-small",
      name: "OpenAI text-embedding-3-small",
      provider: "openai",
      dimensions: 1536,
      description: "OpenAI 的轻量级嵌入模型，性价比高",
    },
    {
      id: "text-embedding-3-large",
      name: "OpenAI text-embedding-3-large",
      provider: "openai",
      dimensions: 3072,
      description: "OpenAI 的高性能嵌入模型",
    },
    {
      id: "all-MiniLM-L6-v2",
      name: "all-MiniLM-L6-v2 (本地)",
      provider: "local",
      dimensions: 384,
      description: "轻量级本地嵌入模型，无需 API",
    },
  ])

  const [syncProgress, setSyncProgress] = createSignal<{ current: number; total: number } | null>(null)
  let syncAbortController: AbortController | null = null

  const stopSync = () => {
    syncAbortController?.abort()
    syncAbortController = null
  }

  // 当前激活的知识库
  const activeKnowledgeBase = () => {
    const id = state.activeId
    if (!id) return null
    return state.knowledgeBases.find(kb => kb.id === id) ?? null
  }

  // 所有知识库
  const knowledgeBases = () => state.knowledgeBases

  // 是否启用（有激活的知识库）
  const enabled = () => state.activeId !== null && state.knowledgeBases.length > 0

  // 设置激活的知识库
  const setActive = (id: string | null) => {
    setState("activeId", id)
  }

  // 添加知识库
  const addKnowledgeBase = (config: Omit<KnowledgeConfig, "id">): string => {
    const id = generateId()
    const newKb: KnowledgeConfig = { ...config, id }
    setState("knowledgeBases", [...state.knowledgeBases, newKb])
    // 如果是第一个知识库，自动激活
    if (state.knowledgeBases.length === 0) {
      setState("activeId", id)
    }
    return id
  }

  // 更新知识库
  const updateKnowledgeBase = (id: string, config: Partial<KnowledgeConfig>) => {
    const index = state.knowledgeBases.findIndex(kb => kb.id === id)
    if (index === -1) return
    setState("knowledgeBases", index, { ...state.knowledgeBases[index], ...config })
  }

  // API 请求辅助函数
  const fetchApi = async (path: string, options: RequestInit = {}) => {
    const baseUrl = sdk.url
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
    })

    return response
  }

  // 刷新所有知识库统计信息
  const refreshAllStats = async () => {
    for (const kb of state.knowledgeBases) {
      try {
        const encodedPath = encodeURIComponent(kb.path)
        const response = await fetchApi(`/knowledge/${encodedPath}/stats`)
        if (response.ok) {
          const stats = await response.json()
          updateKnowledgeBase(kb.id, {
            documentCount: stats.totalDocuments,
            chunkCount: stats.totalChunks,
            syncedAt: stats.lastSyncedAt,
          })
        }
      } catch (e) {
        console.error(`Failed to refresh stats for ${kb.name}:`, e)
      }
    }
  }

  // 组件挂载时刷新统计信息
  onMount(() => {
    if (state.knowledgeBases.length > 0) {
      refreshAllStats()
    }
  })

  const loadKnowledgeBase = async (path: string) => {
    const encodedPath = encodeURIComponent(path)
    const response = await fetchApi(`/knowledge/${encodedPath}`, {
      method: "GET",
    })

    if (!response.ok) {
      return null
    }

    return response.json()
  }

  const createKnowledgeBase = async (cfg: KnowledgeConfig) => {
    const response = await fetchApi("/knowledge", {
      method: "POST",
      body: JSON.stringify({
        path: cfg.path,
        name: cfg.name,
        embeddingProvider: cfg.embeddingProvider,
        embeddingModel: cfg.embeddingModel,
        embeddingDimensions: cfg.embeddingDimensions,
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        chunkSize: cfg.chunkSize,
        chunkOverlap: cfg.chunkOverlap,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to create knowledge base: ${error}`)
    }

    return response.json()
  }

  const syncKnowledgeBase = async (id?: string) => {
    const targetId = id ?? state.activeId
    if (!targetId) {
      throw new Error("No knowledge base selected")
    }

    const kb = state.knowledgeBases.find(k => k.id === targetId)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }

    setSyncProgress(null)
    const encodedPath = encodeURIComponent(kb.path)
    const baseUrl = sdk.url

    // 先设置全局配置，让 knowledge_search 工具知道知识库路径
    await fetchApi("/knowledge/config", {
      method: "POST",
      body: JSON.stringify({
        path: kb.path,
        apiKey: kb.apiKey,
        baseURL: kb.baseURL,
      }),
    })

    syncAbortController = new AbortController()
    const timeoutSignal = AbortSignal.timeout(600000)
    const combinedSignal = AbortSignal.any
      ? AbortSignal.any([syncAbortController.signal, timeoutSignal])
      : syncAbortController.signal

    const response = await fetch(`${baseUrl}/knowledge/${encodedPath}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: kb.apiKey,
        baseURL: kb.baseURL,
      }),
      signal: combinedSignal,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to sync knowledge base: ${error}`)
    }

    let finalResult: { added: number; updated: number; removed: number; errors?: string[] } = {
      added: 0,
      updated: 0,
      removed: 0,
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""

        for (const block of parts) {
          let event = "message"
          let data = ""
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim()
            else if (line.startsWith("data: ")) data = line.slice(6).trim()
          }
          if (!data) continue

          if (event === "progress") {
            const status = JSON.parse(data)
            setSyncProgress({ current: status.current, total: status.total })
          } else if (event === "complete") {
            finalResult = JSON.parse(data)
            // 更新统计信息
            const statsResponse = await fetchApi(`/knowledge/${encodedPath}/stats`)
            if (statsResponse.ok) {
              const stats = await statsResponse.json()
              updateKnowledgeBase(targetId, {
                documentCount: stats.totalDocuments,
                chunkCount: stats.totalChunks,
                syncedAt: Date.now(),
              })
            }
          } else if (event === "error") {
            const errData = JSON.parse(data)
            throw new Error(errData.message)
          }
        }
      }
    } finally {
      setSyncProgress(null)
      syncAbortController = null
      reader.releaseLock()
    }

    return finalResult
  }

  const search = async (query: string, topK: number = 5): Promise<KnowledgeSearchResult[]> => {
    const kb = activeKnowledgeBase()
    if (!kb) {
      return []
    }

    const encodedPath = encodeURIComponent(kb.path)
    const response = await fetchApi(`/knowledge/${encodedPath}/search`, {
      method: "POST",
      body: JSON.stringify({
        query,
        topK,
        apiKey: kb.apiKey,
        baseURL: kb.baseURL,
      }),
    })

    if (!response.ok) {
      console.error("Knowledge search failed:", await response.text())
      return []
    }

    return response.json()
  }

  const removeKnowledgeBase = async (id?: string) => {
    const targetId = id ?? state.activeId
    if (!targetId) return

    const kb = state.knowledgeBases.find(k => k.id === targetId)
    if (!kb) return

    const encodedPath = encodeURIComponent(kb.path)
    const response = await fetchApi(`/knowledge/${encodedPath}`, {
      method: "DELETE",
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to remove knowledge base: ${error}`)
    }

    // 从列表中移除
    const newIndex = state.knowledgeBases.filter(k => k.id !== targetId)
    setState("knowledgeBases", newIndex)

    // 如果删除的是当前激活的，切换到第一个或设为 null
    if (state.activeId === targetId) {
      setState("activeId", newIndex.length > 0 ? newIndex[0]!.id : null)
    }
  }

  const buildRAGContext = (results: KnowledgeSearchResult[], maxLength: number = 4000): string => {
    if (results.length === 0) return ""

    const parts: string[] = []
    let totalLength = 0

    for (const result of results) {
      const header = `[文档: ${result.document.fileName}]`
      const content = result.chunk.content
      const part = `${header}\n${content}\n`

      if (totalLength + part.length > maxLength) break

      parts.push(part)
      totalLength += part.length
    }

    return parts.join("\n---\n\n")
  }

  const value: KnowledgeContextValue = {
    state,
    models,
    activeKnowledgeBase,
    knowledgeBases,
    enabled,
    syncProgress,
    setActive,
    addKnowledgeBase,
    updateKnowledgeBase,
    removeKnowledgeBase,
    loadKnowledgeBase,
    createKnowledgeBase,
    syncKnowledgeBase,
    stopSync,
    search,
    buildRAGContext,
    refreshAllStats,
  }

  return (
    <KnowledgeContext.Provider value={value}>
      {props.children}
    </KnowledgeContext.Provider>
  )
}