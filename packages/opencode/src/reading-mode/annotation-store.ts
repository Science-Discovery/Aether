import fs from "fs/promises"
import path from "path"
import type { ReadingMode } from "./types"

export namespace AnnotationStore {
  export async function read(annotationsPath: string): Promise<ReadingMode.AnnotationFile> {
    try {
      const raw = await fs.readFile(annotationsPath, "utf-8")
      return JSON.parse(raw) as ReadingMode.AnnotationFile
    } catch {
      return { version: "1.0", pdfStorePath: "", annotations: [], bookmarks: [], lastReadPage: 1 }
    }
  }

  export async function write(annotationsPath: string, data: ReadingMode.AnnotationFile): Promise<void> {
    await fs.mkdir(path.dirname(annotationsPath), { recursive: true })
    await fs.writeFile(annotationsPath, JSON.stringify(data, null, 2), "utf-8")
  }

  export async function updateLastPage(annotationsPath: string, page: number): Promise<void> {
    const data = await read(annotationsPath)
    data.lastReadPage = page
    await write(annotationsPath, data)
  }
}
