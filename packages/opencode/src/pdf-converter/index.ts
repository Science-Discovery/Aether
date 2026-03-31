/**
 * PDF → Markdown 转换器主类
 *
 * convert() 方法是一个 AsyncGenerator，逐步 yield ProgressEvent 供 SSE 推送。
 */

import path from "path"
import fs from "fs/promises"
import type { LanguageModel } from "ai"
import { Provider } from "../provider/provider"
import { ProviderID } from "../provider/schema"
import { ModelID } from "../provider/schema"
import { renderPage } from "./pdf-renderer"
import { extractText } from "./text-extractor"
import { extractFigures, extractFormulaFigures } from "./figure-extractor"
import { cropImage } from "./image-cropper"
import { replacePlaceholders, assembleMergedMarkdown, saveMergedOutput, savePerPageOutput } from "./markdown-assembler"
import { computeOutputPaths, resolveConflict } from "./util"
import { runAllChecks } from "./content-checker"
import { validateFigure, validateFormulaFigure, validateFigureCount } from "./figure-validator"
import { targetedFix } from "./targeted-fixer"
import { runPostQA } from "./post-qa"
import type {
  ConvertConfig,
  ConvertTask,
  ConvertDataJSON,
  ProgressEvent,
  PageResult,
  FigureInfo,
  FormulaFigureInfo,
} from "./types"
import { Log } from "../util/log"

const log = Log.create({ service: "pdf-converter" })

/** 活跃任务存储 */
const activeTasks = new Map<string, ConvertTask>()

/** 任务队列：按入队顺序执行，同一时刻只有一个任务在运行 */
const taskQueue: { taskID: string; config: ConvertConfig }[] = []
let currentRunningTaskID: string | null = null

export function getTask(taskID: string): ConvertTask | undefined {
  return activeTasks.get(taskID)
}

/** 列出所有活跃任务（含运行中和排队中） */
export function listActiveTasks(): { taskID: string; status: string; path: string; taskType: "convert" }[] {
  const result: { taskID: string; status: string; path: string; taskType: "convert" }[] = []
  for (const [id, task] of activeTasks) {
    if (task.status === "running") {
      result.push({ taskID: id, status: task.status, path: task.config.path, taskType: "convert" })
    }
  }
  return result
}

export function removeTask(taskID: string): void {
  activeTasks.delete(taskID)
}

export function cancelTask(taskID: string): boolean {
  const task = activeTasks.get(taskID)
  if (!task) return false

  // 如果在队列中等待，直接移除
  const queueIndex = taskQueue.findIndex((q) => q.taskID === taskID)
  if (queueIndex >= 0) {
    taskQueue.splice(queueIndex, 1)
    task.status = "cancelled"
    task.abortController.abort()
    const cancelEvent: ProgressEvent = { type: "error", message: "已取消（排队中）" }
    task.events.push(cancelEvent)
    for (const listener of task.listeners) listener(cancelEvent)
    return true
  }

  // 如果正在运行，abort
  if (task.status === "running") {
    task.abortController.abort()
    task.status = "cancelled"
    return true
  }

  return false
}

/** 获取任务在队列中的位置（0 表示正在运行，1+ 表示排队中，-1 表示不在队列） */
export function getQueuePosition(taskID: string): number {
  if (currentRunningTaskID === taskID) return 0
  const idx = taskQueue.findIndex((q) => q.taskID === taskID)
  return idx >= 0 ? idx + 1 : -1
}

/** 获取队列长度（含正在运行的） */
export function getQueueLength(): number {
  return taskQueue.length + (currentRunningTaskID ? 1 : 0)
}

/**
 * 启动 PDF 转 Markdown 任务（入队）
 *
 * 任务按入队顺序串行执行。如果有正在运行的任务，新任务排队等待。
 * 多个同时入队的任务按文件名排序。
 */
export function startConversion(taskID: string, config: ConvertConfig): ConvertTask {
  const abortController = new AbortController()
  const task: ConvertTask = {
    id: taskID,
    config,
    status: "running",
    events: [],
    listeners: new Set(),
    abortController,
  }

  activeTasks.set(taskID, task)

  // 如果没有正在运行的任务，立即启动
  if (!currentRunningTaskID) {
    executeTask(task)
  } else {
    // 入队等待
    taskQueue.push({ taskID, config })
    // 按文件名排序（仅对尚未开始的队列部分）
    taskQueue.sort((a, b) => {
      const nameA = path.basename(a.config.path).toLowerCase()
      const nameB = path.basename(b.config.path).toLowerCase()
      return nameA.localeCompare(nameB)
    })

    // 通知前端：排队中
    const queuePos = taskQueue.findIndex((q) => q.taskID === taskID) + 1
    const queueEvent: ProgressEvent = {
      type: "progress",
      currentPage: 0,
      totalPages: config.endPage - config.startPage + 1,
      phase: `queued:${queuePos}`,
    }
    task.events.push(queueEvent)
    for (const listener of task.listeners) listener(queueEvent)

    log.info("task queued", { taskID, position: queuePos, queueLength: taskQueue.length })
  }

  return task
}

/** 实际执行一个任务 */
function executeTask(task: ConvertTask) {
  currentRunningTaskID = task.id
  log.info("task started", { taskID: task.id, path: task.config.path })

  ;(async () => {
    try {
      for await (const event of convert(task.config, task.abortController.signal)) {
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
        const errorEvent: ProgressEvent = {
          type: "error",
          message: e?.message || String(e),
        }
        task.events.push(errorEvent)
        for (const listener of task.listeners) listener(errorEvent)
      }
    } finally {
      currentRunningTaskID = null
      // 启动队列中的下一个任务
      processNextInQueue()
    }
  })()
}

/** 从队列中取出下一个任务执行 */
function processNextInQueue() {
  if (currentRunningTaskID) return
  if (taskQueue.length === 0) return

  const next = taskQueue.shift()!
  const task = activeTasks.get(next.taskID)
  if (!task || task.status === "cancelled") {
    // 该任务已被取消，跳过
    processNextInQueue()
    return
  }

  executeTask(task)
}

/**
 * 核心转换逻辑 - AsyncGenerator
 */
async function* convert(
  config: ConvertConfig,
  abortSignal: AbortSignal,
): AsyncGenerator<ProgressEvent> {
  const { path: pdfPath, startPage, endPage, outputMode, conflictAction, dpi = 400 } = config

  // 获取 LLM 模型实例
  const modelInfo = await Provider.getModel(
    ProviderID.make(config.providerID),
    ModelID.make(config.modelID),
  )
  const languageModel: LanguageModel = await Provider.getLanguage(modelInfo)

  // 计算输出路径
  const outputPaths = computeOutputPaths(pdfPath, outputMode)

  // 处理文件冲突
  let finalOutputPath: string
  if (outputMode === "merged") {
    finalOutputPath = conflictAction === "cancel"
      ? outputPaths.merged
      : await resolveConflict(outputPaths.merged, conflictAction)
  } else {
    finalOutputPath = outputPaths.perPage
  }

  // 创建临时目录用于渲染
  const tempDir = path.join(path.dirname(pdfPath), `.pdf_convert_temp_${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })

  const totalPages = endPage - startPage + 1
  const pages: PageResult[] = []
  let totalInputTokens = 0
  let totalOutputTokens = 0

  try {
    // 逐页处理
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      if (abortSignal.aborted) break

      const pageIndex = pageNum - startPage
      log.info("processing page", { pageNum, total: totalPages })

      // [预处理] 渲染页面为 PNG
      yield { type: "progress", currentPage: pageIndex + 1, totalPages, phase: "text" }

      let renderResult
      try {
        renderResult = await renderPage(pdfPath, pageNum, tempDir, dpi)
      } catch (e: any) {
        log.error("render page failed", { pageNum, error: e.message })
        yield { type: "error", message: `第 ${pageNum} 页渲染失败: ${e.message}`, page: pageNum }
        pages.push(createFailedPage(pageNum, e.message))
        continue
      }

      // [A] 文字提取 和 [B] 图片 bbox 提取并行
      const embeddedText = renderResult.embedded_text || null
      // 触发图片提取的条件：光栅图片 OR 矢量图形（费曼图、示意图等 PDF path 绘图）
      const hasVisualContent = renderResult.embedded_image_count > 0 || renderResult.has_vector_figures

      // 并行启动
      const textGen = extractText(languageModel, renderResult.image_path, embeddedText, abortSignal)
      const figureGen = hasVisualContent
        ? extractFigures(languageModel, renderResult.image_path, undefined, abortSignal)
        : null

      // 收集文字提取结果
      let textResult
      try {
        textResult = await collectGeneratorResult(textGen, (event) => {
          if (event.type === "token") {
            totalInputTokens += event.input
            totalOutputTokens += event.output
          }
        })
        // 实时推送 token 统计
        yield { type: "token", input: totalInputTokens, output: totalOutputTokens, total: totalInputTokens + totalOutputTokens }
      } catch (e: any) {
        log.error("text extraction failed", { pageNum, error: e.message })
        yield { type: "error", message: `第 ${pageNum} 页文字提取失败: ${e.message}`, page: pageNum }
        pages.push(createFailedPage(pageNum, e.message))
        continue
      }

      // 收集图片提取结果
      yield { type: "progress", currentPage: pageIndex + 1, totalPages, phase: "figure" }
      let figures: FigureInfo[] = []
      if (figureGen) {
        try {
          const figResult = await collectGeneratorResult(figureGen, (event) => {
            if (event.type === "token") {
              totalInputTokens += event.input
              totalOutputTokens += event.output
            }
          })
          figures = figResult.figures
        } catch (e: any) {
          log.error("figure extraction failed", { pageNum, error: e.message })
          // 不终止，继续处理
        }
        // 实时推送 token 统计
        yield { type: "token", input: totalInputTokens, output: totalOutputTokens, total: totalInputTokens + totalOutputTokens }
      }

      // [C] bbox 验证（Phase 2）
      const validatedFigures: FigureInfo[] = []
      const bboxRetryHints: string[] = []
      for (const fig of figures) {
        const result = validateFigure(fig)
        if (result.valid) {
          validatedFigures.push(fig)
        } else {
          log.info("figure bbox invalid", { figureId: fig.figure_id, message: result.message })
          bboxRetryHints.push(result.message)
        }
        if (result.warnings.length > 0) {
          bboxRetryHints.push(...result.warnings)
        }
      }

      // bbox 验证失败时重试一次
      if (bboxRetryHints.length > 0 && validatedFigures.length < figures.length && hasVisualContent) {
        try {
          const retryGen = extractFigures(languageModel, renderResult.image_path, bboxRetryHints, abortSignal)
          const retryResult = await collectGeneratorResult(retryGen, (event) => {
            if (event.type === "token") {
              totalInputTokens += event.input
              totalOutputTokens += event.output
            }
          })
          // 合并新提取的有效 figures
          for (const fig of retryResult.figures) {
            const result = validateFigure(fig)
            if (result.valid && !validatedFigures.some((f) => f.figure_id === fig.figure_id)) {
              validatedFigures.push(fig)
            }
          }
        } catch (e: any) {
          log.error("figure retry failed", { pageNum, error: e.message })
        }
      }
      figures = validatedFigures

      // 如果文字提取发现有图片占位符，但图片提取完全为空（矢量图形页面常见），额外重试一次
      if (textResult.figure_count > 0 && figures.length === 0 && hasVisualContent) {
        log.info("figure count mismatch: text found figures but extraction returned empty, retrying", {
          pageNum,
          expectedCount: textResult.figure_count,
        })
        try {
          const countMismatchHint = `文字提取发现 ${textResult.figure_count} 个图片占位符，但图片提取返回为空。请仔细观察页面中的线条、曲线、示意图等视觉元素并提取其 bbox。`
          const retryGen = extractFigures(languageModel, renderResult.image_path, [countMismatchHint], abortSignal)
          const retryResult = await collectGeneratorResult(retryGen, (event) => {
            if (event.type === "token") {
              totalInputTokens += event.input
              totalOutputTokens += event.output
            }
          })
          for (const fig of retryResult.figures) {
            const result = validateFigure(fig)
            if (result.valid) figures.push(fig)
          }
        } catch (e: any) {
          log.error("figure retry (count mismatch) failed", { pageNum, error: e.message })
        }
      }

      // [D] LaTeX 语法验证 + [E] 内容完整性检查（Phase 2）
      yield { type: "progress", currentPage: pageIndex + 1, totalPages, phase: "fix" }
      const contentIssues = runAllChecks(textResult.content, textResult.figure_count)
      const issueMessages = contentIssues.map((i) => i.message)

      // figure_count 匹配检查
      const countCheck = validateFigureCount(textResult.figure_count, figures)
      if (!countCheck.valid) {
        issueMessages.push(countCheck.message)
      }

      // [F] 如有问题 → 针对性修复（Phase 2，最多 2 次 LLM 调用）
      let currentContent = textResult.content
      let fixesApplied: string[] = []
      if (issueMessages.length > 0) {
        log.info("issues detected, running targeted fix", { pageNum, issueCount: issueMessages.length })
        const fixResult = await targetedFix(
          languageModel,
          currentContent,
          issueMessages,
          2,
          abortSignal,
        )
        currentContent = fixResult.content
        fixesApplied = fixResult.fixesApplied
        totalInputTokens += fixResult.tokenInput
        totalOutputTokens += fixResult.tokenOutput
      }

      // [G] 检测 FORMULA_FIGURE 占位符
      let formulaFigures: FormulaFigureInfo[] = []
      const ffigMatches = currentContent.match(/\[FORMULA_FIGURE:ffig_\d+\]/g) || []
      if (ffigMatches.length > 0) {
        try {
          const ffigGen = extractFormulaFigures(
            languageModel,
            renderResult.image_path,
            ffigMatches.length,
            undefined,
            abortSignal,
          )
          const ffigResult = await collectGeneratorResult(ffigGen, (event) => {
            if (event.type === "token") {
              totalInputTokens += event.input
              totalOutputTokens += event.output
            }
          })
          formulaFigures = ffigResult.formula_figures.filter((ffig) => {
            const validation = validateFormulaFigure(ffig)
            if (!validation.valid) {
              log.info("formula figure bbox invalid", { ffigId: ffig.ffig_id, message: validation.message })
            }
            return validation.valid
          })
        } catch (e: any) {
          log.error("formula figure extraction failed", { pageNum, error: e.message })
        }
      }

      // [H] 图片裁剪（仅在有图片时才创建目录）
      const hasFigures = figures.length > 0 || formulaFigures.length > 0
      if (hasFigures) {
        yield { type: "progress", currentPage: pageIndex + 1, totalPages, phase: "crop" }
        const imagesDir = outputPaths.images
        const pageImagesDir = path.join(imagesDir, `page_${String(pageNum).padStart(3, "0")}`)
        await fs.mkdir(pageImagesDir, { recursive: true })

        for (const fig of figures) {
          try {
            const outPath = path.join(pageImagesDir, `${fig.figure_id}.png`)
            await cropImage(renderResult.image_path, fig.bbox, outPath)
          } catch (e: any) {
            log.error("crop failed", { figureId: fig.figure_id, error: e.message })
          }
        }

        for (const ffig of formulaFigures) {
          try {
            const outPath = path.join(pageImagesDir, `${ffig.ffig_id}.png`)
            await cropImage(renderResult.image_path, ffig.bbox, outPath)
          } catch (e: any) {
            log.error("crop formula figure failed", { ffigId: ffig.ffig_id, error: e.message })
          }
        }
      }

      // [I] 占位符替换
      const imagesRelDir = outputMode === "merged"
        ? path.basename(outputPaths.images)
        : "images"

      const finalContent = replacePlaceholders(
        currentContent,
        pageNum,
        figures,
        formulaFigures,
        imagesRelDir,
      )

      const pageResult: PageResult = {
        page_num: pageNum,
        has_text_layer: !!embeddedText,
        figures,
        formula_figures: formulaFigures,
        raw_content: textResult.content,
        final_content: finalContent,
        issues_detected: issueMessages,
        fixes_applied: fixesApplied,
        tokens: {
          input: 0,
          output: 0,
        },
      }
      pages.push(pageResult)

      yield {
        type: "page_done",
        page: pageNum,
        figureCount: figures.length + formulaFigures.length,
      }

      yield {
        type: "token",
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
      }
    }

    // Post-QA 质量检查（Phase 3）
    if (!abortSignal.aborted && pages.length > 0) {
      yield { type: "progress", currentPage: totalPages, totalPages, phase: "postqa" }

      const hasFigures = pages.some((p) => p.figures.length > 0 || p.formula_figures.length > 0)
      if (hasFigures) {
        try {
          const qaResult = await runPostQA(
            languageModel,
            pages,
            outputPaths.images,
            abortSignal,
          )
          totalInputTokens += qaResult.tokenInput
          totalOutputTokens += qaResult.tokenOutput
          if (qaResult.textOnlyFiguresFound > 0) {
            log.info("post-qa completed", {
              textOnlyFound: qaResult.textOnlyFiguresFound,
              pagesModified: qaResult.pagesModified,
            })
          }
        } catch (e: any) {
          log.error("post-qa failed", { error: e.message })
        }
      }
      // 推送 Post-QA 后的 token 统计
      yield { type: "token", input: totalInputTokens, output: totalOutputTokens, total: totalInputTokens + totalOutputTokens }
    }

    // 保存输出文件
    if (outputMode === "merged") {
      const mergedContent = assembleMergedMarkdown(pages)
      await saveMergedOutput(mergedContent, finalOutputPath)
    } else {
      await savePerPageOutput(pages, finalOutputPath)
    }

    // 保存结构化中间数据 JSON（供翻译等后续功能使用）
    const dataJson: ConvertDataJSON = {
      version: "1.0",
      source_pdf: path.basename(pdfPath),
      source_language: "auto",
      model: { provider: config.providerID, model: config.modelID },
      pages,
      output_mode: outputMode,
      total_tokens: { input: totalInputTokens, output: totalOutputTokens },
    }
    await fs.writeFile(outputPaths.dataJson, JSON.stringify(dataJson, null, 2), "utf-8")

    yield {
      type: "done",
      outputPath: finalOutputPath,
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    }
  } finally {
    // 清理临时目录
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // 忽略清理错误
    }
  }
}

/** 辅助：收集 AsyncGenerator 的所有事件并返回最终结果 */
async function collectGeneratorResult<T>(
  gen: AsyncGenerator<ProgressEvent, T>,
  onEvent?: (event: ProgressEvent) => void,
): Promise<T> {
  while (true) {
    const { value, done } = await gen.next()
    if (done) return value as T
    if (onEvent) onEvent(value as ProgressEvent)
  }
}

/** 创建失败页面占位 */
function createFailedPage(pageNum: number, errorMessage: string): PageResult {
  return {
    page_num: pageNum,
    has_text_layer: false,
    figures: [],
    formula_figures: [],
    raw_content: "",
    final_content: `<!-- 第 ${pageNum} 页转换失败：${errorMessage} -->`,
    issues_detected: [errorMessage],
    fixes_applied: [],
    tokens: { input: 0, output: 0 },
  }
}
