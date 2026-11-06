export type Axis = { count: number; size: number; custom: Record<number, number> }
export type Region = { top: number; left: number; bottom: number; right: number }
export type Picture = { id: string; top: number; left: number; width: number; height: number }
export type Sheet = {
  id: number
  name: string
  rows: Axis
  columns: Axis
  images: Picture[]
}
export type Media = { id: string; mime: string; data: Uint8Array<ArrayBuffer> }
export type Cell = {
  address: string
  row: number
  column: number
  rows: number
  columns: number
  top: number
  left: number
  width: number
  height: number
  text: string
  formula?: string
  missing?: boolean
  unformatted?: boolean
  style: Record<string, string>
  runs?: { text: string; style: Record<string, string> }[]
}
export type Window = { sheet: number; rows: number[]; columns: number[] }
export type Request = { id: number } & ({ type: "load"; data: ArrayBuffer } | ({ type: "range" } & Window))
export type Reply = { id: number } & (
  | { type: "loaded"; sheets: Sheet[]; images: Media[] }
  | { type: "range"; sheet: number; cells: Cell[] }
  | { type: "error"; message: string }
)

export function label(column: number): string {
  let value = column
  let result = ""
  while (value > 0) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}
