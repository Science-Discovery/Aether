/**
 * 针对性修复模块：将检测到的问题发给 LLM 修复
 */

import { generateText } from "ai"
import type { LanguageModel } from "ai"
import { buildTextFixPrompt } from "./prompts"
import type { TextFixResult, ProgressEvent } from "./types"
import { parseJsonFromText } from "./util"
import { Log } from "../util/log"

const log = Log.create({ service: "targeted-fixer" })

/**
 * 针对性修复：将问题列表和原始内容发给 LLM，返回修复后的内容。
 * 最多调用 maxAttempts 次 LLM。
 */
export async function targetedFix(
  languageModel: LanguageModel,
  content: string,
  issues: string[],
  maxAttempts: number = 2,
  abortSignal?: AbortSignal,
): Promise<{ content: string; fixesApplied: string[]; tokenInput: number; tokenOutput: number }> {
  if (issues.length === 0) {
    return { content, fixesApplied: [], tokenInput: 0, tokenOutput: 0 }
  }

  let currentContent = content
  const allFixes: string[] = []
  let totalInput = 0
  let totalOutput = 0

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (abortSignal?.aborted) break

    const issuesText = issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")
    const prompt = buildTextFixPrompt(currentContent, issuesText)

    log.info("targeted fix attempt", { attempt: attempt + 1, issueCount: issues.length })

    try {
      const result = await generateText({
        model: languageModel,
        messages: [{ role: "user", content: prompt }],
        maxOutputTokens: 8192,
        abortSignal,
      })

      const usage = result.usage
      totalInput += usage?.inputTokens ?? 0
      totalOutput += usage?.outputTokens ?? 0

      const parsed = parseJsonFromText<TextFixResult>(result.text)
      if (parsed?.fixed_content) {
        currentContent = parsed.fixed_content
        if (parsed.fixes_applied) {
          allFixes.push(...parsed.fixes_applied)
        }
        break // 修复成功，退出
      } else {
        log.error("fix result parse failed", { attempt: attempt + 1 })
      }
    } catch (e: any) {
      log.error("targeted fix failed", { attempt: attempt + 1, error: e.message })
      break
    }
  }

  return {
    content: currentContent,
    fixesApplied: allFixes,
    tokenInput: totalInput,
    tokenOutput: totalOutput,
  }
}
