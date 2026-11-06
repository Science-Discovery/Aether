import { describe, expect, spyOn, test } from "bun:test"
import Excel from "exceljs"
import { read } from "./xlsx-model"
import type { Reply } from "./xlsx-types"

async function bytes(book: Excel.Workbook) {
  return new Uint8Array(await book.xlsx.writeBuffer()).buffer
}

describe("workbook preview model", () => {
  test("falls back per cell for an Excel currency format unsupported by SSF", async () => {
    const book = new Excel.Workbook()
    const sheet = book.addWorksheet("Currency")
    sheet.getCell("C3").value = 1234.5
    sheet.getCell("C3").numFmt = "¥#,##0.00"
    sheet.getCell("D3").value = 0.25
    sheet.getCell("D3").numFmt = "0%"
    const model = await read(await bytes(book))
    const cells = model.range({ sheet: sheet.id, rows: [3], columns: [3, 4] })
    expect(cells[0]).toMatchObject({ text: "1234.5", unformatted: true })
    expect(cells[1]).toMatchObject({ text: "25%" })
    expect(cells[1].unformatted).toBeUndefined()
  })
  test("formats real workbook values, basic styles, rich text and cached or missing formulas", async () => {
    const book = new Excel.Workbook()
    const sheet = book.addWorksheet("计算与格式")
    sheet.getColumn(1).width = 20
    sheet.getRow(1).height = 30
    sheet.getCell("A1").value = 1234.567
    sheet.getCell("A1").numFmt = "#,##0.00"
    sheet.getCell("A1").font = { name: "Arial", size: 12, bold: true, color: { argb: "FF123456" } }
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEAA" } }
    sheet.getCell("A1").border = { bottom: { style: "double", color: { argb: "FF0000FF" } } }
    sheet.getCell("A2").value = 0.125
    sheet.getCell("A2").numFmt = "0.0%"
    sheet.getCell("A3").value = { formula: "SUM(1,2)", result: 3 }
    sheet.getCell("A4").value = { formula: "1-1", result: 0 }
    sheet.getCell("A5").value = { formula: "1=2", result: false }
    sheet.getCell("A6").value = { formula: "SUM(B1:B20)" }
    sheet.getCell("A7").value = {
      richText: [
        { text: "中文", font: { bold: true } },
        { text: "\ntext", font: { italic: true } },
      ],
    }
    sheet.getCell("A7").alignment = { wrapText: true, vertical: "middle" }
    sheet.getCell("A8").value = { formula: "1/0", result: { error: "#DIV/0!" } }
    sheet.getCell("A9").value = { text: "Example", hyperlink: "https://example.invalid" }
    const model = await read(await bytes(book))
    const cells = model.range({ sheet: model.sheets[0].id, rows: [1, 2, 3, 4, 5, 6, 7, 8, 9], columns: [1] })
    expect(cells.map((cell) => cell.text)).toEqual([
      "1,234.57",
      "12.5%",
      "3",
      "0",
      "FALSE",
      "",
      "中文\ntext",
      "#DIV/0!",
      "Example",
    ])
    expect(cells[0]).toMatchObject({
      width: 145,
      height: 40,
      style: {
        "font-weight": "700",
        "font-size": "16px",
        color: "#123456",
        "background-color": "#eeeeaa",
        "border-bottom": "3px double #0000ff",
      },
    })
    expect(cells[5]).toMatchObject({ formula: "SUM(B1:B20)", missing: true })
    expect(cells[6].runs).toEqual([
      { text: "中文", style: { "font-weight": "700" } },
      { text: "\ntext", style: { "font-style": "italic" } },
    ])
    expect(cells[6].style).toMatchObject({ "white-space": "pre-wrap", "align-items": "center" })
  })

  test.each([false, true])("preserves UTC dates and the %s date1904 epoch", async (epoch) => {
    const book = new Excel.Workbook()
    book.properties.date1904 = epoch
    const sheet = book.addWorksheet("Dates")
    sheet.getCell("A1").value = new Date("2024-01-02T23:45:06Z")
    sheet.getCell("A1").numFmt = "yyyy-mm-dd hh:mm:ss"
    sheet.getCell("A2").value = epoch ? 0 : 60
    sheet.getCell("A2").numFmt = "yyyy-mm-dd"
    sheet.getCell("A3").value = { formula: "A1", result: new Date("2024-01-02T23:45:06Z") }
    sheet.getCell("A3").numFmt = "yyyy-mm-dd hh:mm:ss"
    const model = await read(await bytes(book))
    expect(model.range({ sheet: model.sheets[0].id, rows: [1, 2, 3], columns: [1] }).map((cell) => cell.text)).toEqual([
      "2024-01-02 23:45:06",
      epoch ? "1904-01-01" : "1900-02-29",
      "2024-01-02 23:45:06",
    ])
  })

  test("renders an offscreen merge master once and never creates empty cells for a viewport", async () => {
    const book = new Excel.Workbook()
    const sheet = book.addWorksheet("Merged")
    sheet.mergeCells("B2:D20")
    sheet.getCell("B2").value = "跨可视区域"
    const model = await read(await bytes(book))
    const allocate = spyOn(Object.getPrototypeOf(sheet), "getCell")
    try {
      const cells = model.range({ sheet: model.sheets[0].id, rows: [10, 11], columns: [3, 4, 5] })
      expect(cells.map((cell) => cell.address)).toEqual(["E10", "E11", "B2"])
      expect(cells.at(-1)).toMatchObject({
        text: "跨可视区域",
        top: 20,
        left: 64,
        width: 192,
        height: 380,
        rows: 19,
        columns: 3,
      })
      expect(allocate).not.toHaveBeenCalled()
    } finally {
      allocate.mockRestore()
    }
  })

  test("keeps styled empty sheets small, preserves hidden geometry, and filters hidden sheets", async () => {
    const book = new Excel.Workbook()
    const sheet = book.addWorksheet("Empty")
    sheet.getCell("XFD1048576").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } }
    sheet.getRow(2).hidden = true
    sheet.getRow(2).height = 15
    sheet.getColumn(2).hidden = true
    book.addWorksheet("Hidden", { state: "hidden" }).getCell("A1").value = "secret"
    const model = await read(await bytes(book))
    expect(model.sheets).toHaveLength(1)
    expect(model.sheets[0].rows.count).toBe(30)
    expect(model.sheets[0].columns.count).toBe(10)
    const cells = model.range({ sheet: model.sheets[0].id, rows: [1, 2, 3], columns: [1, 2, 3] })
    expect(cells.map((cell) => cell.address)).toEqual(["A1", "C1", "A3", "C3"])
    expect(cells.at(-1)).toMatchObject({ top: 20, left: 64 })
  })

  test("returns embedded image bytes with sheet anchors and sheet-specific viewports", async () => {
    const book = new Excel.Workbook()
    const first = book.addWorksheet("First")
    first.getCell("A1").value = "first"
    const second = book.addWorksheet("Second")
    second.getCell("A1").value = "second"
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM0aHjAwMDAxAAGABI6AZQGIdGbAAAAAElFTkSuQmCC"
    const id = book.addImage({ base64: png, extension: "png" })
    second.addImage(id, { tl: { col: 1, row: 2 }, ext: { width: 80, height: 40 } })
    const model = await read(await bytes(book))
    expect(model.images[0].mime).toBe("image/png")
    expect(Buffer.from(model.images[0].data).toString("base64")).toBe(png)
    expect(model.sheets[1].images).toEqual([{ id: "0", top: 40, left: 64, width: 80, height: 40 }])
    expect(model.sheets[0].images).toEqual([])
    expect(model.range({ sheet: second.id, rows: [1], columns: [1] })[0].text).toBe("second")
  })

  test("loads and queries the actual worker using transferable buffers", async () => {
    const book = new Excel.Workbook()
    book.addWorksheet("Worker").getCell("A1").value = "worker result"
    const data = await bytes(book)
    const worker = new Worker(new URL("./xlsx-worker.ts", import.meta.url).href)
    try {
      const loaded = new Promise<Reply>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = reject
      })
      worker.postMessage({ id: 1, type: "load", data }, [data])
      const first = await loaded
      expect(first.type).toBe("loaded")
      if (first.type !== "loaded") throw new Error("Worker did not load workbook")
      const response = new Promise<Reply>((resolve) => {
        worker.onmessage = (event) => resolve(event.data)
      })
      worker.postMessage({ id: 2, type: "range", sheet: first.sheets[0].id, rows: [1], columns: [1] })
      const next = await response
      expect(next).toMatchObject({ id: 2, type: "range", cells: [{ address: "A1", text: "worker result" }] })
    } finally {
      worker.terminate()
    }
  }, 15_000)

  test("rejects damaged or unsupported workbook bytes", async () => {
    await expect(read(new TextEncoder().encode("not an xlsx").buffer)).rejects.toThrow()
  })
})
