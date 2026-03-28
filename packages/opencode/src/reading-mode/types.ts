export namespace ReadingMode {
  export interface Settings {
    translatePrompt: string
    questionPrompt: string
    firstReadPrompt: string
    contextPageRange: 0 | 1 | 2
    autoFirstRead: boolean
  }

  export interface SessionMeta {
    pdfFileName: string
    pdfStorePath: string // absolute path under Global.Path.data/reading-mode/<sessionID>/
    lastReadPage: number
    annotationsPath: string // absolute path
    settings: Settings
    firstReadCompleted: boolean
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
      "请将以下英文内容翻译成中文，保留所有专业术语的英文原文（首次出现时括注中文），数学公式保持不变，保持原文的段落结构。",
    questionPrompt:
      "用户正在阅读一份 PDF 文件，并选中了以下内容：\n\n【选中内容】\n{selected_content}\n\n用户的问题是：{user_question}\n\n你可以参考以下相关页面的内容来辅助回答：\n\n【参考页面内容】\n{context_pages}\n\n请针对用户选中的这部分内容，结合参考页面，给出清晰准确的回答。",
    firstReadPrompt:
      "请初步阅读这份PDF文件（或其中一部分），对文件的主要内容、结构和核心论点进行总结和概括。接下来用户可能会就文件中的具体内容向你提问，请在回答时参考你对全文的理解。",
    contextPageRange: 1,
    autoFirstRead: true,
  }
}
