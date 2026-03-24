#!/usr/bin/env python3
"""
图片裁剪脚本：按归一化 bbox 坐标裁剪图片。

输入：通过 sys.argv[1] 传入 JSON 字符串
输出：通过 stdout 输出 JSON 结果
"""

import sys
import json
from PIL import Image


def crop_image(image_path: str, bbox: list, output_path: str) -> dict:
    """
    按归一化 bbox 坐标裁剪图片。

    Args:
        image_path: 源图片绝对路径
        bbox: 归一化坐标 [x0, y0, x1, y1]，每个值在 0-1 之间
        output_path: 输出图片绝对路径

    Returns:
        包含输出路径和裁剪后尺寸的字典
    """
    import os
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    img = Image.open(image_path)
    width, height = img.size

    # 归一化坐标转像素坐标
    x0 = int(bbox[0] * width)
    y0 = int(bbox[1] * height)
    x1 = int(bbox[2] * width)
    y1 = int(bbox[3] * height)

    # 确保坐标在合法范围内
    x0 = max(0, min(x0, width))
    y0 = max(0, min(y0, height))
    x1 = max(0, min(x1, width))
    y1 = max(0, min(y1, height))

    # 确保裁剪区域有效
    if x1 <= x0 or y1 <= y0:
        raise ValueError(f"无效的裁剪区域: ({x0}, {y0}, {x1}, {y1})")

    cropped = img.crop((x0, y0, x1, y1))
    cropped.save(output_path, "PNG")

    return {
        "output_path": output_path,
        "width": cropped.width,
        "height": cropped.height,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "缺少输入参数"}))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
        result = crop_image(
            image_path=params["image_path"],
            bbox=params["bbox"],
            output_path=params["output_path"],
        )
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
