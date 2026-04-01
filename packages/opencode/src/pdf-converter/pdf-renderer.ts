/**
 * PDF 页面渲染模块：调用 Python 脚本将 PDF 页面渲染为 PNG 图片
 */

import path from "path"
import type { PageRenderResult } from "./types"
import { Log } from "../util/log"
import { getAllPythonCandidates } from "../util/python-resolver"

const log = Log.create({ service: "pdf-renderer" })

/** Python 脚本路径 */
const RENDER_SCRIPT = path.join(import.meta.dir, "python", "render_page.py")

/** 检测可用的 Python 命令 */
let cachedPythonPath: string | null | undefined = undefined

export async function findPython(projectDir?: string): Promise<string | null> {
  if (cachedPythonPath !== undefined) return cachedPythonPath

  // Use cross-platform candidates with venv detection
  const candidates = getAllPythonCandidates(projectDir)
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
export async function checkPythonAvailable(projectDir?: string): Promise<{
  available: boolean
  pythonPath: string | null
  missingDeps: string[]
}> {
  const candidates = getAllPythonCandidates(projectDir)
  for (const cmd of candidates) {
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
  const defaultMissing = process.platform === "win32"
    ? ["Python", "PyMuPDF", "Pillow"]
    : ["Python3", "PyMuPDF", "Pillow"]
  return { available: false, pythonPath: null, missingDeps: defaultMissing }
}

/** 调用 Python 脚本渲染 PDF 页面 */
export async function renderPage(
  pdfPath: string,
  pageNum: number,
  outputDir: string,
  dpi: number = 400,
): Promise<PageRenderResult> {
  // Derive project directory from the PDF file's parent directory for venv detection
  const projectDir = path.dirname(pdfPath)
  const pythonPath = await findPython(projectDir)
  if (!pythonPath) {
    const pythonName = process.platform === "win32" ? "Python" : "Python3"
    throw new Error(`${pythonName} 环境不可用，请安装 ${pythonName}、PyMuPDF 和 Pillow`)
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
