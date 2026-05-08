export type Ref = {
  hash: string
  name: string
}

export type Tag = Ref & {
  annotated: boolean
}

export type Refs = {
  head: string | undefined
  heads: Ref[]
  tags: Tag[]
  remotes: Ref[]
}

const tag = "refs/tags/"
const head = "refs/heads/"
const remote = "refs/remotes/"
const peel = "^{}"

export function parseRefs(text: string): Refs {
  const heads: Ref[] = []
  const remotes: Ref[] = []
  const direct = new Map<string, string>()
  const peeled = new Map<string, string>()
  const order: string[] = []
  const seen = new Set<string>()
  let current: string | undefined

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const idx = line.indexOf(" ")
    if (idx === -1) continue

    const hash = line.slice(0, idx)
    const ref = line.slice(idx + 1)
    if (!hash || !ref) continue

    if (ref === "HEAD") {
      current = hash
      continue
    }

    if (ref.startsWith(head)) {
      heads.push({ hash, name: ref.slice(head.length) })
      continue
    }

    if (ref.startsWith(remote)) {
      const name = ref.slice(remote.length)
      if (name.endsWith("/HEAD")) continue
      remotes.push({ hash, name })
      continue
    }

    if (!ref.startsWith(tag)) continue

    const rawtag = ref.slice(tag.length)
    const name = rawtag.endsWith(peel) ? rawtag.slice(0, -peel.length) : rawtag
    if (!seen.has(name)) {
      seen.add(name)
      order.push(name)
    }
    if (rawtag.endsWith(peel)) peeled.set(name, hash)
    else direct.set(name, hash)
  }

  const tags: Tag[] = []
  for (const name of order) {
    const hash = peeled.get(name)
    if (hash) {
      tags.push({ hash, name, annotated: true })
      continue
    }
    const value = direct.get(name)
    if (value) tags.push({ hash: value, name, annotated: false })
  }

  return { head: current, heads, tags, remotes }
}
