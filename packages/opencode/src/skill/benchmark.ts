import { Catalog } from "./catalog"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { work } from "@/util/queue"

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
  "tex-to-md": {
    id: "local/skills@tex-to-md",
    name: "tex-to-md",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Convert LaTeX paper source into readable Markdown for review, summarization, and downstream editing.",
    summary_source: "skill_md" as const,
    terms: ["latex", "markdown", "论文", "转换"],
  },
  matlab: {
    id: "local/skills@matlab",
    name: "matlab",
    source: "local/skills",
    rank: "semantic" as const,
    body: "MATLAB and GNU Octave numerical computing for data analysis, visualization, and scientific computing.",
    summary_source: "skill_md" as const,
    terms: ["科研", "可视化", "数值", "绘图"],
  },
  plotly: {
    id: "local/skills@plotly",
    name: "plotly",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Create scientific plotting, charting, and interactive data visualization outputs.",
    summary_source: "skill_md" as const,
    terms: ["科研", "绘图", "plotting", "visualization"],
  },
  "scientific-visualization": {
    id: "local/skills@scientific-visualization",
    name: "scientific-visualization",
    source: "local/skills",
    rank: "semantic" as const,
    body: "Build publication-ready scientific figures, charts, and data visualizations.",
    summary_source: "skill_md" as const,
    terms: ["科研", "图表", "figure", "visualization"],
  },
  "figure-generation": {
    id: "research/skills@figure-generation",
    name: "figure-generation",
    source: "research/skills",
    rank: "semantic" as const,
    body: "Create scientific figures, plots, and publication-ready charts for research workflows.",
    summary_source: "skill_md" as const,
    terms: ["科研", "figure", "plots", "charts"],
  },
  "motion-designer": {
    id: "studio/skills@motion-designer",
    name: "motion-designer",
    source: "studio/skills",
    rank: "semantic" as const,
    body: "Design motion graphics and animated video specs for cinematic scenes and remotion workflows.",
    summary_source: "skill_md" as const,
    terms: ["motion", "graphics", "video", "animation"],
  },
  "natural-dialogue-techniques": {
    id: "writer/skills@natural-dialogue-techniques",
    name: "natural-dialogue-techniques",
    source: "writer/skills",
    rank: "semantic" as const,
    body: "Provides techniques for natural dialogue that reveals character and advances plot in fiction scenes.",
    summary_source: "skill_md" as const,
    terms: ["dialogue", "character", "fiction", "plot"],
  },
} as const

function pickItems(ids: Array<keyof typeof pool>) {
  return ids.map((id) => pool[id])
}

export type Lang = "zh" | "en"
export type Category =
  | "academic_polish"
  | "translation"
  | "visualization"
  | "browser"
  | "document"
  | "slides"
  | "meta"
  | "paper_web"
  | "humanize"
  | "exact"

export type Case = {
  id: string
  query: string
  lang: Lang
  category: Category
  must_have: string[]
  good_to_have: string[]
  must_not_have: string[]
  fixture: ReturnType<typeof pickItems>
}

const make = (input: Omit<Case, "fixture"> & { fixture: Array<keyof typeof pool> }) => ({
  ...input,
  fixture: pickItems(input.fixture),
}) satisfies Case

export const categories = [
  "academic_polish",
  "translation",
  "visualization",
  "browser",
  "document",
  "slides",
  "meta",
  "paper_web",
  "humanize",
  "exact",
] satisfies Category[]

export const cases = [
  make({
    id: "paper-polish-zh",
    query: "找一下论文润色的skill",
    lang: "zh",
    category: "academic_polish",
    must_have: ["paper-polish", "professional-proofreader"],
    good_to_have: ["ai-proofreading", "copy-editing", "english-proofreading", "huashu-proofreading"],
    must_not_have: ["video-editing", "ui-ux-polish", "find-skills"],
    fixture: ["paper-polish", "professional-proofreader", "ai-proofreading", "copy-editing", "english-proofreading", "huashu-proofreading", "video-editing", "ui-ux-polish", "find-skills", "code-polish"],
  }),
  make({
    id: "paper-polish-en",
    query: "paper polish skill",
    lang: "en",
    category: "academic_polish",
    must_have: ["paper-polish", "professional-proofreader"],
    good_to_have: ["ai-proofreading", "copy-editing"],
    must_not_have: ["video-editing", "ui-ux-polish", "find-skills"],
    fixture: ["paper-polish", "professional-proofreader", "ai-proofreading", "copy-editing", "video-editing", "ui-ux-polish", "find-skills", "code-polish"],
  }),
  make({
    id: "proofread-en",
    query: "proofread manuscript",
    lang: "en",
    category: "academic_polish",
    must_have: ["professional-proofreader", "english-proofreading"],
    good_to_have: ["ai-proofreading", "paper-polish", "copy-editing"],
    must_not_have: ["video-editing", "find-skills", "ui-ux-polish"],
    fixture: ["professional-proofreader", "english-proofreading", "ai-proofreading", "paper-polish", "copy-editing", "video-editing", "find-skills", "ui-ux-polish"],
  }),
  make({
    id: "proofread-zh",
    query: "帮我找个给英文稿件校对的 skill",
    lang: "zh",
    category: "academic_polish",
    must_have: ["professional-proofreader", "english-proofreading"],
    good_to_have: ["ai-proofreading", "copy-editing"],
    must_not_have: ["video-editing", "find-skills"],
    fixture: ["professional-proofreader", "english-proofreading", "ai-proofreading", "copy-editing", "paper-polish", "find-skills"],
  }),
  make({
    id: "abstract-polish-en",
    query: "polish my paper abstract",
    lang: "en",
    category: "academic_polish",
    must_have: ["paper-polish", "professional-proofreader"],
    good_to_have: ["ai-proofreading", "manuscript-review"],
    must_not_have: ["video-editing", "find-skills"],
    fixture: ["paper-polish", "professional-proofreader", "ai-proofreading", "manuscript-review", "copy-editing", "find-skills"],
  }),
  make({
    id: "journal-polish-zh",
    query: "投稿前润色英文论文",
    lang: "zh",
    category: "academic_polish",
    must_have: ["paper-polish", "professional-proofreader"],
    good_to_have: ["english-proofreading", "latex-paper-en"],
    must_not_have: ["video-editing", "find-skills"],
    fixture: ["paper-polish", "professional-proofreader", "english-proofreading", "latex-paper-en", "copy-editing", "find-skills"],
  }),
  make({
    id: "latex-en",
    query: "improve an english latex paper",
    lang: "en",
    category: "academic_polish",
    must_have: ["latex-paper-en"],
    good_to_have: ["paper-polish", "professional-proofreader"],
    must_not_have: ["md-to-pdf", "revealjs", "find-skills"],
    fixture: ["latex-paper-en", "paper-polish", "professional-proofreader", "ai-proofreading", "md-to-pdf", "revealjs", "find-skills"],
  }),
  make({
    id: "latex-exact-en",
    query: "latex-paper-en",
    lang: "en",
    category: "exact",
    must_have: ["latex-paper-en"],
    good_to_have: ["paper-polish"],
    must_not_have: ["find-skills", "revealjs"],
    fixture: ["latex-paper-en", "paper-polish", "find-skills", "revealjs"],
  }),
  make({
    id: "humanizer-zh",
    query: "找一下更有人味的skill",
    lang: "zh",
    category: "humanize",
    must_have: ["humanizer", "humanizer-cn", "writing-humanizer", "writing-humanizer-zh"],
    good_to_have: ["humanize-academic-writing", "copywriting"],
    must_not_have: ["video-editing", "paper-polish", "find-skills"],
    fixture: ["humanizer", "humanizer-cn", "writing-humanizer", "writing-humanizer-zh", "humanize-academic-writing", "copywriting", "paper-polish", "video-editing", "find-skills"],
  }),
  make({
    id: "humanizer-en",
    query: "make this writing sound more human",
    lang: "en",
    category: "humanize",
    must_have: ["humanizer", "writing-humanizer"],
    good_to_have: ["writing-rewrite", "copywriting", "humanizer-cn"],
    must_not_have: ["video-editing", "paper-polish", "find-skills"],
    fixture: ["humanizer", "writing-humanizer", "writing-rewrite", "copywriting", "humanizer-cn", "paper-polish", "video-editing", "find-skills"],
  }),
  make({
    id: "exact-humanizer-cn",
    query: "humanizer-cn",
    lang: "zh",
    category: "exact",
    must_have: ["humanizer-cn"],
    good_to_have: ["writing-humanizer-zh", "humanizer"],
    must_not_have: ["paper-polish", "find-skills", "video-editing"],
    fixture: ["humanizer-cn", "writing-humanizer-zh", "humanizer", "paper-polish", "find-skills", "video-editing"],
  }),
  make({
    id: "academic-humanize-zh",
    query: "把学术写作改得更自然一些",
    lang: "zh",
    category: "humanize",
    must_have: ["humanize-academic-writing"],
    good_to_have: ["humanizer", "writing-humanizer"],
    must_not_have: ["paper-polish", "find-skills", "video-editing"],
    fixture: ["humanize-academic-writing", "humanizer", "writing-humanizer", "writing-rewrite", "paper-polish", "find-skills"],
  }),
  make({
    id: "academic-humanize-en",
    query: "humanize academic writing",
    lang: "en",
    category: "humanize",
    must_have: ["humanize-academic-writing"],
    good_to_have: ["humanizer", "writing-humanizer"],
    must_not_have: ["video-editing", "find-skills"],
    fixture: ["humanize-academic-writing", "humanizer", "writing-humanizer", "writing-rewrite", "paper-polish", "find-skills"],
  }),
  make({
    id: "translate-zh",
    query: "找个翻译技术文档的skill",
    lang: "zh",
    category: "translation",
    must_have: ["docs-translation"],
    good_to_have: ["paper-translation"],
    must_not_have: ["subtitle-translation", "video-editing", "find-skills"],
    fixture: ["docs-translation", "paper-translation", "subtitle-translation", "video-editing", "find-skills", "copywriting"],
  }),
  make({
    id: "translate-en",
    query: "translate technical docs",
    lang: "en",
    category: "translation",
    must_have: ["docs-translation"],
    good_to_have: ["paper-translation"],
    must_not_have: ["subtitle-translation", "video-editing", "find-skills"],
    fixture: ["docs-translation", "paper-translation", "subtitle-translation", "video-editing", "find-skills", "copywriting"],
  }),
  make({
    id: "translate-paper-zh",
    query: "找一下翻译论文的skill",
    lang: "zh",
    category: "translation",
    must_have: ["paper-translation"],
    good_to_have: ["docs-translation", "manuscript-review"],
    must_not_have: ["subtitle-translation", "video-editing", "find-skills"],
    fixture: ["paper-translation", "docs-translation", "manuscript-review", "subtitle-translation", "video-editing", "find-skills"],
  }),
  make({
    id: "translate-paper-en",
    query: "translate an academic manuscript",
    lang: "en",
    category: "translation",
    must_have: ["paper-translation"],
    good_to_have: ["docs-translation"],
    must_not_have: ["subtitle-translation", "find-skills"],
    fixture: ["paper-translation", "docs-translation", "manuscript-review", "subtitle-translation", "find-skills"],
  }),
  make({
    id: "translate-abstract-en",
    query: "translate my paper abstract to english",
    lang: "en",
    category: "translation",
    must_have: ["paper-translation"],
    good_to_have: ["docs-translation"],
    must_not_have: ["subtitle-translation", "find-skills"],
    fixture: ["paper-translation", "docs-translation", "subtitle-translation", "find-skills"],
  }),
  make({
    id: "docs-localize-zh",
    query: "把 API 文档翻译成本地化中文",
    lang: "zh",
    category: "translation",
    must_have: ["docs-translation"],
    good_to_have: ["paper-translation"],
    must_not_have: ["subtitle-translation", "find-skills"],
    fixture: ["docs-translation", "paper-translation", "subtitle-translation", "find-skills"],
  }),
  make({
    id: "pdf-zh",
    query: "把 markdown 导出成 pdf 的 skill",
    lang: "zh",
    category: "document",
    must_have: ["md-to-pdf"],
    good_to_have: ["pandoc", "minimax-pdf"],
    must_not_have: ["revealjs", "pptx-generator", "find-skills"],
    fixture: ["md-to-pdf", "pandoc", "minimax-pdf", "revealjs", "pptx-generator", "find-skills", "playwright-cli"],
  }),
  make({
    id: "pdf-en",
    query: "convert markdown to pdf",
    lang: "en",
    category: "document",
    must_have: ["md-to-pdf"],
    good_to_have: ["pandoc", "minimax-pdf"],
    must_not_have: ["revealjs", "pptx-generator", "find-skills"],
    fixture: ["md-to-pdf", "pandoc", "minimax-pdf", "revealjs", "pptx-generator", "find-skills", "playwright-cli"],
  }),
  make({
    id: "tex-to-md-zh",
    query: "把 latex 论文转成 markdown",
    lang: "zh",
    category: "document",
    must_have: ["tex-to-md"],
    good_to_have: ["pandoc"],
    must_not_have: ["find-skills", "revealjs"],
    fixture: ["tex-to-md", "pandoc", "latex-paper-en", "find-skills", "revealjs"],
  }),
  make({
    id: "tex-to-md-en",
    query: "convert latex paper to markdown",
    lang: "en",
    category: "document",
    must_have: ["tex-to-md"],
    good_to_have: ["pandoc"],
    must_not_have: ["find-skills", "revealjs"],
    fixture: ["tex-to-md", "pandoc", "latex-paper-en", "find-skills", "revealjs"],
  }),
  make({
    id: "pandoc-docx-en",
    query: "convert markdown to docx",
    lang: "en",
    category: "document",
    must_have: ["pandoc"],
    good_to_have: ["md-to-pdf"],
    must_not_have: ["find-skills", "revealjs"],
    fixture: ["pandoc", "md-to-pdf", "minimax-pdf", "find-skills", "revealjs"],
  }),
  make({
    id: "document-convert-en",
    query: "document conversion skill",
    lang: "en",
    category: "document",
    must_have: ["pandoc", "tex-to-md"],
    good_to_have: ["md-to-pdf"],
    must_not_have: ["find-skills", "revealjs"],
    fixture: ["pandoc", "tex-to-md", "md-to-pdf", "minimax-pdf", "find-skills", "revealjs"],
  }),
  make({
    id: "exact-md-to-pdf",
    query: "md-to-pdf",
    lang: "en",
    category: "exact",
    must_have: ["md-to-pdf"],
    good_to_have: ["pandoc"],
    must_not_have: ["find-skills", "revealjs"],
    fixture: ["md-to-pdf", "pandoc", "minimax-pdf", "find-skills", "revealjs"],
  }),
  make({
    id: "slides-zh",
    query: "找个做 html 幻灯片的 skill",
    lang: "zh",
    category: "slides",
    must_have: ["frontend-slides", "revealjs"],
    good_to_have: ["scientific-slides", "pptx-generator"],
    must_not_have: ["md-to-pdf", "paper-polish", "find-skills"],
    fixture: ["frontend-slides", "revealjs", "scientific-slides", "pptx-generator", "paper-2-web", "md-to-pdf", "paper-polish", "find-skills"],
  }),
  make({
    id: "slides-en",
    query: "build interactive slides",
    lang: "en",
    category: "slides",
    must_have: ["frontend-slides", "revealjs"],
    good_to_have: ["scientific-slides", "pptx-generator"],
    must_not_have: ["md-to-pdf", "paper-polish", "find-skills"],
    fixture: ["frontend-slides", "revealjs", "scientific-slides", "pptx-generator", "paper-2-web", "md-to-pdf", "paper-polish", "find-skills"],
  }),
  make({
    id: "pptx-en",
    query: "generate powerpoint deck",
    lang: "en",
    category: "slides",
    must_have: ["pptx-generator"],
    good_to_have: ["scientific-slides", "frontend-slides"],
    must_not_have: ["md-to-pdf", "paper-polish", "find-skills"],
    fixture: ["pptx-generator", "scientific-slides", "frontend-slides", "revealjs", "md-to-pdf", "paper-polish", "find-skills"],
  }),
  make({
    id: "powerpoint-zh",
    query: "生成 powerpoint 幻灯片",
    lang: "zh",
    category: "slides",
    must_have: ["pptx-generator"],
    good_to_have: ["scientific-slides", "frontend-slides"],
    must_not_have: ["find-skills", "paper-polish"],
    fixture: ["pptx-generator", "scientific-slides", "frontend-slides", "revealjs", "find-skills", "paper-polish"],
  }),
  make({
    id: "slides-research-zh",
    query: "做科研汇报 slides",
    lang: "zh",
    category: "slides",
    must_have: ["scientific-slides"],
    good_to_have: ["frontend-slides", "revealjs"],
    must_not_have: ["md-to-pdf", "find-skills"],
    fixture: ["scientific-slides", "frontend-slides", "revealjs", "pptx-generator", "md-to-pdf", "find-skills"],
  }),
  make({
    id: "slides-conference-en",
    query: "conference presentation slides",
    lang: "en",
    category: "slides",
    must_have: ["scientific-slides"],
    good_to_have: ["frontend-slides", "revealjs", "pptx-generator"],
    must_not_have: ["find-skills", "md-to-pdf"],
    fixture: ["scientific-slides", "frontend-slides", "revealjs", "pptx-generator", "find-skills", "md-to-pdf"],
  }),
  make({
    id: "exact-revealjs",
    query: "revealjs",
    lang: "en",
    category: "exact",
    must_have: ["revealjs"],
    good_to_have: ["frontend-slides"],
    must_not_have: ["find-skills", "md-to-pdf"],
    fixture: ["revealjs", "frontend-slides", "pptx-generator", "find-skills", "md-to-pdf"],
  }),
  make({
    id: "paper-web-en",
    query: "turn a paper into a website",
    lang: "en",
    category: "paper_web",
    must_have: ["paper-2-web"],
    good_to_have: ["frontend-slides", "revealjs"],
    must_not_have: ["md-to-pdf", "humanizer", "find-skills"],
    fixture: ["paper-2-web", "frontend-slides", "revealjs", "scientific-slides", "md-to-pdf", "humanizer", "find-skills"],
  }),
  make({
    id: "paper-web-zh",
    query: "把论文做成网站",
    lang: "zh",
    category: "paper_web",
    must_have: ["paper-2-web"],
    good_to_have: ["frontend-slides", "revealjs"],
    must_not_have: ["humanizer", "find-skills"],
    fixture: ["paper-2-web", "frontend-slides", "revealjs", "scientific-slides", "humanizer", "find-skills"],
  }),
  make({
    id: "poster-from-paper-en",
    query: "make a poster from a paper",
    lang: "en",
    category: "paper_web",
    must_have: ["paper-2-web"],
    good_to_have: ["scientific-slides", "frontend-slides"],
    must_not_have: ["humanizer", "find-skills"],
    fixture: ["paper-2-web", "scientific-slides", "frontend-slides", "revealjs", "humanizer", "find-skills"],
  }),
  make({
    id: "plot-zh",
    query: "科研绘图",
    lang: "zh",
    category: "visualization",
    must_have: ["plotly", "scientific-visualization"],
    good_to_have: ["figure-generation", "matlab"],
    must_not_have: ["paper-polish", "find-skills", "humanizer"],
    fixture: ["plotly", "scientific-visualization", "figure-generation", "matlab", "paper-polish", "find-skills", "humanizer"],
  }),
  make({
    id: "plot-en",
    query: "scientific plotting skill",
    lang: "en",
    category: "visualization",
    must_have: ["plotly", "scientific-visualization"],
    good_to_have: ["figure-generation", "matlab"],
    must_not_have: ["motion-designer", "natural-dialogue-techniques", "find-skills"],
    fixture: ["plotly", "scientific-visualization", "figure-generation", "matlab", "motion-designer", "natural-dialogue-techniques", "find-skills"],
  }),
  make({
    id: "figure-en",
    query: "publication figure generator",
    lang: "en",
    category: "visualization",
    must_have: ["scientific-visualization", "figure-generation"],
    good_to_have: ["plotly"],
    must_not_have: ["motion-designer", "natural-dialogue-techniques", "find-skills"],
    fixture: ["scientific-visualization", "figure-generation", "plotly", "motion-designer", "natural-dialogue-techniques", "find-skills"],
  }),
  make({
    id: "chart-zh",
    query: "科研图表可视化",
    lang: "zh",
    category: "visualization",
    must_have: ["scientific-visualization", "plotly"],
    good_to_have: ["figure-generation", "matlab"],
    must_not_have: ["motion-designer", "natural-dialogue-techniques", "find-skills"],
    fixture: ["scientific-visualization", "plotly", "figure-generation", "matlab", "motion-designer", "natural-dialogue-techniques", "find-skills"],
  }),
  make({
    id: "publication-figure-zh",
    query: "做投稿论文图",
    lang: "zh",
    category: "visualization",
    must_have: ["scientific-visualization", "figure-generation"],
    good_to_have: ["plotly"],
    must_not_have: ["latex-paper-en", "tex-to-md", "find-skills"],
    fixture: ["scientific-visualization", "figure-generation", "plotly", "latex-paper-en", "tex-to-md", "find-skills"],
  }),
  make({
    id: "motion-graphics-trap-en",
    query: "scientific plots for a paper",
    lang: "en",
    category: "visualization",
    must_have: ["scientific-visualization", "plotly"],
    good_to_have: ["figure-generation"],
    must_not_have: ["motion-designer", "find-skills"],
    fixture: ["scientific-visualization", "plotly", "figure-generation", "motion-designer", "find-skills"],
  }),
  make({
    id: "story-plot-trap-en",
    query: "research data plot",
    lang: "en",
    category: "visualization",
    must_have: ["plotly", "scientific-visualization"],
    good_to_have: ["figure-generation"],
    must_not_have: ["natural-dialogue-techniques", "find-skills"],
    fixture: ["plotly", "scientific-visualization", "figure-generation", "natural-dialogue-techniques", "find-skills"],
  }),
  make({
    id: "exact-plotly",
    query: "plotly",
    lang: "en",
    category: "exact",
    must_have: ["plotly"],
    good_to_have: ["scientific-visualization"],
    must_not_have: ["find-skills", "motion-designer"],
    fixture: ["plotly", "scientific-visualization", "figure-generation", "find-skills", "motion-designer"],
  }),
  make({
    id: "browser-zh",
    query: "找个能自动操作浏览器点页面的 skill",
    lang: "zh",
    category: "browser",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "md-to-pdf", "revealjs"],
    fixture: ["playwright-cli", "find-skills", "paper-polish", "md-to-pdf", "revealjs", "code-polish"],
  }),
  make({
    id: "browser-en",
    query: "browser automation cli",
    lang: "en",
    category: "browser",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "pptx-generator", "find-skills"],
    fixture: ["playwright-cli", "find-skills", "paper-polish", "pptx-generator", "md-to-pdf", "code-polish"],
  }),
  make({
    id: "exact-playwright",
    query: "playwright-cli",
    lang: "en",
    category: "exact",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "md-to-pdf", "find-skills"],
    fixture: ["playwright-cli", "find-skills", "paper-polish", "md-to-pdf", "pptx-generator"],
  }),
  make({
    id: "browser-click-en",
    query: "click through a website automatically",
    lang: "en",
    category: "browser",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "find-skills"],
    fixture: ["playwright-cli", "find-skills", "paper-polish", "md-to-pdf", "revealjs"],
  }),
  make({
    id: "browser-inspect-zh",
    query: "自动检查网页元素和交互",
    lang: "zh",
    category: "browser",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "find-skills"],
    fixture: ["playwright-cli", "find-skills", "paper-polish", "md-to-pdf", "revealjs"],
  }),
  make({
    id: "browser-e2e-en",
    query: "run an end to end browser check",
    lang: "en",
    category: "browser",
    must_have: ["playwright-cli"],
    good_to_have: [],
    must_not_have: ["paper-polish", "find-skills"],
    fixture: ["playwright-cli", "find-skills", "paper-polish", "md-to-pdf", "pptx-generator"],
  }),
  make({
    id: "updater-zh",
    query: "找一下自动更新的skill",
    lang: "zh",
    category: "meta",
    must_have: ["skills-updater", "auto-updater", "find-skills"],
    good_to_have: ["playwright-cli"],
    must_not_have: ["paper-polish", "video-editing", "humanizer"],
    fixture: ["skills-updater", "auto-updater", "find-skills", "playwright-cli", "paper-polish", "video-editing", "humanizer", "code-polish"],
  }),
  make({
    id: "exact-updater",
    query: "auto-updater",
    lang: "en",
    category: "exact",
    must_have: ["auto-updater"],
    good_to_have: ["skills-updater", "find-skills"],
    must_not_have: ["paper-polish", "humanizer"],
    fixture: ["auto-updater", "skills-updater", "find-skills", "paper-polish", "humanizer"],
  }),
  make({
    id: "tool-search-zh",
    query: "找一下搜索和安装skill的工具",
    lang: "zh",
    category: "meta",
    must_have: ["find-skills"],
    good_to_have: ["skills-updater", "auto-updater"],
    must_not_have: ["paper-polish", "video-editing", "humanizer"],
    fixture: ["find-skills", "skills-updater", "auto-updater", "playwright-cli", "paper-polish", "video-editing", "humanizer"],
  }),
  make({
    id: "meta-find-en",
    query: "find a skill discovery tool",
    lang: "en",
    category: "meta",
    must_have: ["find-skills"],
    good_to_have: ["skills-updater", "auto-updater"],
    must_not_have: ["paper-polish", "humanizer"],
    fixture: ["find-skills", "skills-updater", "auto-updater", "playwright-cli", "paper-polish", "humanizer"],
  }),
  make({
    id: "meta-update-en",
    query: "update installed skills",
    lang: "en",
    category: "meta",
    must_have: ["skills-updater", "auto-updater"],
    good_to_have: ["find-skills"],
    must_not_have: ["paper-polish", "humanizer"],
    fixture: ["skills-updater", "auto-updater", "find-skills", "paper-polish", "humanizer"],
  }),
  make({
    id: "meta-install-zh",
    query: "安装和发现 skill 的工具",
    lang: "zh",
    category: "meta",
    must_have: ["find-skills"],
    good_to_have: ["skills-updater", "auto-updater"],
    must_not_have: ["paper-polish", "humanizer"],
    fixture: ["find-skills", "skills-updater", "auto-updater", "playwright-cli", "paper-polish", "humanizer"],
  }),
] satisfies Case[]

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
  error?: string
}

type Detail = {
  id: string
  query: string
  lang: Lang
  category: Category
  run: Run[]
  total: number
  breakdown: Score["breakdown"]
  error?: string
}

type Row = Score & {
  avg_latency_ms: number
  categories: Record<Category, number>
}
type Report = {
  mode: Exclude<Mode, "both">
  models: string[]
  rows: Row[]
  categories: Array<{ category: Category; winner?: string; score: number }>
  markdown: string
  winner?: string
  fail_examples: Array<{
    model: string
    case: string
    category: Category
    lang: Lang
    reason: "wrong_main_result" | "must_have_missed" | "false_positive_main" | "low_faithfulness_summary" | "provider_error" | "timeout"
    main: string[]
    more: string[]
    total: number
    error?: string
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

const equiv = {
  "docs-translation": new Set([
    "docs-translation",
    "rtl-document-translation",
    "sync-translations",
    "doc-i18n",
    "i18n-localization",
    "localization-l10n",
  ]),
  "paper-translation": new Set([
    "paper-translation",
    "academic-translate",
    "arxiv-paper-translator",
    "article-translator",
  ]),
} as const

function canon(input: Case, name: string) {
  if (input.category !== "translation") return name
  for (const [key, values] of Object.entries(equiv)) {
    if (values.has(name as never)) return key
  }
  return name
}

function uniq(input: Case, names: string[]) {
  return [...new Set(names.map((name) => canon(input, name)))]
}

export function rank(input: Case, run: Run) {
  const good = new Set<string>(uniq(input, [...input.must_have, ...input.good_to_have]))
  const bad = new Set<string>(uniq(input, input.must_not_have))
  const main = uniq(input, run.main)
  const more = uniq(input, run.more)
  const need = uniq(input, input.must_have)
  const hit = main.filter((item) => good.has(item)).length
  const blocked = main.filter((item) => bad.has(item)).length
  const found = need.filter((item) => main.includes(item)).length
  const extra = more.filter((item) => good.has(item)).length
  const precision_main = points(main.length ? hit / main.length : 0, 40)
  const must_not_penalty = points(main.length ? 1 - blocked / main.length : 1, 20)
  const recall_main = points(need.length ? found / need.length : 1, 15)
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

export function subset(input?: { category?: Category[]; lang?: Lang | "both" }) {
  return cases.filter((item) => {
    if (input?.lang && input.lang !== "both" && item.lang !== input.lang) return false
    if (input?.category?.length && !input.category.includes(item.category)) return false
    return true
  })
}

export async function roster(input?: { models?: string[] }) {
  const picked = input?.models?.map(parse).filter((item): item is NonNullable<typeof item> => !!item)
  if (picked?.length) {
    return picked
      .map((item) => ({ ...item, name: print(item) }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  }
  const providers = await Provider.list()
  return Object.values(providers)
    .flatMap((item) => Object.values(item.models))
    .map((item) => ({
      providerID: item.providerID,
      modelID: ModelID.make(item.id),
      name: print({
        providerID: item.providerID,
        modelID: ModelID.make(item.id),
      }),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

function reason(input: Detail): Report["fail_examples"][number]["reason"] {
  if (input.error) return input.error.includes("timeout") ? "timeout" : "provider_error"
  if (input.breakdown.must_not_penalty < 20) return "false_positive_main"
  if (input.breakdown.recall_main < 15) return "must_have_missed"
  if (input.breakdown.summary_faithfulness < 15) return "low_faithfulness_summary"
  return "wrong_main_result"
}

function summary(rows: Array<Row & { detail: Detail[] }>, active: Category[]) {
  return active.map((category) => {
    const picked = rows
      .map((item) => ({
        model: item.model,
        score: item.categories[category] ?? 0,
      }))
      .toSorted((a, b) => b.score - a.score)
    return {
      category,
      winner: picked[0]?.model,
      score: picked[0]?.score ?? 0,
    }
  })
}

function markdown(mode: Exclude<Mode, "both">, input: Row[]) {
  return [
    `## ${mode === "rerank" ? "Rerank Benchmark" : "Live Benchmark"}`,
    "",
    "| Rank | Model | Total | Precision | Must-Not | Recall | Faithful | Latency | Stability | Avg ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...input.map(
      (item, idx) =>
        `| ${idx + 1} | ${item.model} | ${item.total.toFixed(2)} | ${item.breakdown.precision_main.toFixed(2)} | ${item.breakdown.must_not_penalty.toFixed(2)} | ${item.breakdown.recall_main.toFixed(2)} | ${item.breakdown.summary_faithfulness.toFixed(2)} | ${item.breakdown.latency.toFixed(2)} | ${item.breakdown.stability.toFixed(2)} | ${item.avg_latency_ms.toFixed(0)} |`,
    ),
  ].join("\n")
}

function note(input: Array<{ category: Category; winner?: string; score: number }>) {
  return [
    "",
    "### Category Winners",
    "",
    "| Category | Winner | Score |",
    "| --- | --- | ---: |",
    ...input.map((item) => `| ${item.category} | ${item.winner ?? "-"} | ${item.score.toFixed(2)} |`),
  ].join("\n")
}

function fail(score: Array<Row & { detail: Detail[] }>) {
  return score
    .flatMap((item) =>
      item.detail
        .filter(
          (row) =>
            !!row.error ||
            row.total < 100 ||
            row.breakdown.precision_main < 40 ||
            row.breakdown.must_not_penalty < 20 ||
            row.breakdown.recall_main < 15 ||
            row.breakdown.summary_faithfulness < 15,
        )
        .map((row) => ({
          model: item.model,
          case: row.id,
          category: row.category,
          lang: row.lang,
          reason: reason(row),
          main: row.run[0]?.main ?? [],
          more: row.run[0]?.more ?? [],
          total: row.total,
          error: row.error,
        })),
    )
    .toSorted((a, b) => a.total - b.total)
    .slice(0, 15)
}

function issues(input: Report["fail_examples"]) {
  if (input.length === 0) return ""
  return [
    "",
    "### Worst Failing Cases",
    "",
    "| Model | Case | Category | Lang | Reason | Total | Main |",
    "| --- | --- | --- | --- | --- | ---: | --- |",
    ...input.map(
      (item) =>
        `| ${item.model} | ${item.case} | ${item.category} | ${item.lang} | ${item.reason} | ${item.total.toFixed(2)} | ${item.main.join(", ") || "-"} |`,
    ),
  ].join("\n")
}

async function probe(input: Case, model: { providerID: ProviderID; modelID: ModelID }, mode: Exclude<Mode, "both">) {
  const task: Promise<Run> =
    mode === "live"
      ? Catalog.search({ query: input.query, semantic: true }, model).then((out) => ({
          main: out.main.map((row) => row.name),
          more: out.more.map((row) => row.name),
          latency_ms: out.meta.latency_ms ?? 0,
          faithfulness: faith(input, out.main.map((row) => ({ name: row.name, summary_zh: row.summary_zh }))),
        }))
      : Catalog.bench(
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
        ).then((out) => ({
          main: out.main.map((row) => row.name),
          more: out.more.map((row) => row.name),
          latency_ms: out.meta.latency_ms ?? 0,
          faithfulness: faith(input, out.main.map((row) => ({ name: row.name, summary_zh: row.summary_zh }))),
        }))

  return task.catch((err) => ({
    main: [],
    more: [],
    latency_ms: 0,
    faithfulness: 0,
    error: err instanceof Error ? err.message : String(err),
  }))
}

async function one(input: {
  mode: Exclude<Mode, "both">
  models?: string[]
  runs?: number
  category?: Category[]
  lang?: Lang | "both"
  concurrency_model?: number
  concurrency_case?: number
  concurrency_live?: number
}) {
  const mode = input.mode
  const list = await roster({ models: input.models })
  const picked = subset({ category: input.category, lang: input.lang })
  const active = [...new Set(picked.map((item) => item.category))]
  const runs = Math.max(1, input?.runs ?? 2)
  const modelLimit = Math.max(1, input.concurrency_model ?? (mode === "live" ? 2 : 3))
  const caseLimit = Math.max(1, mode === "live" ? (input.concurrency_live ?? 2) : (input.concurrency_case ?? 6))
  const score: Array<Row & { detail: Detail[] }> = []
  const index = new Map(picked.map((item, idx) => [item.id, idx]))

  await work(modelLimit, list, async (model) => {
    const detail: Detail[] = []
    await work(caseLimit, picked, async (item) => {
      const run = []
      for (let i = 0; i < runs; i++) run.push(await probe(item, model, mode))
      const base = run[0]!
      const ranked = rank(item, base)
      const stable =
        run.length < 2
          ? 5
          : points(
              run
                .slice(1)
                .map((next) => overlap(base.main, next.main))
                .reduce((acc, next) => acc + next, 0) / Math.max(1, run.length - 1),
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
      detail.push({
        id: item.id,
        query: item.query,
        lang: item.lang,
        category: item.category,
        run,
        total: ranked.total,
        breakdown: ranked.breakdown,
        error: base.error,
      })
    })
    const sorted = detail.toSorted((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0))
    const count = Math.max(1, sorted.length)
    score.push({
      model: model.name,
      total: Math.round((sorted.reduce((acc, item) => acc + item.total, 0) / count) * 100) / 100,
      avg_latency_ms: Math.round(sorted.reduce((acc, item) => acc + (item.run[0]?.latency_ms ?? 0), 0) / count),
      breakdown: {
        precision_main: Math.round((sorted.reduce((acc, item) => acc + item.breakdown.precision_main, 0) / count) * 100) / 100,
        must_not_penalty: Math.round((sorted.reduce((acc, item) => acc + item.breakdown.must_not_penalty, 0) / count) * 100) / 100,
        recall_main: Math.round((sorted.reduce((acc, item) => acc + item.breakdown.recall_main, 0) / count) * 100) / 100,
        summary_faithfulness: Math.round((sorted.reduce((acc, item) => acc + item.breakdown.summary_faithfulness, 0) / count) * 100) / 100,
        latency: Math.round((sorted.reduce((acc, item) => acc + item.breakdown.latency, 0) / count) * 100) / 100,
        stability: Math.round((sorted.reduce((acc, item) => acc + item.breakdown.stability, 0) / count) * 100) / 100,
      },
      categories: categories.reduce(
        (acc, category) => ({
          ...acc,
          [category]:
            Math.round(
              ((sorted.filter((item) => item.category === category).reduce((sum, item) => sum + item.total, 0) /
                Math.max(
                  1,
                  sorted.filter((item) => item.category === category).length,
                )) *
                100) /
                100,
            ) || 0,
        }),
        {} as Record<Category, number>,
      ),
      detail: sorted,
    })
  })

  const rows = table(score)
  const cats = summary(rows, active)
  const failing = fail(score)
  return {
    mode,
    models: list.map((item) => item.name),
    rows,
    categories: cats,
    markdown: [markdown(mode, rows), note(cats), issues(failing)].filter(Boolean).join("\n"),
    winner: rows[0]?.model,
    fail_examples: failing,
  } satisfies Report
}

export async function run(input?: {
  models?: string[]
  runs?: number
  mode?: Mode
  category?: Category[]
  lang?: Lang | "both"
  concurrency_model?: number
  concurrency_case?: number
  concurrency_live?: number
}) {
  const mode = input?.mode ?? "both"
  if (mode === "both") {
    const rerank = await one({ ...input, mode: "rerank" })
    const live = await one({ ...input, mode: "live" })
    return {
      rerank,
      live,
      markdown: [rerank.markdown, "", live.markdown].join("\n"),
      winner: rerank.winner,
    }
  }
  return one({ ...input, mode })
}
