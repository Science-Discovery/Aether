/**
 * Markdown 翻译器主入口
 *
 * Part A: 任务队列管理（与 pdf-converter/index.ts 结构一致，但独立队列）
 * Part B: 核心翻译逻辑（AsyncGenerator，支持 3 并发）
 */

import path from "path"
import fs from "fs/promises"
import type { LanguageModel } from "ai"
import { streamText } from "ai"
import { Provider } from "../provider/provider"
import { ProviderID, ModelID } from "../provider/schema"
import { resolveConflict } from "../pdf-converter/util"
import { FormulaProtector } from "./formula-protector"
import { buildTranslatePrompt } from "./prompts"
import { getChunks } from "./chunker"
import type { TranslateConfig, TranslateTask, TranslateProgressEvent } from "./types"
import { Log } from "../util/log"

const log = Log.create({ service: "markdown-translator" })

// ============================================================
// Part A: 任务队列管理
// ============================================================

const activeTasks = new Map<string, TranslateTask>()
const taskQueue: { taskID: string; config: TranslateConfig }[] = []
let currentRunningTaskID: string | null = null

export function generateTranslateTaskID(): string {
  return `translate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function getTranslateTask(taskID: string): TranslateTask | undefined {
  return activeTasks.get(taskID)
}

/** 列出所有活跃翻译任务（运行中排首位，其余按队列顺序） */
export function listActiveTranslateTasks(): { taskID: string; status: string; path: string; taskType: "translate" }[] {
  const result: { taskID: string; status: string; path: string; taskType: "translate" }[] = []
  // 先加入正在运行的任务
  if (currentRunningTaskID) {
    const task = activeTasks.get(currentRunningTaskID)
    if (task) result.push({ taskID: task.id, status: "running", path: task.config.path, taskType: "translate" })
  }
  // 再按队列顺序加入等待中的任务
  for (const queued of taskQueue) {
    result.push({ taskID: queued.taskID, status: "queued", path: queued.config.path, taskType: "translate" })
  }
  return result
}

export function cancelTranslateTask(taskID: string): boolean {
  const task = activeTasks.get(taskID)
  if (!task) return false

  const queueIndex = taskQueue.findIndex((q) => q.taskID === taskID)
  if (queueIndex >= 0) {
    taskQueue.splice(queueIndex, 1)
    task.status = "cancelled"
    task.abortController.abort()
    const cancelEvent: TranslateProgressEvent = { type: "error", message: "已取消（排队中）" }
    task.events.push(cancelEvent)
    for (const listener of task.listeners) listener(cancelEvent)
    return true
  }

  if (task.status === "running") {
    task.abortController.abort()
    task.status = "cancelled"
    return true
  }

  return false
}

export function getTranslateQueuePosition(taskID: string): number {
  if (currentRunningTaskID === taskID) return 0
  const idx = taskQueue.findIndex((q) => q.taskID === taskID)
  return idx >= 0 ? idx + 1 : -1
}

export function startTranslation(taskID: string, config: TranslateConfig): TranslateTask {
  const abortController = new AbortController()
  const task: TranslateTask = {
    id: taskID,
    config,
    status: "running",
    events: [],
    listeners: new Set(),
    abortController,
  }

  activeTasks.set(taskID, task)

  if (!currentRunningTaskID) {
    executeTask(task)
  } else {
    taskQueue.push({ taskID, config })
    const queuePos = taskQueue.findIndex((q) => q.taskID === taskID) + 1
    const queueEvent: TranslateProgressEvent = {
      type: "progress",
      currentPage: 0,
      totalPages: 0,
      phase: "translate" as const,
    }
    // Encode queue position in a compatible way
    const queueNotify: TranslateProgressEvent = {
      type: "progress",
      currentPage: 0,
      totalPages: 0,
      phase: "translate",
    }
    task.events.push(queueNotify)
    for (const listener of task.listeners) listener(queueNotify)
    log.info("translate task queued", { taskID, position: queuePos })
  }

  return task
}

function executeTask(task: TranslateTask) {
  currentRunningTaskID = task.id
  log.info("translate task started", { taskID: task.id, path: task.config.path })

  ;(async () => {
    try {
      for await (const event of translate(task.config, task.abortController.signal)) {
        task.events.push(event)
        for (const listener of task.listeners) {
          listener(event)
        }
      }
      if (task.status === "running") {
        task.status = "done"
      }
    } catch (e: any) {
      if (task.status !== "cancelled") {
        task.status = "error"
        const errorEvent: TranslateProgressEvent = {
          type: "error",
          message: e?.message || String(e),
        }
        task.events.push(errorEvent)
        for (const listener of task.listeners) listener(errorEvent)
      }
    } finally {
      currentRunningTaskID = null
      processNextInQueue()
    }
  })()
}

function processNextInQueue() {
  if (currentRunningTaskID) return
  if (taskQueue.length === 0) return

  const next = taskQueue.shift()!
  const task = activeTasks.get(next.taskID)
  if (!task || task.status === "cancelled") {
    processNextInQueue()
    return
  }

  executeTask(task)
}

// ============================================================
// Part B: 核心翻译逻辑
// ============================================================

interface ChunkResult {
  index: number
  translated: string
  tokenInput: number
  tokenOutput: number
  error?: string
}

function cleanResponse(response: string): string {
  response = response.trim()
  if (response.startsWith("```markdown")) {
    response = response.slice("```markdown".length).trim()
  } else if (response.startsWith("```md")) {
    response = response.slice("```md".length).trim()
  } else if (response.startsWith("```")) {
    response = response.slice(3).trim()
  }
  if (response.endsWith("```")) {
    response = response.slice(0, -3).trim()
  }
  return response
}

async function translateOneChunk(
  languageModel: LanguageModel,
  chunk: string,
  index: number,
  targetLanguage: string,
  abortSignal: AbortSignal,
): Promise<ChunkResult> {
  const protector = new FormulaProtector()
  const protectedContent = protector.protect(chunk)
  const prompt = buildTranslatePrompt(protectedContent, targetLanguage)

  try {
    const result = await streamText({
      model: languageModel,
      prompt,
      maxOutputTokens: 16000,
      abortSignal,
    })

    let translated = ""
    for await (const part of result.textStream) {
      translated += part
    }

    translated = cleanResponse(translated)
    const restored = protector.restore(translated)

    const issues = protector.verify(chunk, restored)
    if (issues.length > 0) {
      for (const issue of issues) {
        log.warn("formula verification issue", { chunkIndex: index, issue })
      }
    }

    const usage = await result.usage
    return {
      index,
      translated: restored,
      tokenInput: usage?.inputTokens ?? 0,
      tokenOutput: usage?.outputTokens ?? 0,
    }
  } catch (e: any) {
    log.error("chunk translation failed, using original", { chunkIndex: index, error: e?.message })
    return {
      index,
      translated: chunk,
      tokenInput: 0,
      tokenOutput: 0,
      error: e?.message || String(e),
    }
  }
}

async function* translate(
  config: TranslateConfig,
  abortSignal: AbortSignal,
): AsyncGenerator<TranslateProgressEvent> {
  const { path: mdPath, targetLanguage, conflictAction, outputDir } = config

  // 1. 获取 LLM 模型实例
  const modelInfo = await Provider.getModel(
    ProviderID.make(config.providerID),
    ModelID.make(config.modelID),
  )
  const languageModel: LanguageModel = await Provider.getLanguage(modelInfo)

  // 2. 获取分块
  const { chunks } = await getChunks(mdPath)
  if (chunks.length === 0) {
    yield { type: "error", message: "文件内容为空，无需翻译" }
    return
  }

  const total = chunks.length
  let completedCount = 0
  let totalInput = 0
  let totalOutput = 0

  // 3. 并发翻译（最多 3 并发）
  const CONCURRENCY = 3
  let running = 0
  const waiters: (() => void)[] = []

  const acquire = async () => {
    if (running < CONCURRENCY) {
      running++
      return
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
    })
    running++
  }

  const release = () => {
    running--
    const next = waiters.shift()
    if (next) next()
  }

  const results: Promise<ChunkResult>[] = chunks.map((chunk, i) => {
    return (async () => {
      await acquire()
      try {
        if (abortSignal.aborted) {
          return { index: i, translated: chunk, tokenInput: 0, tokenOutput: 0, error: "已取消" }
        }
        return await translateOneChunk(languageModel, chunk, i, targetLanguage, abortSignal)
      } finally {
        release()
      }
    })()
  })

  // 按原始顺序依次 await 并 yield 进度事件
  const translatedChunks: string[] = new Array(chunks.length)
  for (let i = 0; i < results.length; i++) {
    if (abortSignal.aborted) break
    const result = await results[i]
    translatedChunks[result.index] = result.translated
    totalInput += result.tokenInput
    totalOutput += result.tokenOutput
    completedCount++

    yield { type: "progress", currentPage: completedCount, totalPages: total, phase: "translate" }
    yield { type: "token", input: totalInput, output: totalOutput, total: totalInput + totalOutput }
    yield { type: "page_done", page: i + 1, figureCount: 0 }

    if (result.error) {
      yield { type: "error", message: `第 ${i + 1} 块翻译失败: ${result.error}`, page: i + 1 }
    }
  }

  if (abortSignal.aborted) return

  // 4. 合并翻译块
  const mergedContent = translatedChunks.filter(Boolean).join("\n\n")

  // 5. 计算输出路径
  const dir = outputDir ?? path.dirname(mdPath)
  const ext = path.extname(mdPath)
  const basename = path.basename(mdPath, ext)
  let outputPath = path.join(dir, `${basename}_zh${ext}`)

  if (conflictAction !== "cancel") {
    outputPath = await resolveConflict(outputPath, conflictAction)
  }

  // 6. 写入文件
  await fs.writeFile(outputPath, mergedContent, "utf-8")

  yield {
    type: "done",
    outputPath,
    totalTokens: { input: totalInput, output: totalOutput },
  }
}
