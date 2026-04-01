/**
 * 图片裁剪模块：调用 Python 脚本按 bbox 坐标裁剪图片
 */

import path from "path"
import type { CropResult } from "./types"
import { findPython } from "./pdf-renderer"
import { Log } from "../util/log"

const log = Log.create({ service: "image-cropper" })

const CROP_SCRIPT = path.join(import.meta.dir, "python", "crop_image.py")

export async function cropImage(
  imagePath: string,
  bbox: [number, number, number, number],
  outputPath: string,
): Promise<CropResult> {
  // Derive project directory from the image file's parent for venv detection
  const projectDir = path.dirname(imagePath)
  const pythonPath = await findPython(projectDir)
  if (!pythonPath) {
    const pythonName = process.platform === "win32" ? "Python" : "Python3"
    throw new Error(`${pythonName} 环境不可用`)
  }

  const input = JSON.stringify({
    image_path: imagePath,
    bbox,
    output_path: outputPath,
  })

  log.info("cropping image", { imagePath, bbox, outputPath })

  const proc = Bun.spawn([pythonPath, CROP_SCRIPT, input], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    log.error("crop failed", { stderr })
    throw new Error(`图片裁剪失败: ${stderr || stdout}`)
  }

  const result = JSON.parse(stdout) as CropResult | { error: string }
  if ("error" in result) {
    throw new Error(`图片裁剪失败: ${result.error}`)
  }

  return result
}
