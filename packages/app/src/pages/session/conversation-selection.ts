const selector = "[data-assistant-message-id][data-assistant-part-id]"

export type ConversationSource = { messageID: string; start: number; end: number; text: string }

export function conversationRanges(root: HTMLElement, source: ConversationSource) {
  const parts = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (body) => body.dataset.assistantMessageId === source.messageID,
  )
  if (!parts.length || parts.some((body) => body.closest('[data-assistant-collapsed="true"]'))) return []
  const ids = parts.map((body) => body.dataset.assistantPartId)
  if (new Set(ids).size !== ids.length) return []
  const text = parts.map((body) => body.textContent ?? "").join("\n\n")
  if (
    !Number.isSafeInteger(source.start) ||
    !Number.isSafeInteger(source.end) ||
    source.start < 0 ||
    source.end <= source.start ||
    source.end > text.length ||
    text.slice(source.start, source.end) !== source.text
  )
    return []

  const point = (body: HTMLElement, offset: number) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    let remaining = offset
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
      node = walker.nextNode()
    }
  }
  let offset = 0
  return parts.flatMap((body) => {
    const length = body.textContent?.length ?? 0
    const start = Math.max(0, source.start - offset)
    const end = Math.min(length, source.end - offset)
    offset += length + 2
    if (end <= start) return []
    const first = point(body, start)
    const last = point(body, end)
    if (!first || !last) return []
    const range = document.createRange()
    range.setStart(first.node, first.offset)
    range.setEnd(last.node, last.offset)
    return [{ range, container: body }]
  })
}

export function conversationSelection(root: HTMLElement, range: Range) {
  const parent = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(selector)
  const first = parent(range.startContainer)
  const last = parent(range.endContainer)
  if (!first || !last || !root.contains(first) || !root.contains(last)) return
  const messageID = first.dataset.assistantMessageId
  if (!messageID || last.dataset.assistantMessageId !== messageID) return

  const all = Array.from(root.querySelectorAll<HTMLElement>(selector))
  const selected = all.slice(all.indexOf(first), all.indexOf(last) + 1)
  if (!selected.length || selected.some((body) => body.dataset.assistantMessageId !== messageID)) return
  const parts = all.filter((body) => body.dataset.assistantMessageId === messageID)
  // Offsets address the displayed text bodies of this assistant message; controls and tool output are excluded.
  const raw = selected
    .map((body) => {
      const area = range.cloneRange()
      area.selectNodeContents(body)
      if (body === first) area.setStart(range.startContainer, range.startOffset)
      if (body === last) area.setEnd(range.endContainer, range.endOffset)
      return area.toString()
    })
    .join("\n\n")
  const text = raw.trim()
  if (!text) return
  const prefix = range.cloneRange()
  prefix.selectNodeContents(first)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start =
    parts.slice(0, parts.indexOf(first)).reduce((sum, body) => sum + (body.textContent?.length ?? 0) + 2, 0) +
    prefix.toString().length +
    raw.length -
    raw.trimStart().length
  return { messageID, start, end: start + text.length, text, containers: selected }
}
