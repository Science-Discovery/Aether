const en = {
  title: "HTML preview",
  loading: "Preparing preview…",
  refresh: "Refresh preview",
  failed: "Could not preview this page",
  static: "Scripts and online resources are disabled",
  partial: "Some local resources could not be loaded",
  retry: "Try again",
}
const zh: typeof en = {
  title: "HTML 预览",
  loading: "正在准备预览…",
  refresh: "刷新预览",
  failed: "无法预览此网页",
  static: "已停用脚本和联网资源",
  partial: "部分本地资源无法加载",
  retry: "重试",
}
const zht: typeof en = {
  title: "HTML 預覽",
  loading: "正在準備預覽…",
  refresh: "重新整理預覽",
  failed: "無法預覽此網頁",
  static: "已停用指令碼和連線資源",
  partial: "部分本機資源無法載入",
  retry: "重試",
}

export function htmlText(locale: string, key: keyof typeof en) {
  return (locale === "zh" ? zh : locale === "zht" ? zht : en)[key]
}
