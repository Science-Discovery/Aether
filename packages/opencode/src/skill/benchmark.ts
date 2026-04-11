import { Catalog } from "./catalog"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"

const pool = {
  "paper-polish": {
    id: "eyh0602/skillshub@paper-polish",
    name: "paper-polish",
    source: "eyh0602/skillshub",
    rank: "exact" as const,
    body: "Polish and revise academic papers in LaTeX format. Use this skill when revising, polishing, or editing an existing manuscript for journal or conference submission.",
    summary_source: "skill_md" as const,
    terms: ["论文", "LaTeX", "学术", "润色"],
  },
  "professional-proofreader": {
    id: "writer/skills@professional-proofreader",
    name: "professional-proofreader",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.",
    summary_source: "skill_md" as const,
    terms: ["校对", "英文", "润色", "稿件"],
  },
  "ai-proofreading": {
    id: "ai/skills@ai-proofreading",
    name: "ai-proofreading",
    source: "ai/skills",
    rank: "semantic" as const,
    body: "Proofread English text, fix grammar, and improve wording for articles, reports, and drafts.",
    summary_source: "skills_summary" as const,
    terms: ["校对", "语法", "润色", "英文"],
  },
  "copy-editing": {
    id: "editing/skills@copy-editing",
    name: "copy-editing",
    source: "editing/skills",
    rank: "semantic" as const,
    body: "Copy-edit English writing for grammar, tone, and clarity. Best for essays, reports, and editorial polish.",
    summary_source: "skill_md" as const,
    terms: ["校对", "语法", "措辞", "润色"],
  },
  "english-proofreading": {
    id: "proof/skills@english-proofreading",
    name: "english-proofreading",
    source: "proof/skills",
    rank: "semantic" as const,
    body: "Proofread English-language writing, improve grammar, and tighten phrasing for professional communication.",
    summary_source: "skill_md" as const,
    terms: ["英文", "校对", "润色"],
  },
  "huashu-proofreading": {
    id: "huashu/skills@huashu-proofreading",
    name: "huashu-proofreading",
    source: "huashu/skills",
    rank: "semantic" as const,
    body: "Proofread text and refine wording for polished written communication.",
    summary_source: "skill_md" as const,
    terms: ["校对", "润色", "措辞"],
  },
  "video-editing": {
    id: "blitzreels/agent-skills@video-editing",
    name: "video-editing",
    source: "blitzreels/agent-skills",
    rank: "semantic" as const,
    body: "Edit short-form videos and multimedia clips for publishing workflows.",
    summary_source: "skill_md" as const,
    terms: ["视频", "多媒体"],
  },
  "ui-ux-polish": {
    id: "oakoss/agent-skills@ui-ux-polish",
    name: "ui-ux-polish",
    source: "oakoss/agent-skills",
    rank: "semantic" as const,
    body: "Polish interface details, layout rhythm, and UX presentation for product surfaces.",
    summary_source: "skill_md" as const,
    terms: ["界面", "UX", "体验"],
  },
  "find-skills": {
    id: "vercel-labs/skills@find-skills",
    name: "find-skills",
    source: "vercel-labs/skills",
    rank: "semantic" as const,
    body: "Discover and install specialized agent skills from the open ecosystem with the Skills CLI.",
    summary_source: "skills_summary" as const,
    terms: ["搜索", "发现", "安装", "技能"],
  },
  "code-polish": {
    id: "paulrberg/agent-skills@code-polish",
    name: "code-polish",
    source: "paulrberg/agent-skills",
    rank: "semantic" as const,
    body: "Polish and refactor source code for readability, naming, and consistency.",
    summary_source: "skill_md" as const,
    terms: ["代码", "重构", "可读性"],
  },
  humanizer: {
    id: "writer/skills@humanizer",
    name: "humanizer",
    source: "writer/skills",
    rank: "exact" as const,
    body: "Rewrite text so it sounds more natural, human, and less AI-generated.",
    summary_source: "skill_md" as const,
    terms: ["自然", "人类", "改写", "人味"],
  },
  "humanizer-cn": {
    id: "writer/skills@humanizer-cn",
    name: "humanizer-cn",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "让中文文本更自然、更像人类书写，降低 AI 痕迹。",
    summary_source: "skill_md" as const,
    terms: ["自然", "中文", "人类", "AI"],
  },
  "writing-humanizer": {
    id: "writer/skills@writing-humanizer",
    name: "writing-humanizer",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "Humanize drafted writing by adjusting tone, flow, and natural phrasing.",
    summary_source: "skill_md" as const,
    terms: ["自然", "语气", "改写", "人类"],
  },
  "writing-humanizer-zh": {
    id: "writer/skills@writing-humanizer-zh",
    name: "writing-humanizer-zh",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "将中文写作改得更自然、更口语化，减少 AI 风格。",
    summary_source: "skill_md" as const,
    terms: ["自然", "中文", "口语", "AI"],
  },
  "humanize-academic-writing": {
    id: "writer/skills@humanize-academic-writing",
    name: "humanize-academic-writing",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "Make academic writing sound more natural while preserving scholarly tone and structure.",
    summary_source: "skill_md" as const,
    terms: ["学术", "自然", "写作"],
  },
  copywriting: {
    id: "writer/skills@copywriting",
    name: "copywriting",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "Write or rewrite marketing copy for clearer positioning and stronger conversion.",
    summary_source: "skill_md" as const,
    terms: ["文案", "改写", "营销"],
  },
  "docs-translation": {
    id: "translator/skills@docs-translation",
    name: "docs-translation",
    source: "translator/skills",
    rank: "semantic" as const,
    body: "Translate technical documentation, API guides, and product docs between Chinese and English.",
    summary_source: "skill_md" as const,
    terms: ["翻译", "技术", "文档", "中英"],
  },
  "paper-translation": {
    id: "translator/skills@paper-translation",
    name: "paper-translation",
    source: "translator/skills",
    rank: "semantic" as const,
    body: "Translate academic manuscripts and research papers while preserving scholarly terminology and tone.",
    summary_source: "skill_md" as const,
    terms: ["翻译", "论文", "学术", "术语"],
  },
  "subtitle-translation": {
    id: "media/skills@subtitle-translation",
    name: "subtitle-translation",
    source: "media/skills",
    rank: "semantic" as const,
    body: "Translate video subtitles and multilingual captions for short-form media workflows.",
    summary_source: "skill_md" as const,
    terms: ["翻译", "字幕", "视频", "多媒体"],
  },
  "manuscript-review": {
    id: "review/skills@manuscript-review",
    name: "manuscript-review",
    source: "review/skills",
    rank: "semantic" as const,
    body: "Review manuscript structure, argument flow, and submission readiness for academic papers.",
    summary_source: "skill_md" as const,
    terms: ["稿件", "论文", "审阅", "学术"],
  },
  "writing-rewrite": {
    id: "writer/skills@writing-rewrite",
    name: "writing-rewrite",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "Rewrite drafts for smoother flow, more natural tone, and human-sounding prose.",
    summary_source: "skill_md" as const,
    terms: ["改写", "自然", "人类", "语气"],
  },
  "skills-updater": {
    id: "yizhiyanhua-ai/skills-updater@skills-updater",
    name: "skills-updater",
    source: "yizhiyanhua-ai/skills-updater",
    rank: "exact" as const,
    body: "Check installed skills, detect available updates, and refresh them with the Skills CLI.",
    summary_source: "skill_md" as const,
    terms: ["更新", "检查", "技能", "刷新"],
  },
  "auto-updater": {
    id: "skills.volces.com@auto-updater",
    name: "auto-updater",
    source: "skills.volces.com",
    rank: "exact" as const,
    body: "Automatically update installed skills and keep the local skill set in sync.",
    summary_source: "skill_md" as const,
    terms: ["自动", "更新", "同步"],
  },
  "playwright-cli": {
    id: "microsoft/playwright-cli@playwright-cli",
    name: "playwright-cli",
    source: "microsoft/playwright-cli",
    rank: "semantic" as const,
    body: "Automate browser interactions, inspect pages, and run UI checks.",
    summary_source: "skill_md" as const,
    terms: ["浏览器", "自动化", "检查"],
  },
  "md-to-pdf": {
    id: "local/skills@md-to-pdf",
    name: "md-to-pdf",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Convert markdown files to PDF using Chrome for shareable document output.",
    summary_source: "skill_md" as const,
    terms: ["markdown", "pdf", "导出", "打印"],
  },
  pandoc: {
    id: "local/skills@pandoc",
    name: "pandoc",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Convert documents between Markdown, DOCX, PDF, HTML, and LaTeX with pandoc.",
    summary_source: "skill_md" as const,
    terms: ["转换", "markdown", "pdf", "docx"],
  },
  "minimax-pdf": {
    id: "local/skills@minimax-pdf",
    name: "minimax-pdf",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Create polished PDFs, restyle documents, or fill PDF forms with a design system.",
    summary_source: "skill_md" as const,
    terms: ["pdf", "设计", "报告", "文档"],
  },
  revealjs: {
    id: "local/skills@revealjs",
    name: "revealjs",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Create polished reveal.js presentations with themes, layouts, notes, and custom styling.",
    summary_source: "skill_md" as const,
    terms: ["slides", "演示", "html", "reveal"],
  },
  "frontend-slides": {
    id: "local/skills@frontend-slides",
    name: "frontend-slides",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Build animation-rich HTML presentations and convert decks into web slides.",
    summary_source: "skill_md" as const,
    terms: ["slides", "动画", "网页", "演示"],
  },
  "pptx-generator": {
    id: "local/skills@pptx-generator",
    name: "pptx-generator",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Generate, edit, and read PowerPoint presentations and slide decks.",
    summary_source: "skill_md" as const,
    terms: ["ppt", "powerpoint", "幻灯片", "演示"],
  },
  "scientific-slides": {
    id: "local/skills@scientific-slides",
    name: "scientific-slides",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Build slide decks for research talks, conference presentations, and thesis defenses.",
    summary_source: "skill_md" as const,
    terms: ["科研", "slides", "演讲", "答辩"],
  },
  "paper-2-web": {
    id: "local/skills@paper-2-web",
    name: "paper-2-web",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Turn academic papers into interactive websites, videos, and conference posters.",
    summary_source: "skill_md" as const,
    terms: ["论文", "网站", "展示", "poster"],
  },
  "latex-paper-en": {
    id: "local/skills@latex-paper-en",
    name: "latex-paper-en",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Compile, lint, proofread, and improve English LaTeX papers for submission.",
    summary_source: "skill_md" as const,
    terms: ["latex", "英文", "论文", "投稿"],
  },
} as const

function pickItems(ids: Array<keyof typeof pool>) {
  return ids.map((id) => pool[id])
}

export const cases = [
  {
    id: "paper-polish-zh",
    query: "找一下论文润色的skill",
    must_have: ["paper-polish", "professional-proofreader"],
    good_to_have: ["ai-proofreading", "copy-editing", "english-proofreading", "huashu-proofreading"],
    must_not_have: ["video-editing", "ui-ux-polish", "find-skills"],
    fixture: pickItems([
      "paper-polish",
      "professional-proofreader",
      "ai-proofreading",
      "copy-editing",
      "english-proofreading",
      "huashu-proofreading",
      "video-editing",
      "ui-ux-polish",
      "find-skills",
      "code-polish",
    ]),
  },
  {
    id: "humanizer-zh",
    query: "找一下更有人味的skill",
    must_have: ["humanizer", "humanizer-cn", "writing-humanizer", "writing-humanizer-zh"],
    good_to_have: ["humanize-academic-writing", "copywriting"],
    must_not_have: ["video-editing", "paper-polish", "find-skills"],
    fixture: pickItems([
      "humanizer",
      "humanizer-cn",
      "writing-humanizer",
      "writing-humanizer-zh",
      "humanize-academic-writing",
      "copywriting",
      "paper-polish",
      "video-editing",
      "find-skills",
    ]),
  },
  {
    id: "updater-zh",
    query: "找一下自动更新的skill",
    must_have: ["skills-updater", "auto-updater", "find-skills"],
    good_to_have: ["playwright-cli"],
    must_not_have: ["paper-polish", "video-editing", "humanizer"],
    fixture: pickItems([
      "skills-updater",
      "auto-updater",
      "find-skills",
      "playwright-cli",
      "paper-polish",
      "video-editing",
      "humanizer",
      "code-polish",
    ]),
  },
  {
    id: "paper-polish-en",
    query: "paper polish skill",
    must_have: ["paper-polish", "professional-proofreader"],
    good_to_have: ["ai-proofreading", "copy-editing"],
    must_not_have: ["video-editing", "ui-ux-polish", "find-skills"],
    fixture: pickItems([
      "paper-polish",
      "professional-proofreader",
      "ai-proofreading",
      "copy-editing",
      "video-editing",
      "ui-ux-polish",
      "find-skills",
      "code-polish",
    ]),
  },
  {
    id: "proofread-en",
    query: "proofread manuscript",
    must_have: ["professional-proofreader", "english-proofreading"],
    good_to_have: ["ai-proofreading", "paper-polish", "copy-editing"],
    must_not_have: ["video-editing", "find-skills", "ui-ux-polish"],
    fixture: pickItems([
      "professional-proofreader",
      "english-proofreading",
      "ai-proofreading",
      "paper-polish",
      "copy-editing",
      "video-editing",
      "find-skills",
      "ui-ux-polish",
    ]),
  },
  {
    id: "exact-skill",
    query: "ai-proofreading",
    must_have: ["ai-proofreading"],
    good_to_have: ["english-proofreading"],
    must_not_have: ["video-editing", "find-skills"],
    fixture: pickItems(["ai-proofreading", "english-proofreading", "video-editing", "find-skills"]),
  },
  {
    id: "humanizer-en",
    query: "make this writing sound more human",
    must_have: ["humanizer", "writing-humanizer"],
    good_to_have: ["writing-rewrite", "copywriting", "humanizer-cn"],
    must_not_have: ["video-editing", "paper-polish", "find-skills"],
    fixture: pickItems([
      "humanizer",
      "writing-humanizer",
      "writing-rewrite",
      "copywriting",
      "humanizer-cn",
      "paper-polish",
      "video-editing",
      "find-skills",
    ]),
  },
  {
    id: "tool-search-zh",
    query: "找一下搜索和安装skill的工具",
    must_have: ["find-skills"],
    good_to_have: ["skills-updater", "auto-updater"],
    must_not_have: ["paper-polish", "video-editing", "humanizer"],
    fixture: pickItems([
      "find-skills",
      "skills-updater",
      "auto-updater",
      "playwright-cli",
      "paper-polish",
      "video-editing",
      "humanizer",
    ]),
  },
  {
    id: "translate-zh",
    query: "找个翻译技术文档的skill",
    must_have: ["docs-translation"],
    good_to_have: ["paper-translation"],
    must_not_have: ["subtitle-translation", "video-editing", "find-skills"],
    fixture: pickItems([
      "docs-translation",
      "paper-translation",
      "subtitle-translation",
      "video-editing",
      "find-skills",
      "copywriting",
    ]),
  },
  {
    id: "translate-paper-zh",
    query: "找一下翻译论文的skill",
    must_have: ["paper-translation"],
    good_to_have: ["docs-translation", "manuscript-review"],
    must_not_have: ["subtitle-translation", "video-editing", "find-skills"],
    fixture: pickItems([
      "paper-translation",
      "docs-translation",
      "manuscript-review",
      "subtitle-translation",
      "video-editing",
      "find-skills",
    ]),
  },
  {
    id: "translate-en",
    query: "translate technical docs",
    must_have: ["docs-translation"],
    good_to_have: ["paper-translation"],
    must_not_have: ["subtitle-translation", "video-editing", "find-skills"],
    fixture: pickItems([
      "docs-translation",
      "paper-translation",
      "subtitle-translation",
      "video-editing",
      "find-skills",
      "copywriting",
    ]),
  },
  {
    id: "exact-updater",
    query: "auto-updater",
    must_have: ["auto-updater"],
    good_to_have: ["skills-updater", "find-skills"],
    must_not_have: ["paper-polish", "humanizer"],
    fixture: pickItems([
      "auto-updater",
      "skills-updater",
      "find-skills",
      "paper-polish",
      "humanizer",
    ]),
  },
  {
    id: "exact-humanizer-cn",
    query: "humanizer-cn",
    must_have: ["humanizer-cn"],
    good_to_have: ["writing-humanizer-zh", "humanizer"],
    must_not_have: ["paper-polish", "find-skills", "video-editing"],
    fixture: pickItems([
      "humanizer-cn",
      "writing-humanizer-zh",
      "humanizer",
      "paper-polish",
      "find-skills",
      "video-editing",
    ]),
  },
  {
    id: "browser-zh",
    query: "找个能自动操作浏览器点页面的 skill",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "md-to-pdf", "revealjs"],
    fixture: pickItems([
      "playwright-cli",
      "find-skills",
      "paper-polish",
      "md-to-pdf",
      "revealjs",
      "code-polish",
    ]),
  },
  {
    id: "browser-en",
    query: "browser automation cli",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "pptx-generator", "find-skills"],
    fixture: pickItems([
      "playwright-cli",
      "find-skills",
      "paper-polish",
      "pptx-generator",
      "md-to-pdf",
      "code-polish",
    ]),
  },
  {
    id: "exact-playwright",
    query: "playwright-cli",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "md-to-pdf", "find-skills"],
    fixture: pickItems([
      "playwright-cli",
      "find-skills",
      "paper-polish",
      "md-to-pdf",
      "pptx-generator",
    ]),
  },
  {
    id: "pdf-zh",
    query: "把 markdown 导出成 pdf 的 skill",
    must_have: ["md-to-pdf"],
    good_to_have: ["pandoc", "minimax-pdf"],
    must_not_have: ["revealjs", "pptx-generator", "find-skills"],
    fixture: pickItems([
      "md-to-pdf",
      "pandoc",
      "minimax-pdf",
      "revealjs",
      "pptx-generator",
      "find-skills",
      "playwright-cli",
    ]),
  },
  {
    id: "pdf-en",
    query: "convert markdown to pdf",
    must_have: ["md-to-pdf"],
    good_to_have: ["pandoc", "minimax-pdf"],
    must_not_have: ["revealjs", "pptx-generator", "find-skills"],
    fixture: pickItems([
      "md-to-pdf",
      "pandoc",
      "minimax-pdf",
      "revealjs",
      "pptx-generator",
      "find-skills",
      "playwright-cli",
    ]),
  },
  {
    id: "slides-zh",
    query: "找个做 html 幻灯片的 skill",
    must_have: ["frontend-slides", "revealjs"],
    good_to_have: ["scientific-slides", "pptx-generator"],
    must_not_have: ["md-to-pdf", "paper-polish", "find-skills"],
    fixture: pickItems([
      "frontend-slides",
      "revealjs",
      "scientific-slides",
      "pptx-generator",
      "paper-2-web",
      "md-to-pdf",
      "paper-polish",
      "find-skills",
    ]),
  },
  {
    id: "slides-en",
    query: "build interactive slides",
    must_have: ["frontend-slides", "revealjs"],
    good_to_have: ["scientific-slides", "pptx-generator"],
    must_not_have: ["md-to-pdf", "paper-polish", "find-skills"],
    fixture: pickItems([
      "frontend-slides",
      "revealjs",
      "scientific-slides",
      "pptx-generator",
      "paper-2-web",
      "md-to-pdf",
      "paper-polish",
      "find-skills",
    ]),
  },
  {
    id: "pptx-en",
    query: "generate powerpoint deck",
    must_have: ["pptx-generator"],
    good_to_have: ["scientific-slides", "frontend-slides"],
    must_not_have: ["md-to-pdf", "paper-polish", "find-skills"],
    fixture: pickItems([
      "pptx-generator",
      "scientific-slides",
      "frontend-slides",
      "revealjs",
      "md-to-pdf",
      "paper-polish",
      "find-skills",
    ]),
  },
  {
    id: "paper-web-en",
    query: "turn a paper into a website",
    must_have: ["paper-2-web"],
    good_to_have: ["frontend-slides", "revealjs"],
    must_not_have: ["md-to-pdf", "humanizer", "find-skills"],
    fixture: pickItems([
      "paper-2-web",
      "frontend-slides",
      "revealjs",
      "scientific-slides",
      "md-to-pdf",
      "humanizer",
      "find-skills",
    ]),
  },
  {
    id: "latex-en",
    query: "improve an english latex paper",
    must_have: ["latex-paper-en"],
    good_to_have: ["paper-polish", "professional-proofreader"],
    must_not_have: ["md-to-pdf", "revealjs", "find-skills"],
    fixture: pickItems([
      "latex-paper-en",
      "paper-polish",
      "professional-proofreader",
      "ai-proofreading",
      "md-to-pdf",
      "revealjs",
      "find-skills",
    ]),
  },
] as const

type Case = (typeof cases)[number]
type Mode = "rerank" | "live" | "both"
type Score = {
  model: string
  total: number
  breakdown: {
    precision_main: number
    must_not_penalty: number
    recall_main: number
    summary_faithfulness: number
    latency: number
    stability: number
  }
}

type Run = {
  main: string[]
  more: string[]
  latency_ms: number
  faithfulness: number
}

type Detail = {
  id: string
  query: string
  run: Run[]
  total: number
  breakdown: Score["breakdown"]
}

type Row = Score & { avg_latency_ms: number }
type Report = {
  mode: Exclude<Mode, "both">
  rows: Row[]
  markdown: string
  winner?: string
  fail_examples: Array<{
    model: string
    case: string
    main: string[]
    more: string[]
    total: number
  }>
}

function overlap(left: string[], right: string[]) {
  const a = new Set(left)
  const b = new Set(right)
  const both = [...a].filter((item) => b.has(item)).length
  const size = new Set([...a, ...b]).size
  return size ? both / size : 1
}

function points(value: number, max: number) {
  return Math.max(0, Math.min(max, Math.round(value * max * 100) / 100))
}

function faith(input: Case, main: Array<{ name: string; summary_zh?: string }>) {
  const terms = new Map<string, readonly string[]>(input.fixture.map((item) => [item.name, item.terms as readonly string[]]))
  const good = new Set<string>([...input.must_have, ...input.good_to_have])
  const rows = main.filter((item) => good.has(item.name))
  if (rows.length === 0) return 0
  const hit = rows.filter((item) => {
    const text = item.summary_zh ?? ""
    const keys = terms.get(item.name) ?? []
    return keys.some((key) => text.includes(key))
  }).length
  return hit / rows.length
}

export function rank(input: Case, run: Run) {
  const good = new Set<string>([...input.must_have, ...input.good_to_have])
  const bad = new Set<string>(input.must_not_have)
  const main = new Set(run.main)
  const more = new Set(run.more)
  const hit = run.main.filter((item) => good.has(item)).length
  const blocked = run.main.filter((item) => bad.has(item)).length
  const need = input.must_have.filter((item) => main.has(item)).length
  const extra = [...more].filter((item) => good.has(item)).length
  const precision_main = points(run.main.length ? hit / run.main.length : 0, 40)
  const must_not_penalty = points(run.main.length ? 1 - blocked / run.main.length : 1, 20)
  const recall_main = points(input.must_have.length ? need / input.must_have.length : 1, 15)
  const summary_faithfulness = points(run.faithfulness, 15)
  const latency = run.latency_ms <= 4_000 ? 5 : run.latency_ms <= 7_000 ? 3 : run.latency_ms <= 10_000 ? 1 : 0
  const stability = points(extra ? Math.min(1, 0.6 + extra / Math.max(1, input.good_to_have.length + input.must_have.length)) : 0.6, 5)
  const total = precision_main + must_not_penalty + recall_main + summary_faithfulness + latency + stability
  return {
    total,
    breakdown: {
      precision_main,
      must_not_penalty,
      recall_main,
      summary_faithfulness,
      latency,
      stability,
    },
  }
}

export function table<T extends Score>(input: T[]) {
  return input.toSorted((a, b) => b.total - a.total)
}

function parse(input: string) {
  const idx = input.indexOf("/")
  if (idx <= 0 || idx === input.length - 1) return
  return {
    providerID: ProviderID.make(input.slice(0, idx)),
    modelID: ModelID.make(input.slice(idx + 1)),
  }
}

function print(input: { providerID: ProviderID; modelID: ModelID }) {
  return `${input.providerID}/${input.modelID}`
}

async function models() {
  const providers = await Provider.list()
  return Object.values(providers)
    .filter((item) => item.id === "opencode")
    .flatMap((item) => Object.values(item.models))
    .map((item) => ({
      providerID: item.providerID,
      modelID: ModelID.make(item.id),
    }))
}

function markdown(mode: Exclude<Mode, "both">, input: Row[]) {
  return [
    `## ${mode === "rerank" ? "Rerank Benchmark" : "Live Benchmark"}`,
    "",
    "| Rank | Model | Total | Precision | Must-Not | Recall | Faithful | Latency | Stability | Avg ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...input.map((item, idx) =>
      [
        `| ${idx + 1}`,
        item.model,
        item.total.toFixed(2),
        item.breakdown.precision_main.toFixed(2),
        item.breakdown.must_not_penalty.toFixed(2),
        item.breakdown.recall_main.toFixed(2),
        item.breakdown.summary_faithfulness.toFixed(2),
        item.breakdown.latency.toFixed(2),
        item.breakdown.stability.toFixed(2),
        item.avg_latency_ms.toFixed(0),
        "|",
      ].join(" "),
    ),
  ].join("\n")
}

function fail(score: Array<Row & { detail: Detail[] }>) {
  return score
    .flatMap((item) =>
      item.detail
        .filter(
          (row) =>
            row.total < 100 ||
            row.breakdown.precision_main < 40 ||
            row.breakdown.must_not_penalty < 20 ||
            row.breakdown.recall_main < 15 ||
            row.breakdown.summary_faithfulness < 15,
        )
        .map((row) => ({
          model: item.model,
          case: row.id,
          main: row.run[0]?.main ?? [],
          more: row.run[0]?.more ?? [],
          total: row.total,
        })),
    )
    .toSorted((a, b) => a.total - b.total)
    .slice(0, 15)
}

async function probe(input: Case, model: { providerID: ProviderID; modelID: ModelID }, mode: Exclude<Mode, "both">) {
  if (mode === "live") {
    const out = await Catalog.search({ query: input.query, semantic: true }, model)
    return {
      main: out.main.map((row) => row.name),
      more: out.more.map((row) => row.name),
      latency_ms: out.meta.latency_ms ?? 0,
      faithfulness: faith(input, out.main.map((row) => ({ name: row.name, summary_zh: row.summary_zh }))),
    }
  }

  const out = await Catalog.bench(
    {
      query: input.query,
      items: input.fixture.map((item) => ({
        id: item.id,
        name: item.name,
        source: item.source,
        rank: item.rank,
        body: item.body,
        summary_source: item.summary_source,
      })),
    },
    model,
  )
  return {
    main: out.main.map((row) => row.name),
    more: out.more.map((row) => row.name),
    latency_ms: out.meta.latency_ms ?? 0,
    faithfulness: faith(input, out.main.map((row) => ({ name: row.name, summary_zh: row.summary_zh }))),
  }
}

async function one(mode: Exclude<Mode, "both">, input?: { models?: string[]; runs?: number }) {
  const list = (input?.models?.map(parse).filter((item): item is NonNullable<typeof item> => !!item) ?? await models())
    .map((item) => ({ ...item, name: print(item) }))
  const runs = Math.max(1, input?.runs ?? 2)
  const score: Array<Row & { detail: Detail[] }> = []

  for (const model of list) {
    const detail = []
    let total = 0
    let latency = 0
    let stability = 0

    for (const item of cases) {
      const tries = []
      for (let i = 0; i < runs; i++) {
        tries.push(await probe(item, model, mode))
      }
      const base = tries[0]!
      const ranked = rank(item, base)
      const stable =
        tries.length < 2
          ? 5
          : points(
              tries
                .slice(1)
                .map((next) => overlap(base.main, next.main))
                .reduce((acc, item) => acc + item, 0) / Math.max(1, tries.length - 1),
              5,
            )
      ranked.breakdown.stability = stable
      ranked.total =
        ranked.breakdown.precision_main +
        ranked.breakdown.must_not_penalty +
        ranked.breakdown.recall_main +
        ranked.breakdown.summary_faithfulness +
        ranked.breakdown.latency +
        ranked.breakdown.stability
      total += ranked.total
      latency += tries.reduce((acc, item) => acc + item.latency_ms, 0) / tries.length
      stability += stable
      detail.push({
        id: item.id,
        query: item.query,
        run: tries,
        total: ranked.total,
        breakdown: ranked.breakdown,
      })
    }

    score.push({
      model: model.name,
      total: Math.round((total / cases.length) * 100) / 100,
      avg_latency_ms: Math.round(latency / cases.length),
      breakdown: {
        precision_main: Math.round((detail.reduce((acc, item: any) => acc + item.breakdown.precision_main, 0) / cases.length) * 100) / 100,
        must_not_penalty: Math.round((detail.reduce((acc, item: any) => acc + item.breakdown.must_not_penalty, 0) / cases.length) * 100) / 100,
        recall_main: Math.round((detail.reduce((acc, item: any) => acc + item.breakdown.recall_main, 0) / cases.length) * 100) / 100,
        summary_faithfulness: Math.round((detail.reduce((acc, item: any) => acc + item.breakdown.summary_faithfulness, 0) / cases.length) * 100) / 100,
        latency: Math.round((detail.reduce((acc, item: any) => acc + item.breakdown.latency, 0) / cases.length) * 100) / 100,
        stability: Math.round((stability / cases.length) * 100) / 100,
      },
      detail,
    })
  }

  const rows = table(score)
  return {
    mode,
    rows,
    markdown: markdown(mode, rows),
    winner: rows[0]?.model,
    fail_examples: fail(score),
  } satisfies Report
}

export async function run(input?: { models?: string[]; runs?: number; mode?: Mode }) {
  const mode = input?.mode ?? "rerank"
  if (mode === "both") {
    const rerank = await one("rerank", input)
    const live = await one("live", input)
    return {
      rerank,
      live,
      markdown: [rerank.markdown, "", live.markdown].join("\n"),
      winner: rerank.winner,
    }
  }
  return one(mode, input)
}
