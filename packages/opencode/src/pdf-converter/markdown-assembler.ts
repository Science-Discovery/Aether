/**
 * Markdown 组装模块：占位符替换 + 文件输出
 */

import path from "path"
import type { PageResult, FigureInfo, FormulaFigureInfo } from "./types"
import { Log } from "../util/log"

const log = Log.create({ service: "markdown-assembler" })

/**
 * 替换单页 Markdown 中的占位符为图片引用
 *
 * 处理 figure_id 不匹配的情况：LLM 文本提取每页从 fig_1 编号，
 * 但 figure extraction 有时用文档全局编号（如 fig_2）。
 * 当精确匹配失败时，按占位符在内容中的出现顺序与 figures 数组顺序对应。
 */
export function replacePlaceholders(
  content: string,
  pageNum: number,
  figures: FigureInfo[],
  formulaFigures: FormulaFigureInfo[],
  imagesRelDir: string,
): string {
  let result = content
  const pageDir = `${imagesRelDir}/page_${String(pageNum).padStart(3, "0")}`
  const missingFigures: string[] = []

  // 收集内容中实际存在的 [FIGURE:fig_N] 占位符及其顺序
  const contentPlaceholders = [...result.matchAll(/\[FIGURE:(fig_\d+)\]/g)].map((m) => m[1])
  const matchedPlaceholders = new Set<string>()

  // 第一轮：精确匹配
  for (const fig of figures) {
    const placeholder = `[FIGURE:${fig.figure_id}]`
    if (result.includes(placeholder)) {
      const imgPath = `${pageDir}/${fig.figure_id}.png`
      const alt = fig.description || fig.caption || fig.figure_id
      result = result.replace(placeholder, `![${alt}](${imgPath})`)
      matchedPlaceholders.add(fig.figure_id)
    }
  }

  // 第二轮：模糊匹配 - 按顺序将未匹配的 figure 对应到未匹配的占位符
  const unmatchedFigures = figures.filter((f) => !matchedPlaceholders.has(f.figure_id))
  const unmatchedPlaceholders = contentPlaceholders.filter((p) => !matchedPlaceholders.has(p))

  for (let i = 0; i < unmatchedFigures.length; i++) {
    const fig = unmatchedFigures[i]
    const imgPath = `${pageDir}/${fig.figure_id}.png`
    const alt = fig.description || fig.caption || fig.figure_id
    const replacement = `![${alt}](${imgPath})`

    if (i < unmatchedPlaceholders.length) {
      // 有对应的未匹配占位符，替换它
      const placeholder = `[FIGURE:${unmatchedPlaceholders[i]}]`
      log.info("figure placeholder fuzzy-matched", {
        pageNum,
        figureId: fig.figure_id,
        matchedPlaceholder: unmatchedPlaceholders[i],
      })
      result = result.replace(placeholder, replacement)
    } else {
      // 没有可用的占位符，追加到末尾
      log.info("figure placeholder missing in content, will append", {
        pageNum,
        figureId: fig.figure_id,
      })
      missingFigures.push(replacement)
    }
  }

  // 替换 [FORMULA_FIGURE:ffig_N] → ![desc](images/page_X/ffig_N.png)
  for (const ffig of formulaFigures) {
    const placeholder = `[FORMULA_FIGURE:${ffig.ffig_id}]`
    const imgPath = `${pageDir}/${ffig.ffig_id}.png`
    const alt = ffig.description || ffig.ffig_id
    const replacement = `![${alt}](${imgPath})`

    if (result.includes(placeholder)) {
      result = result.replace(placeholder, replacement)
    } else {
      log.info("formula figure placeholder missing in content, will append", {
        pageNum,
        ffigId: ffig.ffig_id,
      })
      missingFigures.push(replacement)
    }
  }

  // 补救：将占位符丢失的图片追加到页面末尾
  if (missingFigures.length > 0) {
    result = result.trimEnd() + "\n\n" + missingFigures.join("\n\n") + "\n"
  }

  return result
}

/**
 * 修复 LaTeX 块级公式的格式问题，确保 marked + katex 能正确解析：
 * 1. 确保开头 $$ 前有空行（否则 marked 不会识别为独立 block）
 * 2. 确保闭合 $$ 后有空行
 * 3. 清理 $$ 后面的多余字符（如逗号、句号），这些会破坏 block regex
 *
 * block regex 要求格式：$$\n内容\n$$（中间不能有额外空行）
 */
export function sanitizeLatexBlocks(content: string): string {
  const lines = content.split("\n")
  const result: string[] = []
  let dollarCount = 0 // 已遇到的独占行 $$ 数量

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()

    // 处理 $$ 后面跟了多余字符的情况（如 "$$," → "$$"）
    if (/^\$\$[,;.，；。、]\s*$/.test(trimmed)) {
      // 当作闭合 $$
      result.push("$$")
      dollarCount++
      // 闭合后确保有空行
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined
      if (nextLine !== undefined && nextLine.trim() !== "") {
        result.push("")
      }
      continue
    }

    if (trimmed === "$$") {
      if (dollarCount % 2 === 0) {
        // 开头 $$：确保前面有空行
        if (result.length > 0 && result[result.length - 1].trim() !== "") {
          result.push("")
        }
      }
      result.push(lines[i])
      dollarCount++
      if (dollarCount % 2 === 0) {
        // 刚闭合：确保后面有空行
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined
        if (nextLine !== undefined && nextLine.trim() !== "") {
          result.push("")
        }
      }
      continue
    }

    result.push(lines[i])
  }

  return result.join("\n")
}

/**
 * 合并所有页面为一个 Markdown 文件
 */
export function assembleMergedMarkdown(pages: PageResult[]): string {
  const parts: string[] = []

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    if (page.final_content.trim()) {
      parts.push(page.final_content)
    }
  }

  // 用双换行连接各页
  let merged = parts.join("\n\n")

  // 跨页表格检测和合并
  merged = handleContinuationTables(merged)

  // 修复 LaTeX 块级公式格式
  merged = sanitizeLatexBlocks(merged)

  return merged
}

/** 跨页续表标记检测（5.4 节） */
const CONTINUATION_MARKERS = [
  /^\s*[（(]续[）)]\s*$/,
  /^\s*[（(]续表[）)]\s*$/,
  /^\s*[（(]continued[）)]\s*$/i,
  /^\s*[（(]cont['']?d?\.?[）)]\s*$/i,
  /^\s*续表\s*$/,
]

function handleContinuationTables(content: string): string {
  const lines = content.split("\n")
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isContinuation = CONTINUATION_MARKERS.some((re) => re.test(line))

    if (isContinuation) {
      // 检查上一个非空行是否是表格行
      let prevIdx = result.length - 1
      while (prevIdx >= 0 && result[prevIdx].trim() === "") prevIdx--

      if (prevIdx >= 0 && result[prevIdx].includes("|")) {
        // 跳过续表标记行，添加注释
        result.push("<!-- 续上表 -->")
        continue
      }
    }

    result.push(line)
  }

  return result.join("\n")
}

/**
 * 保存合并模式的输出文件
 */
export async function saveMergedOutput(
  mergedContent: string,
  outputPath: string,
): Promise<void> {
  log.info("saving merged markdown", { outputPath })
  await Bun.write(outputPath, mergedContent)
}

/**
 * 保存每页独立模式的输出文件
 */
export async function savePerPageOutput(
  pages: PageResult[],
  outputDir: string,
): Promise<void> {
  log.info("saving per-page markdown", { outputDir, pageCount: pages.length })

  // 创建输出目录
  const fs = await import("fs/promises")
  await fs.mkdir(outputDir, { recursive: true })

  for (const page of pages) {
    const filename = `page_${String(page.page_num).padStart(3, "0")}.md`
    const filePath = path.join(outputDir, filename)
    await Bun.write(filePath, sanitizeLatexBlocks(page.final_content))
  }
}
