// Adapted from realtime-tex-vsc-plugin (MIT). Type 1 outlines and pdftex.map parsing.
// Type1 fonts (.pfb/.pfa) and pdftex.map entries → glyph outlines by character code.
// TFM fonts in rtex display lists carry only a char code (no glyph index, no file); the
// backend finds their outlines through the map file. Pure module.

export interface MapEntry {
  tfm: string
  psname?: string
  fontFile?: string
  encFile?: string
  slant?: number
  extend?: number
}

/** Parse a pdftex.map / dvipdfm-style map file. */
export function parseMapFile(text: string): Map<string, MapEntry> {
  const out = new Map<string, MapEntry>()
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("%") || line.startsWith("#")) continue
    const tokens: string[] = []
    const re = /"([^"]*)"|(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) tokens.push(m[1] !== undefined ? `"${m[1]}` : m[2])
    if (tokens.length === 0) continue
    const e: MapEntry = { tfm: tokens[0] }
    for (const t of tokens.slice(1)) {
      if (t.startsWith('"')) {
        const ps = t.slice(1).trim().split(/\s+/)
        for (let i = 1; i < ps.length; i++) {
          if (ps[i] === "SlantFont") e.slant = parseFloat(ps[i - 1])
          if (ps[i] === "ExtendFont") e.extend = parseFloat(ps[i - 1])
        }
      } else if (t.startsWith("<")) {
        const f = t.replace(/^<[<[]?/, "")
        if (!f) continue
        if (/\.enc$/i.test(f)) e.encFile = f
        else e.fontFile = f
      } else if (e.psname === undefined && !/^\d+$/.test(t)) {
        e.psname = t
      }
    }
    if (!out.has(e.tfm)) out.set(e.tfm, e)
  }
  return out
}

/** Glyph names of an .enc file (`/Name [ /a /b … ] def`), indexed by code. */
export function parseEncFile(text: string): string[] {
  const noComments = text.replace(/%[^\n]*/g, "")
  const start = noComments.indexOf("[")
  const end = noComments.lastIndexOf("]")
  if (start < 0 || end < start) return []
  return noComments
    .slice(start + 1, end)
    .split(/\s+/)
    .filter((t) => t.startsWith("/"))
    .map((t) => t.slice(1))
}

export interface Type1Outlines {
  /** Font units per em (1 / FontMatrix[0]). */
  upem: number
  /** SVG path data per character code, font units, y up. */
  glyphs: Record<number, string>
}

interface Type1Font {
  fontMatrix: number[]
  encoding: (string | undefined)[]
  subrs: Uint8Array[]
  charStrings: Map<string, Uint8Array>
}

function latin1(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return s
}

function decrypt(data: Uint8Array, key: number, skip: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, data.length - skip))
  let r = key
  for (let i = 0; i < data.length; i++) {
    const c = data[i]
    const p = c ^ (r >> 8)
    r = ((c + r) * 52845 + 22719) & 0xffff
    if (i >= skip) out[i - skip] = p
  }
  return out
}

/** Split a .pfb/.pfa file into its cleartext and (still encrypted) eexec parts. */
function splitFont(file: Uint8Array): { clear: string; encrypted: Uint8Array } {
  if (file[0] === 0x80) {
    const clearParts: Uint8Array[] = []
    const binParts: Uint8Array[] = []
    let i = 0
    while (i + 6 <= file.length && file[i] === 0x80) {
      const type = file[i + 1]
      if (type === 3) break
      const len = file[i + 2] | (file[i + 3] << 8) | (file[i + 4] << 16) | (file[i + 5] << 24)
      const seg = file.subarray(i + 6, i + 6 + len)
      ;(type === 1 ? (binParts.length ? null : clearParts) : binParts)?.push(seg)
      i += 6 + len
    }
    const total = binParts.reduce((n, b) => n + b.length, 0)
    const encrypted = new Uint8Array(total)
    let o = 0
    for (const b of binParts) {
      encrypted.set(b, o)
      o += b.length
    }
    return { clear: clearParts.map(latin1).join(""), encrypted }
  }
  // PFA: cleartext, `eexec`, then hex
  const s = latin1(file)
  const at = s.indexOf("eexec")
  if (at < 0) return { clear: s, encrypted: new Uint8Array() }
  const hex = s.slice(at + 5).replace(/[^0-9a-fA-F]/g, "")
  const encrypted = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < encrypted.length; i++) encrypted[i] = parseInt(hex.substr(i * 2, 2), 16)
  return { clear: s.slice(0, at + 5), encrypted }
}

export function parseType1(file: Uint8Array): Type1Font {
  const { clear, encrypted } = splitFont(file)
  const fm = /\/FontMatrix\s*\[([^\]]*)\]/.exec(clear)
  const fontMatrix = fm ? fm[1].trim().split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0]
  let encoding: (string | undefined)[] = []
  if (/\/Encoding\s+StandardEncoding/.test(clear)) {
    encoding = STANDARD_ENCODING.slice()
  } else {
    const re = /dup\s+(\d+)\s*\/([^\s/]+)\s+put/g
    let m: RegExpExecArray | null
    while ((m = re.exec(clear))) encoding[Number(m[1])] = m[2]
  }
  const priv = decrypt(encrypted, 55665, 4)
  const ps = latin1(priv)
  const lenIVm = /\/lenIV\s+(-?\d+)/.exec(ps)
  const lenIV = lenIVm ? Number(lenIVm[1]) : 4
  const charDecrypt = (b: Uint8Array) => (lenIV < 0 ? b : decrypt(b, 4330, lenIV))

  const subrs: Uint8Array[] = []
  const subrsAt = ps.indexOf("/Subrs")
  const csAt = ps.indexOf("/CharStrings")
  if (subrsAt >= 0) {
    const re = /dup\s+(\d+)\s+(\d+)\s+(\S+) /g
    re.lastIndex = subrsAt
    let m: RegExpExecArray | null
    while ((m = re.exec(ps))) {
      if (csAt >= 0 && m.index > csAt) break
      const start = m.index + m[0].length
      const len = Number(m[2])
      subrs[Number(m[1])] = charDecrypt(priv.subarray(start, start + len))
      re.lastIndex = start + len
    }
  }
  const charStrings = new Map<string, Uint8Array>()
  if (csAt >= 0) {
    const re = /\/([^\s/[\]{}()<>%]+)\s+(\d+)\s+(\S+) /g
    re.lastIndex = csAt + "/CharStrings".length
    let m: RegExpExecArray | null
    while ((m = re.exec(ps))) {
      const start = m.index + m[0].length
      const len = Number(m[2])
      charStrings.set(m[1], charDecrypt(priv.subarray(start, start + len)))
      re.lastIndex = start + len
    }
  }
  return { fontMatrix, encoding, subrs, charStrings }
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** Interpret a Type1 charstring into SVG path data (font units, y up). */
export function charStringToPath(font: Type1Font, name: string): string | undefined {
  const cs = font.charStrings.get(name)
  if (!cs) return undefined
  const out: string[] = []
  draw(font, cs, 0, 0, out)
  return out.join(" ")
}

function draw(font: Type1Font, glyph: Uint8Array, ox: number, oy: number, out: string[]): void {
  const stack: number[] = []
  let x = 0
  let y = 0
  let sbx = 0
  let open = false
  let flexing = false
  let done = false
  const moveTo = (nx: number, ny: number) => {
    x = nx
    y = ny
    if (open) out.push("Z")
    open = false
  }
  const ensureOpen = () => {
    if (!open) {
      out.push(`M${r2(x + ox)} ${r2(y + oy)}`)
      open = true
    }
  }
  const lineTo = (nx: number, ny: number) => {
    ensureOpen()
    x = nx
    y = ny
    out.push(`L${r2(x + ox)} ${r2(y + oy)}`)
  }
  const curveTo = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    ensureOpen()
    out.push(`C${r2(x1 + ox)} ${r2(y1 + oy)} ${r2(x2 + ox)} ${r2(y2 + oy)} ${r2(x3 + ox)} ${r2(y3 + oy)}`)
    x = x3
    y = y3
  }
  const run = (code: Uint8Array, depth: number): void => {
    if (depth > 12) return
    let i = 0
    while (i < code.length && !done) {
      const v = code[i++]
      if (v >= 32) {
        if (v <= 246) stack.push(v - 139)
        else if (v <= 250) stack.push((v - 247) * 256 + code[i++] + 108)
        else if (v <= 254) stack.push(-(v - 251) * 256 - code[i++] - 108)
        else {
          stack.push((code[i] << 24) | (code[i + 1] << 16) | (code[i + 2] << 8) | code[i + 3])
          i += 4
        }
        continue
      }
      switch (v) {
        case 1: // hstem
        case 3: // vstem
          stack.length = 0
          break
        case 4: // vmoveto
          if (flexing) {
            stack.splice(stack.length - 1, 0, 0)
            break
          }
          moveTo(x, y + (stack.pop() ?? 0))
          stack.length = 0
          break
        case 5: {
          const [dx, dy] = stack.splice(-2)
          lineTo(x + dx, y + dy)
          stack.length = 0
          break
        }
        case 6:
          lineTo(x + (stack.pop() ?? 0), y)
          stack.length = 0
          break
        case 7:
          lineTo(x, y + (stack.pop() ?? 0))
          stack.length = 0
          break
        case 8: {
          const [a, b, c, d, e, f] = stack.splice(-6)
          curveTo(x + a, y + b, x + a + c, y + b + d, x + a + c + e, y + b + d + f)
          stack.length = 0
          break
        }
        case 9: // closepath
          if (open) out.push("Z")
          open = false
          stack.length = 0
          break
        case 10: {
          const idx = stack.pop() ?? -1
          const sub = font.subrs[idx]
          if (sub) run(sub, depth + 1)
          break
        }
        case 11: // return
          return
        case 13: {
          // hsbw
          const [s, _w] = stack.splice(-2)
          sbx = s
          x = s
          y = 0
          stack.length = 0
          break
        }
        case 14: // endchar
          done = true
          break
        case 21: {
          if (flexing) break // flex points stay on the stack
          const [dx, dy] = stack.splice(-2)
          moveTo(x + dx, y + dy)
          stack.length = 0
          break
        }
        case 22:
          if (flexing) {
            stack.push(0)
            break
          }
          moveTo(x + (stack.pop() ?? 0), y)
          stack.length = 0
          break
        case 30: {
          const [dy1, dx2, dy2, dx3] = stack.splice(-4)
          curveTo(x, y + dy1, x + dx2, y + dy1 + dy2, x + dx2 + dx3, y + dy1 + dy2)
          stack.length = 0
          break
        }
        case 31: {
          const [dx1, dx2, dy2, dy3] = stack.splice(-4)
          curveTo(x + dx1, y, x + dx1 + dx2, y + dy2, x + dx1 + dx2, y + dy2 + dy3)
          stack.length = 0
          break
        }
        case 12: {
          const op = code[i++]
          switch (op) {
            case 0: // dotsection
            case 1: // vstem3
            case 2: // hstem3
              stack.length = 0
              break
            case 6: {
              // seac
              const [asb, adx, ady, bchar, achar] = stack.splice(-5)
              stack.length = 0
              const base = font.charStrings.get(STANDARD_ENCODING[bchar] ?? "")
              const accent = font.charStrings.get(STANDARD_ENCODING[achar] ?? "")
              if (open) out.push("Z")
              open = false
              if (base) draw(font, base, ox, oy, out)
              if (accent) draw(font, accent, ox + adx + sbx - asb, oy + ady, out)
              done = true
              break
            }
            case 7: {
              // sbw
              const [s, sy] = stack.splice(-4)
              sbx = s
              x = s
              y = sy
              stack.length = 0
              break
            }
            case 12: {
              const b = stack.pop() ?? 1
              const a = stack.pop() ?? 0
              stack.push(a / b)
              break
            }
            case 16: {
              // callothersubr: flex (0, 1, 2) and hint replacement (3); other args stay on
              // the stack for the following `pop`s (which are no-ops)
              const idx = stack.pop() ?? -1
              const n = stack.pop() ?? 0
              if (idx === 1 && n === 0) flexing = true
              else if (idx === 0 && n === 3 && flexing) {
                const endY = stack.pop() ?? 0
                const endX = stack.pop() ?? 0
                stack.pop() // flex height
                const pts = stack.splice(-14)
                flexing = false
                if (pts.length === 14) {
                  let cx = x + pts[0]
                  let cy = y + pts[1]
                  const p: number[] = []
                  for (let k = 2; k < 14; k += 2) {
                    cx += pts[k]
                    cy += pts[k + 1]
                    p.push(cx, cy)
                  }
                  curveTo(p[0], p[1], p[2], p[3], p[4], p[5])
                  curveTo(p[6], p[7], p[8], p[9], p[10], p[11])
                }
                stack.push(endX, endY)
              }
              break
            }
            case 17: // pop
              break
            case 33: // setcurrentpoint
              stack.length = 0
              break
            default:
              stack.length = 0
          }
          break
        }
        default:
          stack.length = 0
      }
    }
  }
  run(glyph, 0)
  if (open) out.push("Z")
}

/** Outlines of all encoded glyphs of a Type1 font. `encoding` overrides the font's own. */
export function type1Outlines(file: Uint8Array, encoding?: string[]): Type1Outlines {
  const font = parseType1(file)
  const enc = encoding && encoding.length ? encoding : font.encoding
  const glyphs: Record<number, string> = {}
  for (let code = 0; code < Math.min(256, enc.length); code++) {
    const name = enc[code]
    if (!name || name === ".notdef") continue
    const p = charStringToPath(font, name)
    if (p) glyphs[code] = p
  }
  const upem = font.fontMatrix[0] ? Math.round(1 / font.fontMatrix[0]) : 1000
  return { upem, glyphs }
}

// Adobe StandardEncoding (used by `seac` and by fonts declaring `/Encoding StandardEncoding`).
const STANDARD_ENCODING: (string | undefined)[] = (() => {
  const e: (string | undefined)[] = []
  const ascii =
    "space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde"
  ascii.split(" ").forEach((n, i) => (e[32 + i] = n))
  const high: Record<number, string> = {
    161: "exclamdown",
    162: "cent",
    163: "sterling",
    164: "fraction",
    165: "yen",
    166: "florin",
    167: "section",
    168: "currency",
    169: "quotesingle",
    170: "quotedblleft",
    171: "guillemotleft",
    172: "guilsinglleft",
    173: "guilsinglright",
    174: "fi",
    175: "fl",
    177: "endash",
    178: "dagger",
    179: "daggerdbl",
    180: "periodcentered",
    182: "paragraph",
    183: "bullet",
    184: "quotesinglbase",
    185: "quotedblbase",
    186: "quotedblright",
    187: "guillemotright",
    188: "ellipsis",
    189: "perthousand",
    191: "questiondown",
    193: "grave",
    194: "acute",
    195: "circumflex",
    196: "tilde",
    197: "macron",
    198: "breve",
    199: "dotaccent",
    200: "dieresis",
    202: "ring",
    203: "cedilla",
    205: "hungarumlaut",
    206: "ogonek",
    207: "caron",
    208: "emdash",
    225: "AE",
    227: "ordfeminine",
    232: "Lslash",
    233: "Oslash",
    234: "OE",
    235: "ordmasculine",
    241: "ae",
    245: "dotlessi",
    248: "lslash",
    249: "oslash",
    250: "oe",
    251: "germandbls",
  }
  for (const [k, v] of Object.entries(high)) e[Number(k)] = v
  return e
})()
