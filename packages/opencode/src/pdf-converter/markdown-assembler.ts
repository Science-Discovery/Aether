/**
 * Markdown 组装模块：占位符替换 + 文件输出
 */

import path from "path"
import type { PageResult, FigureInfo, FormulaFigureInfo } from "./types"
import { Log } from "../util/log"

const log = Log.create({ service: "markdown-assembler" })

/**
 * 替换单页 Markdown 中的占位符为图片引用
 */
export function replacePlaceholders(
  content: string,
  pageNum: number,
  figures: FigureInfo[],
  formulaFigures: FormulaFigureInfo[],
  imagesRelDir: string,
): string {
  let result = content

  // 替换 [FIGURE:fig_N] → ![desc](images/page_X/fig_N.png)
  for (const fig of figures) {
    const placeholder = `[FIGURE:${fig.figure_id}]`
    const imgPath = `${imagesRelDir}/page_${String(pageNum).padStart(3, "0")}/${fig.figure_id}.png`
    const alt = fig.description || fig.caption || fig.figure_id
    result = result.replace(placeholder, `![${alt}](${imgPath})`)
  }

  // 替换 [FORMULA_FIGURE:ffig_N] → ![desc](images/page_X/ffig_N.png)
  for (const ffig of formulaFigures) {
    const placeholder = `[FORMULA_FIGURE:${ffig.ffig_id}]`
    const imgPath = `${imagesRelDir}/page_${String(pageNum).padStart(3, "0")}/${ffig.ffig_id}.png`
    const alt = ffig.description || ffig.ffig_id
    result = result.replace(placeholder, `![${alt}](${imgPath})`)
  }

  return result
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
    await Bun.write(filePath, page.final_content)
  }
}
