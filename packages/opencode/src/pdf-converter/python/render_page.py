#!/usr/bin/env python3
"""
PDF 页面渲染脚本：将 PDF 指定页面渲染为 PNG 图片。
同时提取嵌入式文本和统计嵌入式图片数量。

输入：通过 sys.argv[1] 传入 JSON 字符串
输出：通过 stdout 输出 JSON 结果
"""

import sys
import json
import fitz  # PyMuPDF


def render_page(pdf_path: str, page_num: int, dpi: int, output_dir: str) -> dict:
    """
    渲染 PDF 指定页面为 PNG 图片。

    Args:
        pdf_path: PDF 文件绝对路径
        page_num: 页码（1-based）
        dpi: 渲染 DPI
        output_dir: 输出目录绝对路径

    Returns:
        包含图片路径、尺寸、嵌入式文本和图片数量的字典
    """
    import os
    os.makedirs(output_dir, exist_ok=True)

    doc = fitz.open(pdf_path)
    try:
        # 页码转为 0-based
        page_index = page_num - 1
        if page_index < 0 or page_index >= len(doc):
            raise ValueError(f"页码 {page_num} 超出范围 (1-{len(doc)})")

        page = doc[page_index]

        # 计算缩放比例
        zoom = dpi / 72.0

        # 安全措施：限制最大像素尺寸 4000px
        max_pixels = 4000
        page_rect = page.rect
        expected_width = page_rect.width * zoom
        expected_height = page_rect.height * zoom

        actual_dpi = dpi
        if expected_width > max_pixels or expected_height > max_pixels:
            scale_factor = max_pixels / max(expected_width, expected_height)
            zoom *= scale_factor
            actual_dpi = int(dpi * scale_factor)

        # 渲染页面
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)

        # 保存为 PNG
        output_path = os.path.join(output_dir, f"page_{page_num:03d}.png")
        pix.save(output_path)

        # 提取嵌入式文本
        embedded_text = page.get_text("text").strip()

        # 统计嵌入式图片数量（仅光栅图片）
        embedded_image_count = len(page.get_images(full=True))

        # 检测矢量图形（费曼图、示意图等 PDF path 绘图）
        # 阈值 10：排除页面边框、页眉分隔线等少量装饰性线条
        drawings = page.get_drawings()
        has_vector_figures = len(drawings) > 10

        return {
            "image_path": output_path,
            "width": pix.width,
            "height": pix.height,
            "actual_dpi": actual_dpi,
            "embedded_text": embedded_text if len(embedded_text) > 50 else "",
            "embedded_image_count": embedded_image_count,
            "has_vector_figures": has_vector_figures,
        }
    finally:
        doc.close()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "缺少输入参数"}))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
        result = render_page(
            pdf_path=params["pdf_path"],
            page_num=params["page_num"],
            dpi=params.get("dpi", 400),
            output_dir=params["output_dir"],
        )
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
