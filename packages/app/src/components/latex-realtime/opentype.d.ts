declare module "opentype.js" {
  export interface PathCommand {
    type: "M" | "L" | "C" | "Q" | "Z"
    x?: number
    y?: number
    x1?: number
    y1?: number
    x2?: number
    y2?: number
  }
  export interface Glyph {
    path: { commands: PathCommand[] }
  }
  export interface Font {
    unitsPerEm: number
    numGlyphs: number
    glyphs: { get(index: number): Glyph | undefined; length: number }
  }
  export function parse(buffer: ArrayBuffer): Font
}
