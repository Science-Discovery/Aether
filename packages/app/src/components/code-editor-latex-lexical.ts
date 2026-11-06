export const literal = /^(?:verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|lstlisting\*?|minted|comment|filecontents\*?)$/

export function comment(source: string, from: number) {
  const end = source.indexOf("\n", from)
  return end < 0 ? source.length : end
}

export function space(source: string, from: number) {
  while (from < source.length) {
    if (/\s/.test(source[from])) {
      from++
      continue
    }
    if (source[from] !== "%") break
    from = comment(source, from)
  }
  return from
}

export function command(source: string, from: number) {
  let end = from + 1
  while (end < source.length && /[a-zA-Z@]/.test(source[end])) end++
  if (end === from + 1) return { name: "", to: Math.min(from + 2, source.length) }
  const name = source.slice(from + 1, end)
  if (source[end] === "*") end++
  if ((name !== "verb" && name !== "Verb") || !source[end] || /\s/.test(source[end])) return { name, to: end }
  const line = comment(source, end)
  const close = source.indexOf(source[end], end + 1)
  return { name, to: close < 0 || close >= line ? line : close + 1 }
}

export function group(source: string, from: number) {
  if (source[from] !== "{" && source[from] !== "[") return
  const stack = [source[from] === "{" ? "}" : "]"]
  let pos = from + 1
  while (pos < source.length) {
    const char = source[pos]
    if (char === "%") {
      pos = comment(source, pos)
      continue
    }
    if (char === "\\") {
      pos = command(source, pos).to
      continue
    }
    if (char === "{" || (char === "[" && stack.at(-1) === "]")) {
      stack.push(char === "{" ? "}" : "]")
      pos++
      continue
    }
    if (char === stack.at(-1)) {
      stack.pop()
      if (!stack.length) return pos + 1
      pos++
      continue
    }
    if (char === "}") return
    pos++
  }
}
