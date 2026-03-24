/**
 * Post-QA 质量检查模块
 *
 * 在所有页面转换完成后执行批量质检：
 * 1. 按批次（每 5 页一批）将 Markdown + 页面图片发给 LLM
 * 2. 检测纯文字图片 → 转录为 Markdown 替换图片引用
 * 3. 最多重试 2 次
 */

import { generateText } from "ai"
import type { LanguageModel } from "ai"
import { SINGLE_IMAGE_TEXT_ONLY_CHECK_PROMPT, buildTextOnlyFigureTranscribePrompt } from "./prompts"
import type { PageResult, ProgressEvent } from "./types"
import { parseJsonFromText } from "./util"
import { Log } from "../util/log"
import fs from "fs"

const log = Log.create({ service: "post-qa" })

const BATCH_SIZE = 5

interface PostQAResult {
  pagesModified: number
  textOnlyFiguresFound: number
  tokenInput: number
  tokenOutput: number
}

/**
 * 执行 Post-QA 质量检查
 */
export async function runPostQA(
  languageModel: LanguageModel,
  pages: PageResult[],
  imagesDir: string,
  abortSignal?: AbortSignal,
  onProgress?: (event: ProgressEvent) => void,
): Promise<PostQAResult> {
  let totalInput = 0
  let totalOutput = 0
  let textOnlyCount = 0
  let modifiedCount = 0

  // 收集所有带图片引用的页面
  const pagesWithFigures = pages.filter(
    (p) => p.figures.length > 0 || p.formula_figures.length > 0,
  )

  if (pagesWithFigures.length === 0) {
    return { pagesModified: 0, textOnlyFiguresFound: 0, tokenInput: 0, tokenOutput: 0 }
  }

  // 对每个图片进行纯文字检测
  for (const page of pagesWithFigures) {
    if (abortSignal?.aborted) break

    const pageDir = `${imagesDir}/page_${String(page.page_num).padStart(3, "0")}`

    for (const fig of page.figures) {
      if (abortSignal?.aborted) break

      const imagePath = `${pageDir}/${fig.figure_id}.png`
      if (!fs.existsSync(imagePath)) continue

      try {
        // 检查是否为纯文字图片
        const isTextOnly = await checkTextOnlyImage(languageModel, imagePath, abortSignal)
        totalInput += isTextOnly.tokenInput
        totalOutput += isTextOnly.tokenOutput

        if (isTextOnly.result) {
          textOnlyCount++
          log.info("text-only figure detected", {
            page: page.page_num,
            figureId: fig.figure_id,
          })

          // 尝试转录
          const transcription = await transcribeTextOnlyFigure(
            languageModel,
            imagePath,
            page.final_content,
            abortSignal,
          )
          totalInput += transcription.tokenInput
          totalOutput += transcription.tokenOutput

          if (transcription.text && !transcription.alreadyTranscribed) {
            // 替换图片引用为转录文本
            const imgRefPattern = new RegExp(
              `!\\[[^\\]]*\\]\\([^)]*${fig.figure_id}\\.png\\)`,
            )
            const newContent = page.final_content.replace(
              imgRefPattern,
              transcription.text,
            )
            if (newContent !== page.final_content) {
              page.final_content = newContent
              modifiedCount++
            }
          }
        }
      } catch (e: any) {
        log.error("post-qa check failed", {
          page: page.page_num,
          figureId: fig.figure_id,
          error: e.message,
        })
      }
    }
  }

  return {
    pagesModified: modifiedCount,
    textOnlyFiguresFound: textOnlyCount,
    tokenInput: totalInput,
    tokenOutput: totalOutput,
  }
}

/** 检查单张图片是否为纯文字区域 */
async function checkTextOnlyImage(
  languageModel: LanguageModel,
  imagePath: string,
  abortSignal?: AbortSignal,
): Promise<{ result: boolean; tokenInput: number; tokenOutput: number }> {
  const imageBuffer = fs.readFileSync(imagePath)
  const imageBase64 = imageBuffer.toString("base64")

  const result = await generateText({
    model: languageModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: SINGLE_IMAGE_TEXT_ONLY_CHECK_PROMPT },
          { type: "image", image: imageBase64 },
        ],
      },
    ],
    maxOutputTokens: 1024,
    abortSignal,
  })

  const usage = result.usage
  const parsed = parseJsonFromText<{ is_text_only: boolean }>(result.text)

  return {
    result: parsed?.is_text_only ?? false,
    tokenInput: usage?.inputTokens ?? 0,
    tokenOutput: usage?.outputTokens ?? 0,
  }
}

/** 将纯文字截图转录为 Markdown */
async function transcribeTextOnlyFigure(
  languageModel: LanguageModel,
  imagePath: string,
  pageContent: string,
  abortSignal?: AbortSignal,
): Promise<{
  text: string
  alreadyTranscribed: boolean
  tokenInput: number
  tokenOutput: number
}> {
  const imageBuffer = fs.readFileSync(imagePath)
  const imageBase64 = imageBuffer.toString("base64")
  const prompt = buildTextOnlyFigureTranscribePrompt(pageContent)

  const result = await generateText({
    model: languageModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", image: imageBase64 },
        ],
      },
    ],
    maxOutputTokens: 4096,
    abortSignal,
  })

  const usage = result.usage
  const parsed = parseJsonFromText<{
    already_transcribed: boolean
    transcription: string
  }>(result.text)

  return {
    text: parsed?.transcription ?? "",
    alreadyTranscribed: parsed?.already_transcribed ?? false,
    tokenInput: usage?.inputTokens ?? 0,
    tokenOutput: usage?.outputTokens ?? 0,
  }
}
