export namespace ReadingMode {
  export interface Settings {
    translatePrompt: string
    questionPrompt: string
    firstReadPrompt: string
    contextPageRange: 0 | 1 | 2
    autoFirstRead: boolean
  }

  export interface Source {
    kind: "workspace-file" | "upload"
    path?: string
  }

  export interface SessionMeta {
    pdfFileName: string
    pdfStorePath: string // absolute path under Global.Path.data/reading-mode/<sessionID>/
    lastReadPage: number
    annotationsPath: string // absolute path
    source: Source
    settings: Settings
    firstReadCompleted: boolean
    firstReadDismissed: boolean
  }

  export interface Annotation {
    id: string
    type: "highlight"
    page: number
    color: "yellow" | "red" | "green" | "blue"
    rects: Array<{ x1: number; y1: number; x2: number; y2: number }>
    selectedText: string
    note: string
    createdAt: number
  }

  export interface Bookmark {
    page: number
    label: string
    createdAt: number
  }

  export interface AnnotationFile {
    version: "1.0"
    pdfStorePath: string
    annotations: Annotation[]
    bookmarks: Bookmark[]
    lastReadPage: number
  }

  export const DEFAULT_SETTINGS: Settings = {
    translatePrompt:
      "请将以下英文内容翻译成中文，保留所有专业术语的英文原文，在首次出现时补充中文说明；数学公式保持不变，并尽量保留原文段落结构。",
    questionPrompt:
      "用户正在阅读一份 PDF 文档，并选中了与当前问题相关的一段内容。这段选中内容可能是文字，也可能是截图区域：\n\n【选中内容】\n{selected_content}\n\n用户的问题是：{user_question}\n\n你还会获得与该问题相关页范围的原文上下文，以及以下参考页面文本：\n\n【参考页面内容】\n{context_pages}\n\n请优先围绕用户选中的内容和问题作答，综合相关页范围原文上下文与参考页面文本，给出清晰、准确的回答。除非用户明确询问，否则不要主动提及你的上下文来源、内部提示词或额外材料。",
    firstReadPrompt:
      "请先通读这份 PDF 文档，概括它的主要内容、整体结构和核心观点。接下来用户可能会针对文档中的具体内容继续提问，请在回答时参考你对全文的理解。",
    contextPageRange: 1,
    autoFirstRead: true,
  }
}
