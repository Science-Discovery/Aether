# PDF 批注与导出

## 编辑与保存

批注卡片使用应用主题，支持英文、简体中文和繁体中文。新建 Note 在点击保存后才加入草稿；取消、关闭或 Escape 不生成批注。编辑已有批注时，取消不改变已保存内容。

草稿继续使用 `1.2` 格式和现有 `file/pdf-annotations` 接口。同一文档在当前应用窗口的不同阅读视图共享保存队列。较早的保存响应不会覆盖较新的编辑；文档切换后，旧请求和旧 iframe 消息不能写入新文档。批注操作同时要求草稿与对应 PDF 页面加载成功，避免新草稿先到达时操作旧页面。

导出会等待最新保存完成。保存失败时，当前应用窗口保留待保存内容，显示重试入口，并阻止下载服务端旧版本；重试成功后可再次导出。尚未成功保存的内容不保证在整个应用退出或刷新后保留。

## 原生 PDF 结构

- Note 使用标准 `Text` 便签与双向关联的 `Popup`，便签具有显式矢量 `AP` 图标。
- 新增便签位于批注数组前部，避免 Chrome 先命中已有或新增的大面积高亮。正文仍只存在于便签中，不复制到伴随高亮。
- 图标位置按整段选区计算，优先放在选区右侧，其次寻找左侧或上下的页内空位，并避开已放置的新图标。旋转与 CropBox 在显示坐标中处理。整页没有空位时选页内重叠最少的位置，无法保证完全避开内容。
- 每条 Note 的完整正文只存放一次，位于首个有效选区所在页；跨页的选区高亮仍保留。
- Highlight、Underline、StrikeOut 具有独立外观流，保留颜色。备注使用 Unicode 字符串和 PDF 换行约定。
- 新批注加入原 PDF 的批注数组，原有批注及其相对顺序保留；不修改源 PDF，也不把备注烘焙成页面图片。
- 已有 Aether 草稿可以直接重新导出，无需迁移。

结构依据：[PDF 32000-1:2008，第 12.5 节](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf)。

## 浏览器验收记录（2026-10-30，Windows）

通过真实 `PdfAnnotations.exportPdf` 生成独立 PDF，直接交给浏览器原生阅读器打开，未加载 Aether 草稿。样例包含中文及英文三行备注、跨页选区、四种页面旋转、CropBox、边缘便签，以及高亮、下划线和删除线。

| 阅读器               | 实际结果                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Edge 156.0.4314.50   | 标记可见；点击便签可打开完整中文与英文多行备注；重新打开后保留。旋转和裁切页面标记正常。                                           |
| Chrome 156.0.8078.48 | 标记可见，悬停可打开弹窗，重新打开后保留；弹窗显示标题和英文，但中文未显示。有界面与无界面启动均复现，**完整中文备注验收未通过**。 |

Chrome 的现象与 PDFium 已公开实现中的限制一致：其原生阅读器忽略文件自带的 Popup，自行复制 `T`、`Contents` 生成弹窗，使用 Helvetica/WinAnsi 字体；字体映射未提供资源字典，系统字体回退无法初始化。给文件补充 `DA`、`DR`、`RC` 或 Popup 外观不能改变这条路径。中文正文仍完整存在于 PDF 中，Edge 和 PDF.js 均可读取。

相关官方源码：[弹窗创建](https://pdfium.googlesource.com/pdfium/+/refs/heads/chromium/7926/core/fpdfdoc/cpdf_annotlist.cpp)、[外观生成](https://pdfium.googlesource.com/pdfium/+/refs/heads/chromium/7926/core/fpdfdoc/cpdf_generateap.cpp)、[字体映射](https://pdfium.googlesource.com/pdfium/+/refs/heads/chromium/7939/core/fpdfdoc/cpvt_fontmap.cpp)。这些是可访问的官方分支，未核对到本机 Chrome 对应的精确 PDFium revision；浏览器升级后应重新验证，不能把成功导出或结构测试通过视为原生阅读器验收通过。

### 后续发现与边界

多行选区暴露了另一项导出问题：便签在伴随高亮之后加入批注数组，而且按第一行末尾定位，可能落在整段高亮的矩形中。Chrome 使用第一个命中的批注矩形，即使该高亮没有正文，也不会继续寻找后面的便签。对照 PDF 中将备注换成英文仍无法悬停；把便签移到数组前部后恢复。上述前序和位置调整用于修复此问题，与中文字体缺失无关。[PDFium 命中逻辑](https://pdfium.googlesource.com/pdfium.git/+/refs/heads/chromium/8073/fpdfsdk/cpdfsdk_pageview.cpp)

修复后重新通过实际导出文件验收：普通页面的三个重复便签及页面边缘便签均可分别响应，原 PDF 的整页高亮不会拦截。Chrome 悬停显示英文正文，中文仍缺失；Edge 点击显示完整中英多行正文。极窄页面的三个便签在 Edge 中均可点击并读取完整正文，Chrome 在默认 99% 和放大 250% 下弹窗都被页面边界裁切，正文不可读，不能记为可读性验收通过。

旋转页面的图标可见性与实际交互需分开验收。本机 Chrome、Edge 156 对 90°、180°、270° 页面上的 `NoRotate` 便签存在显示位置与鼠标命中位置错开的现象，移到对应的原始 `Rect` 位置可打开正文。临时副本移除 `NoRotate` 后仅 Chrome 恢复，Edge 仍强制保持图标端正并错位，因此保留标准便签结构和现有标志，记录为尚未解决的旋转页阅读器兼容限制。四旋转的几何测试通过不等于这项原生交互通过。

## 定向验证

- `packages/opencode`：`bun test test/server/pdf-annotations.test.ts`，检查真实接口、正文、Text/Popup/AP、中文换行、跨页、四种旋转、CropBox、多行和重复便签位置、窄页/边缘、便签响应顺序、原有批注保留及源文件变化保护；另用 PDF.js 解析导出文件。
- `packages/app`：`bun test src/components/pdf-annotation-save.test.ts`，检查失败、重试、保存顺序、立即导出等待和文档隔离。
- `packages/app`：`bun run ./script/vitest.ts run --config ./vitest.config.ts src/components/pdf-viewer-shell-official.vitest.tsx`，验证真实组件的保存与导出调用关系。
- 两个包分别运行 `bun typecheck`；只运行相关测试，不运行整包测试。
- 浏览器 UI 检查覆盖三语、明暗主题、窄视口、长备注滚动、取消/关闭/Escape、保存、删除/撤销与文档切换。原生阅读器验收单独执行。
