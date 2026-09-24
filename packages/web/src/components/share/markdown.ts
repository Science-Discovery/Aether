import { marked } from "marked"
import { codeToHtml } from "shiki"
import markedShiki from "marked-shiki"
import DOMPurify from "dompurify"

const config = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  SANITIZE_NAMED_PROPS: true,
  ADD_ATTR: ["target"],
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function safeHref(href: string) {
  const url = href.trim()
  if (/[\t\n\r]/.test(url)) return
  if (/^https?:\/\//i.test(url)) return url
  if (/^(?:\/|#|\?)/.test(url)) return url
  if (!/^[\w+.-]+:/.test(url)) return url
  return
}

const markedWithShiki = marked.use(
  {
    renderer: {
      link({ href, title, tokens, text }) {
        const label = tokens ? this.parser.parseInline(tokens) : escape(text)
        const url = safeHref(href)
        if (!url) return label
        const attr = title ? ` title="${escape(title)}"` : ""
        return `<a href="${escape(url)}"${attr} target="_blank" rel="noopener noreferrer">${label}</a>`
      },
    },
  },
  markedShiki({
    highlight(code, lang) {
      return codeToHtml(code, {
        lang: lang || "text",
        themes: {
          light: "github-light",
          dark: "github-dark",
        },
      })
    },
  }),
)

function sanitize(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

export async function render(markdown: string) {
  return sanitize(await markedWithShiki.parse(markdown))
}
