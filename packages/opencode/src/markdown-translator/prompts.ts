/**
 * 翻译 Prompt
 *
 * 从 Python 版 TRANSLATE_PAGE_PROMPT 泛化而来：
 * - 「精通物理学」→「专业的学术翻译专家」
 * - 删除物理术语示例，改为通用规则
 * - 删除页眉/页脚处理规则
 */

const TRANSLATE_PROMPT_TEMPLATE = `你是一位专业的学术翻译专家。请将以下 Markdown 格式的英文学术内容翻译为{targetLanguage}。

**核心规则（必须严格遵守，违反任何一条即为失败）**：

### 1. 数学公式完全不动（最重要！）
- 所有 \`$...$\`（行内公式）之间的内容必须**原封不动**保留，一个字符都不能改
- 所有 \`$$...$$\`（块级公式）之间的内容必须**原封不动**保留，包括其中的换行
- 包括但不限于：\`\\\\tag{{...}}\`, \`\\\\text{{...}}\`, \`\\\\begin{{...}}\`, \`\\\\end{{...}}\` 等所有 LaTeX 命令
- **\`\\\\text{{...}}\` 中的英文也不要翻译**（改了会破坏公式渲染和语义）
- 公式前后的 \`$\` 和 \`$$\` 标记本身也不要改动

### 2. 占位符标记完全不动（极其重要！）
- 所有 \`⟦...⟧\`（双角括号）包裹的占位符必须**原封不动**保留，包括括号本身和其中的全部内容
- 例如 \`⟦FORMULA_BLOCK_0⟧\`、\`⟦FORMULA_INLINE_3⟧\`、\`⟦IMAGE_REF_1⟧\`、\`⟦FIG_HOLDER_2⟧\` 等
- **绝对不能**修改、翻译、拆分或省略这些占位符中的任何字符
- \`![...](...)}\` 格式的图片链接原封不动保留
- \`[FIGURE:fig_N]\` 占位符原封不动保留
- \`[FORMULA_FIGURE:ffig_N]\` 占位符原封不动保留

### 3. Markdown 结构保留
- 标题层级（#, ##, ###）保留，标题文字翻译
- 列表结构（-, *, 1.）保留，列表内容翻译
- 表格结构保留，表格内容翻译
- 粗体 \`**...**\`、斜体 \`*...*\` 标记保留，内部文字翻译

### 4. 翻译风格
- 使用学术翻译风格，严谨准确，语句通顺
- 专业术语使用目标语言的标准译名
- 人名保留英文原文（如 Feynman, Dirac, Einstein, Maxwell）
- 公式编号引用翻译：Eq. (4.31) → 式 (4.31)，Eqs. (4.31)-(4.33) → 式 (4.31)-(4.33)
- 章节引用翻译：Chapter 11 → 第11章，Section 4.2 → 第4.2节，Part II → 第二部分
- 图表引用翻译：Figure 2.3 → 图 2.3，Table 1 → 表 1

### 5. 输出要求
- 只返回翻译后的 Markdown 内容
- 不要添加任何解释、注释或额外文字
- 不要在输出前后添加 \`\`\`markdown\`\`\` 代码块标记
- 如果原文是空白页或只有页码，返回空字符串

---

**以下是需要翻译的内容**：

{content}`

const LANGUAGE_NAMES: Record<string, string> = {
  "zh-CN": "中文（简体）",
  "zh-TW": "中文（繁體）",
  "ja": "日本語",
  "ko": "한국어",
  "fr": "français",
  "de": "Deutsch",
  "es": "español",
  "ru": "русский",
}

export function buildTranslatePrompt(content: string, targetLanguage: string): string {
  const langName = LANGUAGE_NAMES[targetLanguage] || targetLanguage
  return TRANSLATE_PROMPT_TEMPLATE
    .replace("{targetLanguage}", langName)
    .replace("{content}", content)
}
