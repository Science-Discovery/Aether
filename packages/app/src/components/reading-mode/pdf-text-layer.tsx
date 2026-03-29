type TextItemLike = {
  str: string
}

type PDFPageProxy = any

function isTextItem(item: unknown): item is TextItemLike {
  return !!item && typeof item === "object" && "str" in item
}

export async function extractPageText(page: PDFPageProxy) {
  const content = await page.getTextContent()
  const items = content.items.filter(isTextItem)
  return items
    .map((item: TextItemLike) => item.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}
