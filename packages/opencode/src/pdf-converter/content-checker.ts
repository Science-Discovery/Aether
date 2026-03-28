/**
 * 内容质量检测模块（移植自 content_checkers.py）
 *
 * 纯代码检测，不调用 LLM。
 */

export interface ContentIssue {
  type: "latex" | "truncation" | "control_char" | "completeness"
  message: string
}

/**
 * 检测 LLM 是否意外输出了思维过程而非转换结果
 */
export function isThinkingModeOutput(content: string): boolean {
  if (!content) return false

  // 早期退出：如果内容已有明显的 LaTeX 特征，不可能是思维链
  const indicators = ["$$", "\\tag{", "\\begin{", "\\frac{", "\\langle", "\\rangle", "\\mathbf{"]
  const indicatorCount = indicators.filter((ind) => content.includes(ind)).length
  if (indicatorCount >= 2) return false

  const thinkingPatterns = [
    "Let me think",
    "Let's think",
    "First, I need to",
    "First, let me",
    "I'll start by",
    "To solve this",
    "The question asks",
    "让我思考",
    "首先，我需要",
    "这道题问的是",
  ]

  const contentStart = content.slice(0, 500).toLowerCase()
  for (const pattern of thinkingPatterns) {
    if (contentStart.includes(pattern.toLowerCase())) return true
  }

  // 极短内容且不含 Markdown 特征时检查
  if (content.length < 200) {
    const hasMarkdown =
      content.split("$").length >= 3 ||
      content.includes("#") ||
      content.split("**").length >= 3 ||
      content.split("- ").length >= 3
    if (!hasMarkdown) {
      const start = content.slice(0, 500)
      if (["**A.", "**B.", "**C.", "1.", "2.", "3."].some((p) => start.includes(p))) {
        return true
      }
    }
  }

  return false
}

/**
 * 检测内容是否被结构性截断
 */
export function isContentTruncated(content: string): { truncated: boolean; reason: string } {
  if (!content?.trim()) return { truncated: false, reason: "" }

  const stripped = content.trim()

  // 检查1: $$ 块公式标记是否成对
  const doubleDollarCount = (stripped.match(/\$\$/g) || []).length
  if (doubleDollarCount % 2 !== 0) {
    return { truncated: true, reason: `块公式 $$ 未闭合（出现 ${doubleDollarCount} 次，应为偶数）` }
  }

  // 检查2: \begin{} 和 \end{} 数量是否匹配
  const beginCount = (stripped.match(/\\begin\{/g) || []).length
  const endCount = (stripped.match(/\\end\{/g) || []).length
  if (beginCount !== endCount) {
    return {
      truncated: true,
      reason: `LaTeX 环境未闭合（\\begin{} 出现 ${beginCount} 次，\\end{} 出现 ${endCount} 次）`,
    }
  }

  // 检查3: Markdown 代码块 ``` 是否成对
  const codeFenceCount = (stripped.match(/```/g) || []).length
  if (codeFenceCount % 2 !== 0) {
    return { truncated: true, reason: `Markdown 代码块未闭合（\`\`\` 出现 ${codeFenceCount} 次）` }
  }

  // 检查4: 最后一行是否以中文连接词结尾
  const lines = stripped.split("\n").filter((ln) => ln.trim())
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim()
    const isSpecial =
      lastLine.startsWith("#") ||
      lastLine.startsWith("---") ||
      lastLine.startsWith("|") ||
      lastLine.startsWith("![") ||
      lastLine.startsWith("```") ||
      lastLine === "$$" ||
      lastLine.endsWith("$$")
    if (!isSpecial && lastLine.length > 2) {
      const truncationEndPatterns = ["其中的", "其中", "以及", "即", "则", "而", "满足", "分别", "从而", "此时", "对于"]
      const chineseChars = [...lastLine].filter((c) => c >= "\u4e00" && c <= "\u9fff").length
      if (chineseChars > 3) {
        for (const pattern of truncationEndPatterns) {
          if (lastLine.endsWith(pattern)) {
            return { truncated: true, reason: `最后一行以「${pattern}」结尾，语句明显未完成` }
          }
        }
      }
    }
  }

  return { truncated: false, reason: "" }
}

/**
 * 检测公式内部是否残留控制字符
 */
export function hasControlCharsInFormulas(content: string): { hasIssue: boolean; reason: string } {
  if (!content?.trim()) return { hasIssue: false, reason: "" }

  const CONTROL_CHARS_RE = /[\x00-\x09\x0b-\x0d]/
  const charName = (code: number): string => {
    const names: Record<number, string> = { 0: "NULL", 8: "BS", 9: "TAB", 11: "VT", 12: "FF", 13: "CR" }
    return names[code] ?? `0x${code.toString(16).padStart(2, "0")}`
  }

  // 检查行内公式 $...$
  const inlineRe = /(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)/g
  let match
  while ((match = inlineRe.exec(content)) !== null) {
    const formula = match[1]
    const chars = [...formula].filter((c) => CONTROL_CHARS_RE.test(c))
    if (chars.length > 0) {
      const names = [...new Set(chars.map((c) => charName(c.charCodeAt(0))))].join(", ")
      return { hasIssue: true, reason: `行内公式中发现控制字符: ${names}（公式片段: $${formula.slice(0, 30)}$）` }
    }
  }

  // 检查块级公式 $$...$$
  const blockRe = /\$\$([\s\S]*?)\$\$/g
  while ((match = blockRe.exec(content)) !== null) {
    const formula = match[1]
    const chars = [...formula].filter((c) => CONTROL_CHARS_RE.test(c))
    if (chars.length > 0) {
      const names = [...new Set(chars.map((c) => charName(c.charCodeAt(0))))].join(", ")
      const snippet = formula.slice(0, 50).replace(/\n/g, " ")
      return { hasIssue: true, reason: `块级公式中发现控制字符: ${names}（公式片段: $$${snippet}...$$）` }
    }
  }

  return { hasIssue: false, reason: "" }
}

/**
 * LaTeX 语法验证（计划文档 6.6 节第 1 部分）
 */
export function checkLatexSyntax(content: string): ContentIssue[] {
  const issues: ContentIssue[] = []
  if (!content?.trim()) return issues

  // 1. 检测空公式 $$ $$ 或 $ $
  if (/\$\$\s*\$\$/.test(content)) {
    issues.push({ type: "latex", message: "存在空的块级公式 $$ $$" })
  }
  if (/(?<!\$)\$\s+\$(?!\$)/.test(content)) {
    issues.push({ type: "latex", message: "存在空的行内公式 $ $" })
  }

  // 2. 检测花括号不配对
  // 只检查公式区域
  const formulaRegions = extractFormulaRegions(content)
  for (const formula of formulaRegions) {
    let depth = 0
    for (const ch of formula) {
      if (ch === "{") depth++
      if (ch === "}") depth--
      if (depth < 0) break
    }
    if (depth !== 0) {
      const snippet = formula.slice(0, 50).replace(/\n/g, " ")
      issues.push({ type: "latex", message: `花括号不配对（公式片段: ${snippet}...）` })
      break // 只报第一个
    }
  }

  // 3. 检测 \eqno 误用
  if (/\\eqno\s*[({]/.test(content)) {
    issues.push({ type: "latex", message: "使用了 \\eqno（应为 \\tag{}）" })
  }

  // 4. 检测 \left / \right 不配对
  for (const formula of formulaRegions) {
    const leftCount = (formula.match(/\\left\b/g) || []).length
    const rightCount = (formula.match(/\\right\b/g) || []).length
    if (leftCount !== rightCount) {
      issues.push({
        type: "latex",
        message: `\\left (${leftCount}) 与 \\right (${rightCount}) 不配对`,
      })
      break
    }
  }

  // 5. 检测公式中的 \n 字面量残留
  for (const formula of formulaRegions) {
    if (/(?<!\\)\\n[A-Za-z]/.test(formula)) {
      issues.push({ type: "latex", message: "公式中存在 \\n 字面量残留" })
      break
    }
  }

  // 6. 检测块级公式 $$ 未独占一行
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // 检查 $$ 之前有非空白字符（排除行首的 $$）
    if (/\S\s*\$\$/.test(line) && !trimmed.startsWith("$$") && !trimmed.endsWith("$$")) {
      // 确保不是行内公式
      if (trimmed.includes("$$") && !trimmed.match(/^\$\$/) && !trimmed.match(/\$\$$/)) {
        issues.push({ type: "latex", message: `第 ${i + 1} 行：块级公式 $$ 未独占一行` })
        break
      }
    }
    // 检测 $$ 后面跟了多余字符（如逗号、句号），这会破坏 KaTeX block 解析
    if (/^\$\$[,;.，；。、]/.test(trimmed)) {
      issues.push({ type: "latex", message: `第 ${i + 1} 行：$$ 后面跟了多余字符「${trimmed.slice(2, 3)}」，应去除` })
    }
  }

  return issues
}

/**
 * 内容完整性检查（计划文档 6.6 节第 2 部分）
 */
export function checkContentCompleteness(content: string, figureCount: number): ContentIssue[] {
  const issues: ContentIssue[] = []
  if (!content?.trim()) return issues

  // 1. figure_count 与实际 [FIGURE:fig_N] 占位符数量是否匹配
  const figurePlaceholders = content.match(/\[FIGURE:fig_\d+\]/g) || []
  if (figurePlaceholders.length !== figureCount) {
    issues.push({
      type: "completeness",
      message: `figure_count=${figureCount} 与实际占位符数量 ${figurePlaceholders.length} 不匹配`,
    })
  }

  // 2. 检测文字是否在 [FIGURE:fig_N] 后截断
  // 如果内容以 [FIGURE:fig_N] 结尾（后面没有更多文字），可能截断了
  const trimmed = content.trim()
  if (/\[FIGURE:fig_\d+\]\s*$/.test(trimmed) && trimmed.length > 100) {
    issues.push({
      type: "completeness",
      message: "内容以 [FIGURE] 占位符结尾，后续文字可能被截断",
    })
  }

  // 3. 检测 [FORMULA_FIGURE:ffig_N] 的数量
  const ffigPlaceholders = content.match(/\[FORMULA_FIGURE:ffig_\d+\]/g) || []
  // 这里只统计，在主流程中会使用此数量

  return issues
}

/**
 * 综合运行所有检查，返回所有检测到的问题
 */
export function runAllChecks(content: string, figureCount: number): ContentIssue[] {
  const issues: ContentIssue[] = []

  // 思维链检测
  if (isThinkingModeOutput(content)) {
    issues.push({ type: "completeness", message: "LLM 输出为思维链而非转换结果" })
  }

  // 截断检测
  const truncation = isContentTruncated(content)
  if (truncation.truncated) {
    issues.push({ type: "truncation", message: truncation.reason })
  }

  // 控制字符检测
  const controlChars = hasControlCharsInFormulas(content)
  if (controlChars.hasIssue) {
    issues.push({ type: "control_char", message: controlChars.reason })
  }

  // LaTeX 语法检查
  issues.push(...checkLatexSyntax(content))

  // 内容完整性检查
  issues.push(...checkContentCompleteness(content, figureCount))

  return issues
}

/** 辅助：从内容中提取所有公式区域 */
function extractFormulaRegions(content: string): string[] {
  const regions: string[] = []

  // 块级公式
  const blockRe = /\$\$([\s\S]*?)\$\$/g
  let m
  while ((m = blockRe.exec(content)) !== null) {
    regions.push(m[1])
  }

  // 行内公式
  const inlineRe = /(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)/g
  while ((m = inlineRe.exec(content)) !== null) {
    regions.push(m[1])
  }

  return regions
}
