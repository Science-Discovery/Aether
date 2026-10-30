const selector = "[data-assistant-message-id][data-assistant-part-id]"

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
