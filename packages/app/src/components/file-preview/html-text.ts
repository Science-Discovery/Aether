const en = {
  title: "HTML preview",
  loading: "Preparing preview…",
  refresh: "Refresh preview",
  failed: "Could not preview this page",
  static: "Scripts and online resources are disabled",
  missing: "Local resource read failures",
  blocked: "Disabled content",
  unsupported: "Unsupported style fragments",
  retry: "Try again",
}
const zh: typeof en = {
  title: "HTML 预览",
  loading: "正在准备预览…",
  refresh: "刷新预览",
  failed: "无法预览此网页",
  static: "已停用脚本和联网资源",
  missing: "本地资源读取失败",
  blocked: "已停用的内容",
  unsupported: "未支持的样式片段",
  retry: "重试",
}
const zht: typeof en = {
  title: "HTML 預覽",
  loading: "正在準備預覽…",
  refresh: "重新整理預覽",
  failed: "無法預覽此網頁",
  static: "已停用指令碼和連線資源",
  missing: "本機資源讀取失敗",
  blocked: "已停用的內容",
  unsupported: "未支援的樣式片段",
  retry: "重試",
}

export function htmlText(locale: string, key: keyof typeof en) {
  return (locale === "zh" ? zh : locale === "zht" ? zht : en)[key]
}
