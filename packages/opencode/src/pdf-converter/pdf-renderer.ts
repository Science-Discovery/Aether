/**
 * PDF 页面渲染模块：调用 Python 脚本将 PDF 页面渲染为 PNG 图片
 */

import path from "path"
import type { PageRenderResult } from "./types"
import { Log } from "../util/log"

const log = Log.create({ service: "pdf-renderer" })

/** Python 脚本路径 */
const RENDER_SCRIPT = path.join(import.meta.dir, "python", "render_page.py")

/** 检测可用的 Python 命令 */
let cachedPythonPath: string | null | undefined = undefined

export async function findPython(): Promise<string | null> {
  if (cachedPythonPath !== undefined) return cachedPythonPath

  // 也尝试常见的绝对路径
  const candidates = ["python3", "python", "/usr/bin/python3", "/usr/local/bin/python3"]
  for (const cmd of candidates) {
    try {
      const proc = Bun.spawn([cmd, "-c", "import fitz; from PIL import Image; print('ok')"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode === 0 && stdout.trim() === "ok") {
        cachedPythonPath = cmd
        return cmd
      }
    } catch {
      // 继续尝试下一个
    }
  }
  cachedPythonPath = null
  return null
}

/** 检查 Python 环境是否可用 */
export async function checkPythonAvailable(): Promise<{
  available: boolean
  pythonPath: string | null
  missingDeps: string[]
}> {
  for (const cmd of ["python3", "python", "/usr/bin/python3", "/usr/local/bin/python3"]) {
    try {
      const proc = Bun.spawn(
        [cmd, "-c", "import sys; print(sys.version); import fitz; from PIL import Image; print('deps_ok')"],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
      )
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode === 0 && stdout.includes("deps_ok")) {
        return { available: true, pythonPath: cmd, missingDeps: [] }
      }
      // Python 存在但缺少依赖
      const missing: string[] = []
      try {
        const check1 = Bun.spawn([cmd, "-c", "import fitz"], { stdout: "pipe", stderr: "pipe" })
        if ((await check1.exited) !== 0) missing.push("PyMuPDF")
      } catch {
        missing.push("PyMuPDF")
      }
      try {
        const check2 = Bun.spawn([cmd, "-c", "from PIL import Image"], { stdout: "pipe", stderr: "pipe" })
        if ((await check2.exited) !== 0) missing.push("Pillow")
      } catch {
        missing.push("Pillow")
      }
      if (missing.length > 0) {
        return { available: false, pythonPath: cmd, missingDeps: missing }
      }
    } catch {
      // 继续
    }
  }
  return { available: false, pythonPath: null, missingDeps: ["Python3", "PyMuPDF", "Pillow"] }
}

/** 调用 Python 脚本渲染 PDF 页面 */
export async function renderPage(
  pdfPath: string,
  pageNum: number,
  outputDir: string,
  dpi: number = 400,
): Promise<PageRenderResult> {
  const pythonPath = await findPython()
  if (!pythonPath) {
    throw new Error("Python 环境不可用，请安装 Python3、PyMuPDF 和 Pillow")
  }

  const input = JSON.stringify({
    pdf_path: pdfPath,
    page_num: pageNum,
    dpi,
    output_dir: outputDir,
  })

  log.info("rendering page", { pageNum, dpi })

  const proc = Bun.spawn([pythonPath, RENDER_SCRIPT, input], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    timeout: 60_000,
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    log.error("render failed", { pageNum, stderr })
    throw new Error(`渲染第 ${pageNum} 页失败: ${stderr || stdout}`)
  }

  const result = JSON.parse(stdout) as PageRenderResult | { error: string }
  if ("error" in result) {
    throw new Error(`渲染第 ${pageNum} 页失败: ${result.error}`)
  }

  return result
}
