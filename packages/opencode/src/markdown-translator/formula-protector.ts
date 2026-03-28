/**
 * 公式保护器
 *
 * 在翻译前将数学公式和图片引用替换为不可翻译的占位符，翻译后再回填原始内容。
 * 直接从 Python 版 FormulaProtector 移植，保持完全一致的逻辑、正则表达式和处理顺序。
 */

export class FormulaProtector {
  private blockFormulas: string[] = []
  private inlineFormulas: string[] = []
  private imageRefs: string[] = []
  private figureHolders: string[] = []

  private static BLOCK_PLACEHOLDER = (idx: number) => `⟦FORMULA_BLOCK_${idx}⟧`
  private static INLINE_PLACEHOLDER = (idx: number) => `⟦FORMULA_INLINE_${idx}⟧`
  private static IMAGE_PLACEHOLDER = (idx: number) => `⟦IMAGE_REF_${idx}⟧`
  private static FIGURE_PLACEHOLDER = (idx: number) => `⟦FIG_HOLDER_${idx}⟧`

  /**
   * 提取所有公式和图片引用，替换为占位符。
   *
   * 处理顺序很重要：
   * 1. 图片引用 ![...](...)
   * 2. Figure 占位符 [FIGURE:fig_N] 和 [FORMULA_FIGURE:ffig_N]
   * 3. 块级公式 $$...$$ (必须先于行内，避免 $$ 被当作两个 $)
   * 4. 行内公式 $...$
   */
  protect(content: string): string {
    this.blockFormulas = []
    this.inlineFormulas = []
    this.imageRefs = []
    this.figureHolders = []

    // 1. 保护图片引用 ![...](...)
    content = content.replace(/!\[.*?\]\(.*?\)/g, (match) => {
      const idx = this.imageRefs.length
      this.imageRefs.push(match)
      return FormulaProtector.IMAGE_PLACEHOLDER(idx)
    })

    // 2. 保护 [FIGURE:fig_N] 和 [FORMULA_FIGURE:ffig_N] 占位符
    content = content.replace(/\[(?:FORMULA_)?FIGURE:f?fig_\d+\]/g, (match) => {
      const idx = this.figureHolders.length
      this.figureHolders.push(match)
      return FormulaProtector.FIGURE_PLACEHOLDER(idx)
    })

    // 3. 保护块级公式 $$...$$ (含多行)
    content = content.replace(/\$\$[\s\S]*?\$\$/g, (match) => {
      const idx = this.blockFormulas.length
      this.blockFormulas.push(match)
      return FormulaProtector.BLOCK_PLACEHOLDER(idx)
    })

    // 3b. 保护单 $ 块级公式（$ 独占一行作为开/关分隔符，常见于 PDF 转换产物）
    content = content.replace(/^\$\s*\n([\s\S]*?)\n\$\s*$/gm, (match) => {
      const idx = this.blockFormulas.length
      this.blockFormulas.push(match)
      return FormulaProtector.BLOCK_PLACEHOLDER(idx)
    })

    // 4. 保护行内公式 $...$ (不跨行)
    content = content.replace(/\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match) => {
      const idx = this.inlineFormulas.length
      this.inlineFormulas.push(match)
      return FormulaProtector.INLINE_PLACEHOLDER(idx)
    })

    return content
  }

  /**
   * 将翻译后的文本中的占位符回填为原始公式和图片引用。
   * 回填顺序与替换顺序相反。
   * 使用正则匹配以容错 LLM 可能损坏的占位符（如丢失闭合括号）。
   */
  restore(translated: string): string {
    // 回填行内公式（匹配 ⟦FORMULA_INLINE_N⟧ 或被截断的 ⟦FORMULA_INLINE_N）
    translated = translated.replace(/⟦FORMULA_INLINE_(\d+)⟧?/g, (_, idxStr) => {
      const idx = parseInt(idxStr)
      return idx < this.inlineFormulas.length ? this.inlineFormulas[idx] : _
    })

    // 回填块级公式
    translated = translated.replace(/⟦FORMULA_BLOCK_(\d+)⟧?/g, (_, idxStr) => {
      const idx = parseInt(idxStr)
      return idx < this.blockFormulas.length ? this.blockFormulas[idx] : _
    })

    // 回填图片引用
    translated = translated.replace(/⟦IMAGE_REF_(\d+)⟧?/g, (_, idxStr) => {
      const idx = parseInt(idxStr)
      return idx < this.imageRefs.length ? this.imageRefs[idx] : _
    })

    // 回填 FIGURE 占位符
    translated = translated.replace(/⟦FIG_HOLDER_(\d+)⟧?/g, (_, idxStr) => {
      const idx = parseInt(idxStr)
      return idx < this.figureHolders.length ? this.figureHolders[idx] : _
    })

    return translated
  }

  /**
   * 验证回填后的结果是否保留了所有原始公式。
   * 返回问题列表，为空表示通过。
   */
  verify(original: string, restored: string): string[] {
    const issues: string[] = []

    const originalBlocks = original.match(/\$\$[\s\S]*?\$\$/g) || []
    const restoredBlocks = restored.match(/\$\$[\s\S]*?\$\$/g) || []

    if (originalBlocks.length !== restoredBlocks.length) {
      issues.push(
        `块级公式数量不匹配：原始 ${originalBlocks.length} 个，翻译后 ${restoredBlocks.length} 个`,
      )
    }

    const originalInlines = original.match(/\$(?!\$)([^\$\n]+?)\$(?!\$)/g) || []
    const restoredInlines = restored.match(/\$(?!\$)([^\$\n]+?)\$(?!\$)/g) || []

    if (originalInlines.length !== restoredInlines.length) {
      issues.push(
        `行内公式数量不匹配：原始 ${originalInlines.length} 个，翻译后 ${restoredInlines.length} 个`,
      )
    }

    return issues
  }
}
