/**
 * JSON 解析和通用工具函数
 */

import { Log } from "../util/log"

const log = Log.create({ service: "pdf-util" })

/**
 * 从可能包含非 JSON 内容的文本中提取 JSON 对象
 */
export function parseJsonFromText<T>(text: string): T | null {
  // 先尝试直接解析
  try {
    return JSON.parse(text) as T
  } catch {
    // 继续
  }

  // 尝试提取 ```json ... ``` 代码块
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T
    } catch {
      // 继续
    }
  }

  // 尝试用正则匹配 JSON 对象
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as T
    } catch {
      // 失败
    }
  }

  return null
}

/**
 * 生成唯一任务 ID
 */
export function generateTaskID(): string {
  return `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 根据 PDF 文件名计算输出路径
 */
export function computeOutputPaths(
  pdfPath: string,
  outputMode: "merged" | "per-page",
): { merged: string; perPage: string; images: string; dataJson: string } {
  const dir = pdfPath.replace(/[/\\][^/\\]+$/, "")
  const basename = pdfPath.replace(/^.*[/\\]/, "").replace(/\.pdf$/i, "")

  return {
    merged: `${dir}/${basename}.md`,
    perPage: `${dir}/${basename}_md`,
    images: `${dir}/${basename}_images`,
    dataJson: `${dir}/${basename}_data.json`,
  }
}

/**
 * 处理文件名冲突：加序号
 */
export async function resolveConflict(
  filePath: string,
  action: "replace" | "rename",
): Promise<string> {
  if (action === "replace") return filePath

  const ext = filePath.match(/\.[^.]+$/)?.[0] ?? ""
  const base = filePath.slice(0, filePath.length - ext.length)

  let i = 1
  let candidate = `${base}(${i})${ext}`
  while (await Bun.file(candidate).exists()) {
    i++
    candidate = `${base}(${i})${ext}`
  }
  return candidate
}

/**
 * 带指数退避的重试函数（用于 API 限流 429 错误）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number
    initialDelay?: number
    abortSignal?: AbortSignal
  } = {},
): Promise<T> {
  const { maxRetries = 3, initialDelay = 5000, abortSignal } = opts
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (abortSignal?.aborted) throw new Error("已取消")

    try {
      return await fn()
    } catch (e: any) {
      lastError = e

      // 只对 429 或网络错误重试
      const is429 = e?.message?.includes("429") || e?.status === 429 || e?.statusCode === 429
      const isNetworkError = e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT"

      if (!is429 && !isNetworkError) throw e
      if (attempt >= maxRetries) throw e

      const delay = initialDelay * Math.pow(2, attempt) // 5s → 10s → 20s
      log.info("rate limited, retrying", { attempt: attempt + 1, delay })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError ?? new Error("重试次数用尽")
}
