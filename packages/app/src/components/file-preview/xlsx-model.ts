import Excel from "exceljs"
import { format } from "ssf"
import { label, type Axis, type Cell, type Media, type Region, type Sheet, type Window } from "./xlsx-types"

const palette = [
  "FFFFFF",
  "000000",
  "E7E6E6",
  "44546A",
  "4472C4",
  "ED7D31",
  "A5A5A5",
  "FFC000",
  "5B9BD5",
  "70AD47",
  "0563C1",
  "954F72",
]
const indexed = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF"]

function color(value?: Partial<Excel.Color> & { indexed?: number; tint?: number }) {
  if (!value) return
  const hex =
    value.argb?.slice(-6) ??
    (value.theme !== undefined
      ? palette[value.theme]
      : value.indexed !== undefined && value.indexed < 16
        ? indexed[value.indexed % 8]
        : undefined)
  if (!hex || !/^[a-f\d]{6}$/i.test(hex)) return
  const tint = Math.max(-1, Math.min(1, value.tint ?? 0))
  return (
    "#" +
    hex
      .match(/../g)!
      .map((part) => {
        const channel = parseInt(part, 16)
        return Math.round(tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint)
          .toString(16)
          .padStart(2, "0")
      })
      .join("")
  )
}

function font(value?: Partial<Excel.Font>) {
  const style: Record<string, string> = {}
  if (!value) return style
  if (value.name) style["font-family"] = value.name
  if (value.size) style["font-size"] = `${(value.size * 4) / 3}px`
  if (value.bold) style["font-weight"] = "700"
  if (value.italic) style["font-style"] = "italic"
  const decoration = [
    value.underline && value.underline !== "none" ? "underline" : "",
    value.strike ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ")
  if (decoration) style["text-decoration"] = decoration
  const ink = color(value.color)
  if (ink) style.color = ink
  return style
}

function style(cell?: Excel.Cell) {
  const result = font(cell?.font)
  if (!cell) return result
  if (cell.fill?.type === "pattern" && cell.fill.pattern !== "none") {
    const fill = color(cell.fill.fgColor ?? cell.fill.bgColor)
    if (fill) result["background-color"] = fill
  }
  const alignment = cell.alignment
  const horizontal = alignment?.horizontal
  result["text-align"] =
    horizontal === "centerContinuous"
      ? "center"
      : horizontal === "fill" || horizontal === "distributed"
        ? "left"
        : (horizontal ??
          (typeof cell.value === "number" || cell.value instanceof Date || typeof cell.result === "number"
            ? "right"
            : "left"))
  result["align-items"] =
    alignment?.vertical === "top" ? "flex-start" : alignment?.vertical === "middle" ? "center" : "flex-end"
  result["white-space"] = alignment?.wrapText ? "pre-wrap" : "pre"
  if (alignment?.indent) result["padding-left"] = `${4 + alignment.indent * 10}px`
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const border = cell.border?.[side]
    if (!border?.style) continue
    const width = border.style === "thick" || border.style === "double" ? 3 : border.style.startsWith("medium") ? 2 : 1
    const pattern =
      border.style === "double"
        ? "double"
        : border.style === "dotted"
          ? "dotted"
          : /dash/i.test(border.style)
            ? "dashed"
            : "solid"
    result[`border-${side}`] = `${width}px ${pattern} ${color(border.color) ?? "#000000"}`
  }
  return result
}

function content(cell: Excel.Cell | undefined, epoch: boolean) {
  if (!cell) return { text: "" }
  const value = cell.value
  const formula =
    value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)
      ? cell.formula || ("sharedFormula" in value ? value.sharedFormula : value.formula)
      : undefined
  const output = formula ? cell.result : value
  if (formula && (output === undefined || output === null)) return { text: "", formula, missing: true }
  if (output === undefined || output === null) return { text: "", formula }
  if (typeof output === "object" && "richText" in output)
    return {
      text: output.richText.map((run) => run.text).join(""),
      runs: output.richText.map((run) => ({ text: run.text, style: font(run.font) })),
      formula,
    }
  if (typeof output === "object" && "text" in output) return { text: output.text, formula }
  if (typeof output === "object" && "error" in output) return { text: output.error, formula }
  const serial = output instanceof Date ? output.getTime() / 86_400_000 + 25569 - (epoch ? 1462 : 0) : output
  if (typeof serial === "number") {
    // ExcelJS dates are UTC. Converting back to a serial preserves both date systems and serial 60.
    try {
      return {
        text: format(cell.numFmt || (output instanceof Date ? "yyyy-mm-dd" : "General"), serial, { date1904: epoch }),
        formula,
      }
    } catch {
      // SSF does not support every format Excel accepts; keep the cell's value readable.
      return {
        text: output instanceof Date ? format("yyyy-mm-dd hh:mm:ss", serial, { date1904: epoch }) : String(serial),
        formula,
        unformatted: true,
      }
    }
  }
  return { text: typeof serial === "boolean" ? (serial ? "TRUE" : "FALSE") : String(serial), formula }
}

function coordinates(axis: Axis) {
  const keys = Object.keys(axis.custom)
    .map(Number)
    .sort((a, b) => a - b)
  const sums = [0]
  keys.forEach((key, index) => sums.push(sums[index] + axis.custom[key] - axis.size))
  return (index: number) => {
    let low = 0
    let high = keys.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (keys[middle] <= index) low = middle + 1
      else high = middle
    }
    return index * axis.size + sums[low]
  }
}

export async function read(data: ArrayBuffer) {
  const book = new Excel.Workbook()
  await book.xlsx.load(data)
  const images = new Map<string, Media>()
  const sheets = book.worksheets
    .filter((sheet) => sheet.state === "visible")
    .map((sheet) => {
      // ExcelJS 4.4's public model getter copies every cell and drops empty hidden rows.
      // Read its existing sparse records once; viewport reads only use public findCell.
      const sparse = sheet as Excel.Worksheet & {
        _rows: (Excel.Row | undefined)[]
        _merges: Record<string, Excel.Range>
      }
      const merges: Region[] = Object.values(sparse._merges).map((merge) => ({
        top: merge.top,
        left: merge.left,
        bottom: merge.bottom,
        right: merge.right,
      }))
      const rows: Axis = {
        count: 30,
        size: Math.max(1, ((sheet.properties.defaultRowHeight || 15) * 4) / 3),
        custom: {},
      }
      const columns: Axis = {
        count: 10,
        size: Math.max(1, Math.round((sheet.properties.defaultColWidth || 8.43) * 7 + 5)),
        custom: {},
      }
      sparse._rows.forEach((row) => {
        if (!row) return
        if (row.hidden || row.height !== undefined)
          rows.custom[row.number] = row.hidden ? 0 : Math.max(1, (row.height! * 4) / 3)
      })
      sheet.columns?.forEach((column, index) => {
        if (column.hidden || column.width !== undefined)
          columns.custom[index + 1] = column.hidden ? 0 : Math.max(1, Math.round(column.width! * 7 + 5))
      })
      sheet.eachRow((row) =>
        row.eachCell((cell, column) => {
          rows.count = Math.max(rows.count, row.number)
          columns.count = Math.max(columns.count, column)
        }),
      )
      merges.forEach((merge) => {
        rows.count = Math.max(rows.count, merge.bottom)
        columns.count = Math.max(columns.count, merge.right)
      })
      const top = coordinates(rows)
      const left = coordinates(columns)
      const pictures = sheet.getImages().flatMap((image) => {
        const media = book.getImage(Number(image.imageId))
        if (!media?.buffer || !["png", "jpeg", "gif"].includes(media.extension)) return []
        const id = String(image.imageId)
        if (!images.has(id))
          images.set(id, { id, mime: `image/${media.extension}`, data: new Uint8Array(media.buffer) })
        const range = image.range as Excel.ImageRange & { ext?: { width: number; height: number } }
        const x = left(range.tl.nativeCol) + range.tl.nativeColOff / 9525
        const y = top(range.tl.nativeRow) + range.tl.nativeRowOff / 9525
        const width = range.ext?.width ?? left(range.br.nativeCol) + range.br.nativeColOff / 9525 - x
        const height = range.ext?.height ?? top(range.br.nativeRow) + range.br.nativeRowOff / 9525 - y
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return []
        rows.count = Math.max(
          rows.count,
          range.br ? range.br.nativeRow + 1 : range.tl.nativeRow + Math.ceil(height / rows.size) + 1,
        )
        columns.count = Math.max(
          columns.count,
          range.br ? range.br.nativeCol + 1 : range.tl.nativeCol + Math.ceil(width / columns.size) + 1,
        )
        return [{ id, top: y, left: x, width, height }]
      })
      const metadata: Sheet = { id: sheet.id, name: sheet.name, rows, columns, images: pictures }
      return { sheet, merges, top, left, metadata }
    })
  if (!sheets.length) throw new Error("The workbook has no visible worksheets")
  return {
    sheets: sheets.map((sheet) => sheet.metadata),
    images: [...images.values()],
    range(input: Window): Cell[] {
      const found = sheets.find((sheet) => sheet.sheet.id === input.sheet)
      if (!found) throw new Error("Worksheet not found")
      const rows = [...new Set(input.rows)].filter(
        (row) =>
          Number.isInteger(row) &&
          row >= 1 &&
          row <= found.metadata.rows.count &&
          found.metadata.rows.custom[row] !== 0,
      )
      const columns = [...new Set(input.columns)].filter(
        (column) =>
          Number.isInteger(column) &&
          column >= 1 &&
          column <= found.metadata.columns.count &&
          found.metadata.columns.custom[column] !== 0,
      )
      if (!rows.length || !columns.length) return []
      const merges = found.merges.filter(
        (merge) =>
          merge.bottom >= rows[0] &&
          merge.top <= rows.at(-1)! &&
          merge.right >= columns[0] &&
          merge.left <= columns.at(-1)!,
      )
      const output = (row: number, column: number, merge?: Region): Cell => {
        const cell = found.sheet.findCell(row, column)
        const bottom = merge?.bottom ?? row
        const right = merge?.right ?? column
        return {
          address: `${label(column)}${row}`,
          row,
          column,
          rows: bottom - row + 1,
          columns: right - column + 1,
          top: found.top(row - 1),
          left: found.left(column - 1),
          height: found.top(bottom) - found.top(row - 1),
          width: found.left(right) - found.left(column - 1),
          ...content(cell, !!book.properties.date1904),
          style: style(cell),
        }
      }
      return [
        ...rows.flatMap((row) =>
          columns
            .filter(
              (column) =>
                !merges.some(
                  (merge) => row >= merge.top && row <= merge.bottom && column >= merge.left && column <= merge.right,
                ),
            )
            .map((column) => output(row, column)),
        ),
        ...merges.map((merge) => output(merge.top, merge.left, merge)),
      ]
    },
  }
}
