/**
 * LLM 图片 bbox 提取模块
 */

import { streamText } from "ai"
import type { LanguageModel } from "ai"
import { buildFigureOnlyPrompt, buildFormulaFigurePrompt } from "./prompts"
import type { FigureExtractionResult, FormulaFigureExtractionResult, ProgressEvent } from "./types"
import { parseJsonFromText } from "./util"
import { Log } from "../util/log"
import fs from "fs"

const log = Log.create({ service: "figure-extractor" })

export async function* extractFigures(
  languageModel: LanguageModel,
  pageImagePath: string,
  retryHints?: string[],
  abortSignal?: AbortSignal,
): AsyncGenerator<ProgressEvent, FigureExtractionResult> {
  const prompt = buildFigureOnlyPrompt(0.1, 1.5, retryHints)
  const imageBuffer = fs.readFileSync(pageImagePath)
  const imageBase64 = imageBuffer.toString("base64")

  log.info("extracting figures", { imagePath: pageImagePath })

  const result = streamText({
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

  let fullText = ""
  for await (const chunk of result.textStream) {
    fullText += chunk
    yield { type: "stream", content: chunk }
  }

  const usage = await result.usage
  yield {
    type: "token",
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    total: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  }

  const parsed = parseJsonFromText<FigureExtractionResult>(fullText)
  if (!parsed || !Array.isArray(parsed.figures)) {
    log.error("failed to parse figure extraction result", { fullText: fullText.slice(0, 200) })
    return { figures: [] }
  }

  return parsed
}

export async function* extractFormulaFigures(
  languageModel: LanguageModel,
  pageImagePath: string,
  formulaFigureCount: number,
  retryHints?: string[],
  abortSignal?: AbortSignal,
): AsyncGenerator<ProgressEvent, FormulaFigureExtractionResult> {
  const prompt = buildFormulaFigurePrompt(formulaFigureCount, retryHints)
  const imageBuffer = fs.readFileSync(pageImagePath)
  const imageBase64 = imageBuffer.toString("base64")

  log.info("extracting formula figures", { count: formulaFigureCount })

  const result = streamText({
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

  let fullText = ""
  for await (const chunk of result.textStream) {
    fullText += chunk
    yield { type: "stream", content: chunk }
  }

  const usage = await result.usage
  yield {
    type: "token",
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    total: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  }

  const parsed = parseJsonFromText<FormulaFigureExtractionResult>(fullText)
  if (!parsed || !Array.isArray(parsed.formula_figures)) {
    log.error("failed to parse formula figure result", { fullText: fullText.slice(0, 200) })
    return { formula_figures: [] }
  }

  return parsed
}
