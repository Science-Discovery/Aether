/**
 * LLM 文字提取模块：使用多模态 LLM 从 PDF 页面图片中提取文本
 */

import { streamText } from "ai"
import type { LanguageModel } from "ai"
import { buildTextPromptWithEmbeddedText } from "./prompts"
import type { TextExtractionResult, ProgressEvent } from "./types"
import { parseJsonFromText } from "./util"
import { Log } from "../util/log"
import fs from "fs"

const log = Log.create({ service: "text-extractor" })

export async function* extractText(
  languageModel: LanguageModel,
  pageImagePath: string,
  embeddedText: string | null,
  abortSignal?: AbortSignal,
): AsyncGenerator<ProgressEvent, TextExtractionResult> {
  const prompt = buildTextPromptWithEmbeddedText(embeddedText)
  const imageBuffer = fs.readFileSync(pageImagePath)
  const imageBase64 = imageBuffer.toString("base64")

  log.info("extracting text", { imagePath: pageImagePath })

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
    maxOutputTokens: 8192,
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

  // 解析 JSON 结果
  const parsed = parseJsonFromText<TextExtractionResult>(fullText)
  if (!parsed || typeof parsed.content !== "string") {
    log.error("failed to parse text extraction result", { fullText: fullText.slice(0, 200) })
    return {
      content: fullText,
      figure_count: 0,
    }
  }

  return {
    content: parsed.content,
    figure_count: parsed.figure_count ?? 0,
  }
}
