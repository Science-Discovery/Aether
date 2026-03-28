import type { EmbeddingProvider, EmbeddingModelInfo } from "./types"

// 嵌入模型统一接口
export interface Embedder {
  readonly name: string
  readonly provider: EmbeddingProvider
  readonly dimensions: number
  embed(texts: string[]): Promise<Float32Array[]>
}

// 可用的嵌入模型列表
export const EMBEDDING_MODELS: EmbeddingModelInfo[] = [
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
]

// Embedding 批量大小限制（大多数 API 限制为 100）
const EMBEDDING_BATCH_SIZE = 100

type EmbeddingResponse = {
  data?: Array<{
    index?: number
    embedding?: unknown
  }>
  error?:
    | {
        message?: string
      }
    | string
}

class ReqError extends Error {
  status: number
  url: string

  constructor(message: string, status: number, url: string) {
    super(message)
    this.name = "ReqError"
    this.status = status
    this.url = url
  }
}

function trimURL(url: string) {
  return url.replace(/\/+$/, "")
}

function listURLs(baseURL: string) {
  const base = trimURL(baseURL)
  const list = [`${base}/embeddings`]
  if (/\/v\d+$/.test(base)) {
    list.push(`${base.replace(/\/v\d+$/, "")}/embeddings`)
  } else {
    list.push(`${base}/v1/embeddings`)
  }
  return Array.from(new Set(list))
}

function getError(data: EmbeddingResponse | null) {
  if (!data?.error) return ""
  if (typeof data.error === "string") return data.error
  return data.error.message || ""
}

async function callEmbedding(opts: { url: string; apiKey: string; model: string; input: string | string[] }) {
  const response = await fetch(opts.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      input: opts.input,
      model: opts.model,
    }),
    signal: AbortSignal.timeout(30000),
  })

  const text = await response.text()
  const type = response.headers.get("content-type") || ""
  const data = text && type.includes("application/json") ? (JSON.parse(text) as EmbeddingResponse) : null

  if (response.ok) {
    if (!data) {
      throw new ReqError(
        `Embedding API returned empty body (${response.status} ${response.statusText}) at ${opts.url}`,
        response.status,
        opts.url,
      )
    }
    return data
  }

  const msg = getError(data) || text
  if (msg) {
    throw new ReqError(
      `Embedding API failed (${response.status} ${response.statusText}) at ${opts.url}: ${msg}`,
      response.status,
      opts.url,
    )
  }

  throw new ReqError(
    `Embedding API failed (${response.status} ${response.statusText}) at ${opts.url} with empty response body`,
    response.status,
    opts.url,
  )
}

function pick(err: Error | undefined, next: Error) {
  if (!err) return next
  if (!(err instanceof ReqError) || !(next instanceof ReqError)) return next
  const a = err.status === 404 || err.status === 405
  const b = next.status === 404 || next.status === 405
  if (a && !b) return next
  return err
}

function limit(msg: string) {
  const m = msg.match(/larger than\s+(\d+)/i) || msg.match(/batch size[^\d]*(\d+)/i)
  if (!m) return
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 1) return
  return Math.floor(n)
}

function getVector(data: EmbeddingResponse, url: string) {
  const vec = data.data?.[0]?.embedding
  if (Array.isArray(vec)) {
    return vec
  }
  throw new Error(`Invalid embedding response at ${url}: missing data[0].embedding array`)
}

// OpenAI 嵌入实现
export class OpenAIEmbedder implements Embedder {
  readonly name: string
  readonly provider: EmbeddingProvider = "openai"
  readonly dimensions: number

  private apiKey: string
  private model: string
  private baseURL: string

  constructor(opts: { apiKey: string; model: string; dimensions: number; baseURL?: string }) {
    this.name = `openai/${opts.model}`
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.dimensions = opts.dimensions
    this.baseURL = opts.baseURL || "https://api.openai.com/v1"
  }

  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: batch.length === 1 ? batch[0] : batch,
        model: this.model,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI embedding failed: ${error}`)
    }

    const data = await response.json()
    const items: any[] = Array.isArray(data.data) ? data.data : [data.data]
    const sorted = items.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
    return sorted.map((item: any) => new Float32Array(item.embedding))
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const allEmbeddings: Float32Array[] = []

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)

      try {
        // 尝试批量发送
        const embeddings = await this.embedBatch(batch)
        allEmbeddings.push(...embeddings)
      } catch {
        // 批量失败（部分模型不支持数组输入）时降级为逐条发送
        for (const text of batch) {
          const embeddings = await this.embedBatch([text])
          allEmbeddings.push(...embeddings)
        }
      }
    }

    return allEmbeddings
  }
}

// 自定义 OpenAI Compatible 嵌入实现
export class CustomEmbedder implements Embedder {
  readonly name: string
  readonly provider: EmbeddingProvider = "custom"
  readonly dimensions: number

  private apiKey: string
  private model: string
  private baseURL: string

  constructor(opts: { apiKey: string; model: string; dimensions: number; baseURL: string }) {
    this.name = `custom/${opts.model}`
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.dimensions = opts.dimensions
    this.baseURL = opts.baseURL
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const allEmbeddings: Float32Array[] = []
    const urls = listURLs(this.baseURL)
    let size = EMBEDDING_BATCH_SIZE

    // 分批处理，每批最多 EMBEDDING_BATCH_SIZE 个
    for (let i = 0; i < texts.length; ) {
      const batch = texts.slice(i, i + size)

      let data: EmbeddingResponse | undefined
      let err: Error | undefined
      const tried: string[] = []
      for (const url of urls) {
        tried.push(url)
        try {
          data = await callEmbedding({
            url,
            apiKey: this.apiKey,
            model: this.model,
            input: batch,
          })
          break
        } catch (e) {
          err = pick(err, e instanceof Error ? e : new Error(String(e)))
        }
      }

      if (!data) {
        const cap = err ? limit(err.message) : undefined
        if (cap && cap < size) {
          size = cap
          continue
        }
        throw new Error(`Custom embedding failed: ${err?.message || "request failed"}. Tried: ${tried.join(", ")}`)
      }

      const sortedData = (data.data || []).sort((a, b) => (a.index || 0) - (b.index || 0))
      for (const item of sortedData) {
        if (!Array.isArray(item.embedding)) {
          throw new Error("Custom embedding failed: response contains invalid embedding vector")
        }
        allEmbeddings.push(new Float32Array(item.embedding))
      }

      i += batch.length
    }

    return allEmbeddings
  }
}

// 本地嵌入实现（使用 Transformers.js）
export class LocalEmbedder implements Embedder {
  readonly name: string
  readonly provider: EmbeddingProvider = "local"
  readonly dimensions: number

  private model: string
  private extractor:
    | ((text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: number[] }>)
    | null = null
  private initPromise: Promise<void> | null = null

  constructor(opts: { model: string; dimensions: number }) {
    this.name = `local/${opts.model}`
    this.model = opts.model
    this.dimensions = opts.dimensions
  }

  private async init() {
    if (this.extractor) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      try {
        // 动态导入 Transformers.js（可选依赖）
        const transformers = await import("@xenova/transformers" as string)
        const pipeline = (transformers as any).pipeline
        this.extractor = await pipeline("feature-extraction", this.model, {
          quantized: true,
        })
      } catch (e: any) {
        throw new Error(`Failed to load local embedding model. Please install @xenova/transformers: ${e?.message || e}`)
      }
    })()

    return this.initPromise
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.init()

    if (!this.extractor) {
      throw new Error("Local embedder not initialized")
    }

    const embeddings: Float32Array[] = []

    for (const text of texts) {
      const result = await this.extractor(text, { pooling: "mean", normalize: true })
      embeddings.push(new Float32Array(result.data))
    }

    return embeddings
  }
}

// 创建嵌入器工厂函数
export function createEmbedder(opts: {
  provider: EmbeddingProvider
  model: string
  dimensions: number
  apiKey?: string
  baseURL?: string
}): Embedder {
  switch (opts.provider) {
    case "openai":
      if (!opts.apiKey) {
        throw new Error("OpenAI embedding requires API key")
      }
      return new OpenAIEmbedder({
        apiKey: opts.apiKey,
        model: opts.model,
        dimensions: opts.dimensions,
        baseURL: opts.baseURL,
      })

    case "custom":
      if (!opts.apiKey || !opts.baseURL) {
        throw new Error("Custom embedding requires API key and base URL")
      }
      return new CustomEmbedder({
        apiKey: opts.apiKey,
        model: opts.model,
        dimensions: opts.dimensions,
        baseURL: opts.baseURL,
      })

    case "local":
      return new LocalEmbedder({
        model: opts.model,
        dimensions: opts.dimensions,
      })

    default:
      throw new Error(`Unknown embedding provider: ${opts.provider}`)
  }
}

// 获取嵌入模型信息
export function getEmbeddingModel(modelId: string): EmbeddingModelInfo | undefined {
  return EMBEDDING_MODELS.find((m) => m.id === modelId)
}

// 获取模型的默认维度（仅对已知模型有效）
export function getDefaultDimensions(modelId: string): number | null {
  const model = getEmbeddingModel(modelId)
  if (model) {
    return model.dimensions
  }
  // 未知模型，返回 null 表示需要自动检测
  return null
}

// 自动检测嵌入模型的维度
export async function detectDimensions(opts: {
  provider: EmbeddingProvider
  model: string
  apiKey?: string
  baseURL?: string
}): Promise<number> {
  const testText = "test"

  switch (opts.provider) {
    case "openai": {
      if (!opts.apiKey) {
        throw new Error("OpenAI embedding requires API key")
      }
      const baseURL = opts.baseURL || "https://api.openai.com/v1"
      const response = await fetch(`${baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          input: testText,
          model: opts.model,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to detect dimensions: ${error}`)
      }
      const data = await response.json()
      return data.data[0].embedding.length
    }

    case "custom": {
      if (!opts.apiKey || !opts.baseURL) {
        throw new Error("Custom embedding requires API key and base URL")
      }
      let err: Error | undefined
      const urls = listURLs(opts.baseURL)
      const inputs: Array<string | string[]> = [testText, [testText]]
      const tried: string[] = []

      for (const url of urls) {
        for (const input of inputs) {
          tried.push(`${url} (input: ${Array.isArray(input) ? "string[]" : "string"})`)
          try {
            const data = await callEmbedding({
              url,
              apiKey: opts.apiKey,
              model: opts.model,
              input,
            })
            return getVector(data, url).length
          } catch (e) {
            err = pick(err, e instanceof Error ? e : new Error(String(e)))
          }
        }
      }

      throw new Error(`Failed to detect dimensions: ${err?.message || "request failed"}. Tried: ${tried.join(", ")}`)
    }

    case "local": {
      // 本地模型需要加载后才能检测
      try {
        const transformers = await import("@xenova/transformers" as string)
        const pipeline = (transformers as any).pipeline
        const extractor = await pipeline("feature-extraction", opts.model, {
          quantized: true,
        })
        const result = await extractor(testText, { pooling: "mean", normalize: true })
        return result.data.length
      } catch (e: any) {
        throw new Error(`Failed to detect dimensions for local model: ${e?.message || e}`)
      }
    }

    default:
      throw new Error(`Unknown embedding provider: ${opts.provider}`)
  }
}

// 列出所有可用的嵌入模型
export function listEmbeddingModels(): EmbeddingModelInfo[] {
  return EMBEDDING_MODELS
}
