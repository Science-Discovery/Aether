# PDF → Markdown 功能实现计划

> 将 PDF 文件一键转换为 Markdown，集成到 Aether Web UI 中。

---

## 给实现者的说明

本文档是功能的完整架构设计。

**⚠️ 首先**：项目根目录的 `PDF_TO_MARKDOWN_PROMPTS.ts` 是已经写好的完整 Prompt 文件，实现时直接移动到 `packages/opencode/src/pdf-converter/prompts.ts` 使用，**不需要自行精简或编写 Prompt**。

实现时还需要结合以下参考代码：

### 必读的参考文件

下面列出的参考文件位于 `/home/bzz/create_problems/`，这是一个已有的 PDF→Markdown 高精度提取项目。
本功能是该项目的精简 web 版本，核心逻辑从该项目移植而来。

| 参考文件 | 用途 | 如何使用 |
|----------|------|---------|
| `src/prompts.py` | 所有 LLM Prompt 原文（约 1100 行） | **最重要的参考**。本文档第六章描述了如何精简这些 prompt，实现时需要读取原文并按规则精简 |
| `src/converters/book_converter.py` | 主转换流程（约 3600 行） | 参考其中的页面处理流程、并行逻辑、重试机制。但不要照搬——本功能做了大量精简 |
| `src/content_checkers.py` | LaTeX 验证 + 内容完整性检查逻辑 | **直接移植**其中的纯代码检测函数到 TypeScript |
| `src/figure_validator.py` | bbox 坐标验证逻辑 | **直接移植**到 TypeScript |
| `src/api/interface_gemini.py` | LLM 调用方式（流式、重试） | 参考其重试和 JSON 解析逻辑，但调用方式改用 Vercel AI SDK |
| `src/pdf_processor.py` | PDF 渲染和图片裁剪 | 参考 PyMuPDF 用法，但本功能通过 Python 子进程调用 |
| `src/markdown_processor.py` | Markdown 后处理（LaTeX 公式清理） | 参考其后处理逻辑 |
| `config.yaml` | 配置结构参考 | 了解原项目的配置项，本功能已精简为弹窗选项 |

### 必读的 Aether Web UI 文件

实现 web UI 部分时需要阅读的现有代码：

| 文件 | 用途 |
|------|------|
| `packages/app/src/pages/session/file-tabs.tsx` | 文件标签页组件，在这里添加「转为 Markdown」按钮 |
| `packages/app/src/components/dialog-select-model.tsx` | 现有模型选择对话框，复用其 `ModelSelectorPopover` 组件 |
| `packages/app/src/components/file-tree.tsx` | 文件树组件，了解右键菜单和文件操作模式 |
| `packages/app/src/context/file.tsx` | 文件状态管理，了解 `sdk.client.file.read/write` 的调用方式 |
| `packages/app/src/context/models.tsx` | 模型状态管理，了解如何获取用户可用的模型列表 |
| `packages/app/src/context/sdk.tsx` | SDK 客户端，了解前后端通信方式 |
| `packages/opencode/src/server/routes/file.ts` | 现有文件 API 路由，在此基础上新增 PDF 转换路由 |
| `packages/opencode/src/server/server.ts` | 服务器主入口，了解路由挂载方式和 SSE 支持 |
| `packages/opencode/src/session/prompt.ts` | 现有的 LLM 调用模式，参考 AbortController 和任务管理模式 |

### 实现顺序建议

按本文档「第十二章 实现优先级」的 Phase 1 → Phase 2 → Phase 3 顺序实现。每个 Phase 完成后应可独立运行测试。

### 每个 Phase 的必读文件

为避免信息过载，按 Phase 分级阅读：

**Phase 1 必读（6 个文件）：**

- `packages/opencode/src/server/routes/file.ts` — 路由注册模式
- `packages/opencode/src/server/server.ts` — 路由挂载 + `streamSSE` 用法
- `packages/opencode/src/knowledge/document.ts` — 已有的 `unpdf` PDF 解析示例
- `packages/opencode/src/provider/provider.ts` — `Provider.getModel()` 获取 LLM 实例
- `packages/app/src/pages/session/file-tabs.tsx` — 添加转换按钮的位置
- `packages/app/src/components/dialog-select-model.tsx` — 模型选择组件
- `/home/bzz/create_problems/src/prompts.py` — Prompt 原文（精简用）

**Phase 2 额外阅读：**

- `/home/bzz/create_problems/src/content_checkers.py` — 移植 LaTeX 验证逻辑
- `/home/bzz/create_problems/src/figure_validator.py` — 移植 bbox 验证逻辑

**Phase 3 额外阅读：**

- `packages/opencode/src/server/routes/event.ts` — SSE + AsyncQueue 推送模式
- `packages/opencode/src/util/abort.ts` — AbortController 工具函数
- `packages/opencode/src/util/queue.ts` — AsyncQueue 实现
- `packages/app/src/context/models.tsx` — 模型列表和持久化模式
- `packages/app/src/utils/persist.ts` — `Persist.workspace()` 持久化

---

## 一、功能概述

用户在"所有文件"中打开 PDF 文件时，可以点击一个按钮，选择模型后一键将 PDF 转换为 Markdown 文件，保存在原 PDF 文件旁边。

### 用户操作流程

```
用户在文件树中点击 PDF 文件
  → 文件查看器出现「转为 Markdown」按钮
  → 点击按钮 → 弹出配置对话框
  → 用户配置参数 → 点击开始
  → 进度条实时显示（角落里显示 token 消耗和流式 LLM 输出）
  → 完成后文件树自动刷新，出现新的 .md 文件和 images/ 文件夹
```

---

## 二、配置对话框设计

弹出的对话框包含以下配置项：

### 2.1 模型选择
- 复用现有的 `ModelSelectorPopover` 组件（位于 `dialog-select-model.tsx`）
- **注意**：该组件的实际 props 接口为 `{ provider?, model?: ModelState, children?, triggerAs?, triggerProps? }`，其中 `model` 是来自 context 的 `ModelState` 类型，不是简单的 ID 字符串。需要适配：可以创建一个本地 `ModelState` 信号来桥接，或者参考该组件内部的 `ModelList` 子组件自行实现一个简化版的模型选择列表
- 只显示用户已配置的 provider 中的模型（通过 `useModels().list()` 获取）
- 提示文字：「请选择一个具有**多模态（图片理解）能力**的模型」
- 模型用于：文字提取、图片 bbox 提取、针对性修复
- **记住选择**：弹窗中提供一个复选框「以后都使用该模型进行 PDF 转换」。勾选后，下次打开弹窗时自动填入上次的模型选择（用户仍可修改）。该偏好通过现有的 `Persist.workspace()` 机制持久化到本地存储
- **费用提醒**：弹窗中在模型选择区域下方显示醒目提示（黄色/橙色警告样式）：「注意：PDF 转 Markdown 会对每一页调用多次多模态 LLM，可能产生较大的 API 费用开销」
- **自动打开**：弹窗中提供一个复选框「转换完成后自动打开生成的文件」（默认勾选）。如果选择合并模式，完成后自动打开生成的 .md 文件；如果选择每页模式，打开第一页对应的 .md 文件。通过 toast 提示用户文件已生成

### 2.2 页面限制与范围
- **强制限制：PDF 总页数不得超过 50 页**。如果用户尝试转换超过 50 页的 PDF：
  - 「转为 Markdown」按钮仍然可点击
  - 点击后弹窗中显示错误提示：「该 PDF 共 {N} 页，超过了 50 页的上限，无法转换」
  - 禁用「开始」按钮
- 起始页码（默认 1）和结束页码（默认为 PDF 总页数）
- 页面范围的跨度（endPage - startPage + 1）也不得超过 50 页
- **提示文字**：「此处为 PDF 文件页码（从第 1 页到最后一页），非书本印刷页码」
- 输入校验：正整数，起始 ≤ 结束 ≤ 总页数，范围 ≤ 50 页

### 2.3 输出模式
- 单选：
  - **合并为一个 Markdown 文件**（默认）：所有页面内容合并到 `{pdf名}.md`
  - **每页一个 Markdown 文件**：生成 `{pdf名}/page_001.md`, `page_002.md`, ...

### 2.4 同名文件处理

当用户点击「开始」后，前端调用 `GET /file/pdf-page-count` 获取页数和预计输出路径（见 3.1 节该接口的响应格式），然后根据用户选择的输出模式，检查对应的目标文件是否已存在（通过 `sdk.client.file.read` 尝试读取）。如果已存在，弹出二次确认对话框：

- **替换**：覆盖现有文件
- **加序号**：文件名后加 `(1)`、`(2)` 等
- **取消**：不执行转换

用户选择后，将 `conflictAction` 作为参数传给 `POST /file/pdf-to-markdown`。

### 2.5 DPI 设置
- 默认 300，不在对话框中显示（高级设置，硬编码即可）

---

## 三、后端 API 设计

### 3.1 新增路由

在 `/packages/opencode/src/server/routes/` 中新增 PDF 转换相关路由。

#### POST `/file/pdf-to-markdown`

启动 PDF 转 Markdown 任务。

**请求体：**
```typescript
{
  path: string            // PDF 文件路径（相对于项目目录）
  providerID: string      // LLM provider ID
  modelID: string         // LLM model ID
  startPage: number       // 起始页码（1-based）
  endPage: number         // 结束页码（1-based）
  outputMode: "merged" | "per-page"  // 输出模式
  conflictAction: "replace" | "rename" | "cancel"  // 同名冲突处理
}
```

**响应：**
```typescript
{
  taskID: string          // 异步任务 ID，用于跟踪进度
}
```

#### GET `/file/pdf-to-markdown/progress?taskID=xxx`

SSE 端点，实时推送进度事件。

**事件类型：**
```typescript
// 进度更新
{ type: "progress", currentPage: number, totalPages: number, phase: "text" | "figure" | "fix" }

// 流式 LLM 输出（角落显示）
{ type: "stream", content: string }

// Token 消耗更新
{ type: "token", input: number, output: number, total: number }

// 单页完成
{ type: "page_done", page: number, figureCount: number }

// 全部完成
{ type: "done", outputPath: string, totalTokens: { input: number, output: number } }

// 错误
{ type: "error", message: string, page?: number }
```

#### POST `/file/pdf-to-markdown/cancel`

取消正在进行的转换任务。

```typescript
{ taskID: string }
```

#### GET `/file/pdf-page-count?path=xxx`

获取 PDF 总页数和预计输出路径（用于对话框中显示页面范围和检测文件冲突）。

**实现**：使用项目已有的 `unpdf` 库（见 `packages/opencode/src/knowledge/document.ts` 中的 `parsePDF` 函数）获取页数，**无需调用 Python**。仅 PDF 渲染为图片和图片裁剪需要 Python。

**响应：**
```typescript
{
  pageCount: number           // PDF 总页数
  outputPath: {
    merged: string            // 合并模式输出路径，如 "textbook.md"
    perPage: string           // 每页模式输出目录，如 "textbook_md/"
    images: string            // 图片目录，如 "textbook_images/"
  }
}
```

---

## 四、后端核心模块设计

### 4.1 架构概览

```
packages/opencode/src/
├── pdf-converter/                  # 新增模块
│   ├── index.ts                    # 主入口：PdfConverter 类
│   ├── pdf-renderer.ts             # PDF → 图片渲染（调用 Python）
│   ├── text-extractor.ts           # LLM 文字提取
│   ├── figure-extractor.ts         # LLM 图片 bbox 提取
│   ├── image-cropper.ts            # 图片裁剪（调用 Python）
│   ├── content-checker.ts          # LaTeX 验证 + 内容完整性检查
│   ├── targeted-fixer.ts           # 针对性修复
│   ├── post-qa.ts                  # Post-QA 质量检查
│   ├── markdown-assembler.ts       # Markdown 组装 + 占位符替换
│   ├── prompts.ts                  # 所有 LLM Prompt
│   ├── types.ts                    # 类型定义
│   └── python/                     # Python 辅助脚本
│       ├── render_page.py          # PDF 页面渲染为图片
│       └── crop_image.py           # 按 bbox 裁剪图片
```

### 4.2 Python 辅助脚本

**调用协议**：TypeScript 后端通过 `Bun.spawn()` 调用 Python 脚本（项目运行时为 Bun，不是 Node.js，不要使用 `child_process`）。每个脚本通过 `sys.argv[1]` 接收一个 JSON 字符串作为参数，处理完成后将结果以 JSON 格式通过 stdout 输出。超时设为 60 秒/次调用。

调用示例：
```typescript
const proc = Bun.spawn([pythonPath, scriptPath, JSON.stringify(input)], {
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = await new Response(proc.stdout).text()
const result = JSON.parse(stdout)
```

#### `render_page.py`

使用 PyMuPDF (fitz) 将 PDF 的指定页面渲染为 PNG 图片。渲染时 zoom = dpi / 72。同时提取该页的嵌入式文本和嵌入式图片数量（见 5.1、5.2 节）。

**输入 JSON schema**：
```json
{
  "pdf_path": "/abs/path/to/file.pdf",
  "page_num": 1,
  "dpi": 300,
  "output_dir": "/abs/path/to/output/"
}
```

**输出 JSON schema**：
```json
{
  "image_path": "/abs/path/to/output/page_001.png",
  "width": 2480,
  "height": 3508,
  "actual_dpi": 300,
  "embedded_text": "提取到的嵌入式文本（如有）",
  "embedded_image_count": 2
}
```

#### `crop_image.py`

使用 Pillow 按归一化 bbox 坐标（0-1 范围的 `[x0, y0, x1, y1]`）裁剪图片。将归一化坐标乘以图片的实际宽高得到像素坐标，裁剪后保存为 PNG。

**输入 JSON schema**：
```json
{
  "image_path": "/abs/path/to/page_001.png",
  "bbox": [0.100, 0.200, 0.900, 0.480],
  "output_path": "/abs/path/to/output/fig_1.png"
}
```

**输出 JSON schema**：
```json
{
  "output_path": "/abs/path/to/output/fig_1.png",
  "width": 1984,
  "height": 982
}
```

### 4.3 PdfConverter 主类

`index.ts` 导出 `PdfConverter` 类，其 `convert()` 方法是一个 AsyncGenerator，逐步 yield `ProgressEvent` 供 SSE 推送。主流程为：获取总页数 → 逐页处理 → Post-QA → 组装 Markdown → 保存文件。

#### 每页处理详细流程

```
对于每一页 page_i:

  [预处理] Python 预分析（不调 LLM）
    → 渲染页面为 PNG 图片
    → 提取嵌入式文本（如有，作为 LLM 参考）
    → 统计嵌入式图片数量

  ┌─ 并行 ─────────────────────────────────────────────────┐
  │  [A] 文字提取                                           │
  │    → LLM(page_image + 可选文本参考, TEXT_PROMPT)        │
  │    → 返回 {content, figure_count}                      │
  │                                                         │
  │  [B] 图片 bbox 提取（仅当嵌入式图片数 > 0 时执行）       │
  │    → LLM(page_image, FIGURE_PROMPT)                    │
  │    → 返回 {figures: [{bbox, ...}]}                     │
  │    → 如果嵌入式图片数 == 0，跳过此步，直接返回空列表     │
  └─────────────────────────────────────────────────────────┘
          ↓
  [C] bbox 验证（纯代码，不调 LLM）
    → 格式检查（3 位小数、0-1 范围）
    → 尺寸验证（宽高比）
    → 居中性检查
    → figure_count 匹配检查
    → 如果验证失败 → 重新调用 [B]（最多重试 1 次）
          ↓
  [D] LaTeX 语法验证（纯代码）
    → 括号配对、空公式检测、命令截断、\eqno 等
          ↓
  [E] 内容完整性检查（纯代码）
    → 截断检测（图片后是否缺失文字）
    → 占位符数量是否匹配 figure_count
          ↓
  [F] 如有问题 → 针对性修复（调 LLM，最多 2 次）
    → 将问题列表 + 原始内容发给 LLM（纯文本调用，不需要图片）
    → LLM 返回修复后的内容
          ↓
  [G] 公式图片 (FORMULA_FIGURE) bbox 提取
    → 检测 content 中是否有 [FORMULA_FIGURE:ffig_N]
    → 如果有 → LLM(page_image, FORMULA_FIGURE_PROMPT)
          ↓
  [H] 图片裁剪（当前页的所有 figure + formula_figure）
    → 调用 Python crop_image.py
    → 保存到 images/ 子文件夹
          ↓
  [I] 占位符替换
    → [FIGURE:fig_N] → ![desc](images/page_X/fig_N.png)
    → [FORMULA_FIGURE:ffig_N] → ![desc](images/page_X/ffig_N.png)
```

### 4.4 Post-QA 质量检查

在所有页面转换完成后执行：

```
Post-QA 流程:
  1. 按批次（每 5 页一批）将 Markdown + 对应页面图片发给 LLM
     - 每次 LLM 调用最多传 5 张页面图片（控制单次 token 开销）
     - 消息格式：一个 text part（包含 5 页的 Markdown 文本）+ 5 个 image part（对应页面的渲染图片）
     - 如果某批次的总图片数据超过 20MB，自动拆分为更小的批次
  2. LLM 检查：
     a. 图片位置是否正确（是否插在了正确的文本位置）
     b. 是否有遗漏的输出（文字、公式、图片）
     c. 纯文字图片检测（被错误截图的纯文字区域）
  3. 如果检测到纯文字图片 → 单独对该图片调用 LLM 转录为 Markdown 并替换图片引用
  4. 如果检测到位置错误 → 调整占位符位置
  5. 最多重试 2 次
```

---

## 五、借鉴 MinerU 的技术

> MinerU 是一个基于传统 ML 模型流水线的 PDF 提取工具，格式稳定但细节经常出错。
> 我们的方案以 LLM 多模态理解为核心，精度更高。以下是从 MinerU 中借鉴的**轻量级技术**，
> 不引入任何 ML 模型，仅利用 PDF 文件自身的元数据和简单的启发式规则。

### 5.1 PDF 文本层预检测（借鉴自 `mineru/utils/pdf_classify.py`）

**作用**：在发送给 LLM 之前，先用 PyMuPDF 检测 PDF 页面是否有嵌入式文本层。

**实现**：在 `render_page.py` 中增加一个函数，使用 `page.get_text("text")` 提取页面文本，去除空白后统计字符数。如果有效字符数超过 50，则认为该页有文本层，返回提取到的文本供 LLM 参考。

**如何使用**：
- 如果页面有嵌入式文本，在 Prompt 末尾追加一段参考文本：「以下是从 PDF 文本层直接提取的文本，可作为参考（注意：可能有格式丢失或乱序）」，然后附上提取的文本，最后提示「请以页面图片为准，但可以参考上述文本确认拼写和特殊字符」
- 好处：**降低 LLM 的 OCR 错误率**，特别是对于专业术语、人名、特殊符号
- 如果没有文本层（扫描件），则不追加，仅依赖图片

### 5.2 嵌入式图片预检测（借鉴自 `mineru/utils/pdf_classify.py`）

**作用**：在发送给 LLM 之前，用 PyMuPDF 统计页面中嵌入的图片对象数量。

**实现**：在 `render_page.py` 中增加一个函数，使用 `page.get_images(full=True)` 获取嵌入式图片列表，返回图片数量。

**如何使用**：
- 如果 `image_count == 0`，可以**跳过图片 bbox 提取的 LLM 调用**，直接返回空 figures 列表
- 节省约 50% 的 LLM 调用（纯文字页面很常见）
- 注意：嵌入式图片计数可能不准确（有些 PDF 把整页作为一张图片），所以当 `image_count >= 1` 时仍然需要 LLM 判断

### 5.3 页眉/页脚/页码区域提示（借鉴自 `mineru/utils/block_pre_proc.py`）

**作用**：通过空间启发式规则，提前告知 LLM 页眉页脚的大致区域。

**实现**：不需要额外的 Python 代码，而是在 Prompt 中增加规则，告知 LLM：页面顶部约 5% 区域（y < 0.05）的独立文字行通常是页眉（章节标题、书名等），页面底部约 5% 区域（y > 0.95）的独立数字或短文字通常是页码，这些内容不属于正文应忽略不输出，特别是不要把页码当成公式编号。

**好处**：减少 LLM 将页码误认为公式编号或将页眉误认为标题的情况。

### 5.4 跨页表格/内容检测（借鉴自 `mineru/utils/table_merge.py`）

**作用**：检测跨页续表标记，在合并输出时正确拼接。

**实现**：在 `markdown-assembler.ts` 中增加后处理，用正则表达式检测页面开头前 3 行是否包含续表标记。需要匹配的续表标记模式（中英文）：

```typescript
const CONTINUATION_MARKERS = [
  /^\s*[（(]续[）)]\s*$/,
  /^\s*[（(]续表[）)]\s*$/,
  /^\s*[（(]continued[）)]\s*$/i,
  /^\s*[（(]cont['']?d?\.?[）)]\s*$/i,
  /^\s*续表\s*$/,
];
```

**如何使用**：
- 合并模式下，如果下一页以续表标记开头，且上一页以表格结尾，尝试合并表格
- 删除续表标记行本身
- 如果无法自动合并（表格列数不匹配），保留原样并在合并处添加注释 `<!-- 续上表 -->`

### 5.5 语言感知的文本拼接（借鉴自 `pipeline_middle_json_mkcontent.py`）

**作用**：合并输出时，根据文本语言调整行间拼接方式。

**规则**：

- **中日韩（CJK）文本**：相邻行直接拼接，不加空格（CJK 文字之间不需要空格）
- **西文文本**：相邻行之间加空格
- **混合文本**：CJK 与西文之间加空格

**实现**：在 `markdown-assembler.ts` 中实现 CJK 字符判断函数，需要覆盖的 Unicode 范围：

```typescript
// CJK Unified: 0x4E00-0x9FFF
// CJK Symbols: 0x3000-0x303F
// Hiragana:    0x3040-0x309F
// Katakana:    0x30A0-0x30FF
// Hangul:      0xAC00-0xD7AF
```

根据前一行末尾字符和后一行开头字符的类型决定是否在拼接处加空格。

### 5.6 特殊 Markdown 字符转义（借鉴自 `pipeline_middle_json_mkcontent.py`）

**作用**：对非数学区域的特殊 Markdown 字符进行转义，防止渲染错乱。

**需要转义的字符**：`*`、`` ` ``、`~`（在 `$...$` 和 `$$...$$` 之外的区域）

**实现**：在 `markdown-assembler.ts` 的后处理中，先定位所有数学公式区域（`$...$` 和 `$$...$$`），然后对非数学区域中孤立出现的 `*`、`` ` ``、`~` 进行反斜杠转义。注意不要转义已经构成 Markdown 格式标记的字符（如 `**bold**`、`# heading`）。

### 5.7 PDF 渲染安全措施（借鉴自 `mineru/utils/pdf_image_tools.py`）

**作用**：防止超大 PDF 页面或损坏 PDF 导致 OOM。

**措施**：在 `render_page.py` 的渲染函数中增加安全限制：最大像素尺寸 4000px（如果按 DPI 计算后的尺寸超限，自动降低 zoom 比例）；单页渲染超时 30 秒。返回结果中包含实际使用的 DPI（可能因降级而低于 300）。

### 5.8 可视化调试输出（借鉴自 `mineru/utils/draw_bbox.py`）

**作用**：生成一个 debug PDF，在每页上用彩色方框标注 LLM 识别的图片 bbox 位置，帮助用户验证提取质量。

**实现**：作为**可选功能**，在 Python 脚本中增加一个函数，使用 PyMuPDF 的 `page.draw_rect()` 在原始 PDF 页面上绘制彩色矩形框（普通图片用绿色，公式图片用蓝色），并在框的左上角标注 figure ID。将归一化 bbox 坐标乘以页面实际尺寸得到绘制坐标。

**使用场景**：

- 在进度面板中增加一个「查看提取标注」按钮
- 点击后在文件查看器中打开 debug PDF
- 用户可以快速看到哪些区域被识别为图片
- **不是默认行为**，仅在用户需要时生成

### 5.9 结构化中间格式（借鉴自 MinerU 的 `middle_json`）

**作用**：保存一份结构化的 JSON 中间结果，方便调试和重新处理。

**格式**：
```json
{
  "version": "1.0",
  "source_pdf": "textbook.pdf",
  "source_language": "en",
  "model": { "provider": "google", "model": "gemini-2.0-flash" },
  "pages": [
    {
      "page_num": 1,
      "has_text_layer": true,
      "figures": [
        {
          "id": "fig_1",
          "bbox": [0.100, 0.200, 0.900, 0.480],
          "description": "...",
          "caption": "图 2.3 ...",
          "image_path": "textbook_images/page_001/fig_1.png"
        }
      ],
      "formula_figures": [...],
      "raw_content": "LLM 返回的原始 Markdown",
      "final_content": "处理后的最终 Markdown",
      "translations": {},
      "issues_detected": ["LaTeX bracket mismatch at ..."],
      "fixes_applied": ["Fixed bracket at ..."],
      "tokens": { "input": 1200, "output": 800 }
    }
  ],
  "output_mode": "merged",
  "total_tokens": { "input": 50000, "output": 35000 },
  "post_qa_results": { ... }
}
```

> **关于 `image_path` 字段**：该路径为相对于 `_data.json` 所在目录的相对路径。
> - 合并模式下：`textbook_images/page_001/fig_1.png`
> - 每页独立模式下：`textbook_md/images/page_001/fig_1.png`
>
> **关于 `translations` 字段**：当前为空对象 `{}`，预留给后续的翻译功能。
> 翻译完成后格式为 `{"zh": "中文翻译内容", "ja": "日本語翻訳内容"}`。
> 翻译功能不需要重新提取图片——图片路径在 `figures` 中已记录，翻译版 Markdown 直接引用同一套图片。

**保存位置**：`{pdf名}_data.json`（与 .md 文件同目录）

**生成策略**：**始终生成**（不仅限 debug 模式），因为后续翻译功能需要读取其中的 `final_content` 逐页翻译。但在非 debug 模式下，可以省略 `raw_content`、`issues_detected`、`fixes_applied` 等调试字段以减小文件体积。

**好处**：
- 用户可以检查哪些页面有问题
- 开发者可以调试 prompt 效果
- 如果只有部分页面需要重新转换，可以跳过已完成的页面
- **后续翻译功能可以直接读取此 JSON 中的 `final_content` 逐页翻译，无需重新提取**

### 5.10 借鉴总结

| 借鉴项 | 来源 | 增加复杂度 | 收益 |
|--------|------|-----------|------|
| PDF 文本层预检测 | `pdf_classify.py` | 低（Python 几行代码） | 降低 LLM OCR 错误率 |
| 嵌入式图片预检测 | `pdf_classify.py` | 低（Python 几行代码） | 跳过纯文字页的图片提取，节省 ~50% LLM 调用 |
| 页眉/页脚区域提示 | `block_pre_proc.py` | 无（仅修改 Prompt） | 减少页码误认为公式编号 |
| 跨页表格检测 | `table_merge.py` | 中（TS 正则匹配） | 合并模式下正确拼接续表 |
| 语言感知文本拼接 | `mkcontent.py` | 低（TS 几行代码） | 中日韩文本不加多余空格 |
| 特殊字符转义 | `mkcontent.py` | 低（TS 后处理） | 防止 Markdown 渲染错乱 |
| PDF 渲染安全措施 | `pdf_image_tools.py` | 低（Python 几行代码） | 防止 OOM、处理损坏 PDF |
| 可视化调试输出 | `draw_bbox.py` | 中（Python 绘制） | 帮助用户验证提取质量 |
| 结构化中间格式 | `middle_json` | 中（TS 数据结构） | 调试、断点续传、质量追踪 |

**不借鉴的技术（过重或 LLM 方案已覆盖）**：
- ML 布局检测模型（DocLayout YOLO）— LLM 天然理解页面结构
- OCR 模型（PaddleOCR）— LLM 多模态直接识别
- 公式检测/识别模型（YOLOv8 + UnimerNet）— LLM 直接输出 LaTeX
- 表格结构识别模型（SlanetPlus）— LLM 直接输出 Markdown 表格
- 阅读顺序模型（LayoutLMv3）— LLM 天然理解阅读顺序

---

## 六、LLM Prompt 设计

**精简后的完整 Prompt 已写好**，位于 `/home/bzz/Aether/PDF_TO_MARKDOWN_PROMPTS.ts`。实现时将该文件移动到 `packages/opencode/src/pdf-converter/prompts.ts` 即可直接使用。

该文件包含以下导出：

| 导出名 | 类型 | 用途 |
| ------ | ---- | ---- |
| `TEXT_ONLY_PROMPT` | 常量 | 文字提取基础 Prompt |
| `buildTextPromptWithEmbeddedText(embeddedText)` | 函数 | 带 PDF 嵌入式文本参考的文字提取 Prompt（5.1 节） |
| `buildTextPromptWithIssues(issues, embeddedText)` | 函数 | 带历史问题提示的文字提取 Prompt（外层重试用） |
| `buildTextFixPrompt(content, issuesText)` | 函数 | 针对性修复 Prompt（6.4 节） |
| `buildFigureOnlyPrompt(minAR, maxAR, retryHints)` | 函数 | 图片 bbox 提取 Prompt（6.2 节） |
| `buildFormulaFigurePrompt(count, retryHints)` | 函数 | 公式图片 bbox 提取 Prompt（6.3 节） |
| `SINGLE_IMAGE_TEXT_ONLY_CHECK_PROMPT` | 常量 | Post-QA 纯文字图片检测 Prompt（6.5 节） |
| `buildTextOnlyFigureTranscribePrompt(context)` | 函数 | Post-QA 纯文字图片转录 Prompt（6.5 节） |

### 6.1-6.5 精简变更摘要

以下是相对于原始 `/home/bzz/create_problems/src/prompts.py` 所做的精简变更，供核对：

**TEXT_ONLY_PROMPT 变更**：

- **删除**：规则 12（狄拉克符号 Bra-Ket 的具体配对规范）→ 简化为仅保留 `\\left`/`\\right` 配对检查
- **删除**：规则 14 中所有费曼图展开式、Wick 缩并公式、`\\contraction` 命令的具体示例
- **删除**：规则 19（Wick 缩并公式一律截图）整条
- **删除**：规则 11附中关于 `\\mathscr` 的说明（保留了 `igg`/`ig` 误识别警告）
- **泛化**：规则 14 将「费曼图」「能级图」「电路图」改为「手绘图形、连线、曲线、特殊图形符号等」，删除场景 B（Wick 缩并），保留判断标准和占位符规则
- **新增**：页眉/页脚忽略规则（来自 5.3 节）
- **新增**：`buildTextPromptWithEmbeddedText()` 函数，支持追加 PDF 嵌入式文本参考（来自 5.1 节）

**build_figure_only_prompt 变更**：

- **删除**：「量子场论等教材必读」标题
- **删除**：所有费曼图、Wick 缩并的具体示例
- **泛化**：「公式+图形混排必须截图」规则改为通用表述

**build_formula_figure_prompt 变更**：

- **泛化**：将「费曼图」「Wick 缩并」全部替换为「公式中嵌入了非标准数学符号的图形元素（线条、曲线、手绘图形等）」
- **删除**：所有量子场论具体示例（费曼图展开式、Wick 缩并公式示例）

**TEXT_FIX_PROMPT**：原文直接使用，无修改。

**Post-QA Prompts 变更**：

- `SINGLE_IMAGE_TEXT_ONLY_CHECK_PROMPT`：删除了「Wick 缩并公式」判断条目
- `TEXT_ONLY_FIGURE_TRANSCRIBE_PROMPT`：原文直接使用，无修改

### 6.6 content-checker 验证逻辑

**源文件**：`/home/bzz/create_problems/src/content_checkers.py`

该文件包含纯代码（不调用 LLM）的质量检测函数，需要**移植为 TypeScript**。主要包括：

1. **LaTeX 语法验证**（对应 `content-checker.ts`）：
   - 检测空公式（`$$ $$` 或 `$ $`）
   - 检测花括号不配对（`{` 和 `}` 数量不等）
   - 检测 `\eqno` 误用（应为 `\tag`）
   - 检测 `\left`/`\right` 不配对
   - 检测公式中的 `\n` 字面量残留
   - 检测块级公式 `$$` 未独占一行

2. **内容完整性检查**：
   - 检测文字是否在 `[FIGURE:fig_N]` 后截断（图片后应有后续文字）
   - 检测 `figure_count` 与实际 `[FIGURE:fig_N]` 占位符数量是否匹配
   - 检测是否有 `[FORMULA_FIGURE:ffig_N]` 但 figure 提取中缺少对应 bbox

### 6.7 bbox 验证逻辑

**源文件**：`/home/bzz/create_problems/src/figure_validator.py`

该文件包含纯代码的 bbox 坐标验证，需要**移植为 TypeScript**。主要包括：

1. **格式验证**：坐标是否为 0-1 之间的 3 位小数
2. **坐标关系**：x0 < x1 且 y0 < y1
3. **宽高比验证**：(y1-y0)/(x1-x0) 是否在 min_aspect_ratio ~ max_aspect_ratio 范围内
4. **居中性验证**：水平中心 (x0+x1)/2 是否在 0.30-0.70 范围
5. **figure_count 匹配**：LLM 返回的 figures 数量是否与文字提取中报告的 figure_count 一致

---

## 七、前端 UI 设计

### 7.1 转换按钮位置

在 `packages/app/src/pages/session/file-tabs.tsx` 中：
- 当文件是 PDF 时（检测 `.pdf` 扩展名），在文件标签栏的工具按钮区域增加一个带图标和文字的按钮
- 按钮包含一个编辑图标 + 「转换为 Markdown」文字标签，确保用户能直观理解功能含义
- 点击后弹出配置对话框

### 7.2 配置对话框组件

新建 `packages/app/src/components/dialog-pdf-to-markdown.tsx`：

```
┌─────────────────────────────────────────────┐
│  PDF 转 Markdown                             │
│─────────────────────────────────────────────│
│                                              │
│  模型选择：                                   │
│  ┌──────────────────────────────────────┐   │
│  │ [ModelSelectorPopover]                │   │
│  └──────────────────────────────────────┘   │
│  ☐ 转换完成后自动打开生成的文件                │
│  ☐ 以后都使用该模型进行 PDF 转换              │
│  ⚠️ PDF 转 Markdown 会对每一页调用多次        │
│    多模态 LLM，可能产生较大的 API 费用开销     │
│                                              │
│  页面范围：                                   │
│  ┌─────┐  至  ┌─────┐  / 共 42 页            │
│  │  1  │      │  42 │                        │
│  └─────┘      └─────┘                        │
│  ⓘ 此处为 PDF 文件页码，非书本印刷页码          │
│                                              │
│  输出模式：                                   │
│  ○ 合并为一个 Markdown 文件                    │
│  ○ 每页一个 Markdown 文件                      │
│                                              │
│           ┌─────────┐  ┌─────────┐           │
│           │  取消    │  │  开始   │           │
│           └─────────┘  └─────────┘           │
└─────────────────────────────────────────────┘

如果 PDF 超过 50 页，弹窗中显示：
┌─────────────────────────────────────────────┐
│  PDF 转 Markdown                             │
│─────────────────────────────────────────────│
│                                              │
│  ❌ 该 PDF 共 128 页，超过了 50 页的上限，     │
│     无法转换。                                │
│                                              │
│                      ┌─────────┐             │
│                      │  关闭   │             │
│                      └─────────┘             │
└─────────────────────────────────────────────┘
```

### 7.3 进度显示

转换开始后，**关闭配置对话框**，在页面**右上角**显示一个固定浮动的小条形进度指示器（不遮挡主要工作区域）。

**组件实现**：`packages/app/src/components/pdf-convert-progress.tsx`，使用 Solid.js 的 `<Portal>` 挂载到页面顶层，固定在右上角。

**交互方式**：
- 默认显示一行紧凑的状态：状态指示点 + 进度文字 + 百分比
- 点击可展开查看详细信息（Token 统计、LLM 流式输出、取消按钮）
- 转换完成后显示"打开"按钮

**SSE 连接管理**：

- 对话框中启动转换后立即关闭对话框，SSE 连接由浮动条组件维护
- 组件卸载时关闭 SSE 连接（但不取消后端任务）

```
┌──────────────────────────────────────────┐  ← 固定在右上角
│ ● PDF 转换中 5/42 页 · 提取文字     12% │  ← 默认折叠状态
├──────────────────────────────────────────┤
│ ▇▇▇▇▇▇░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← 进度条
├──────────────────────────────────────────┤  ← 以下为展开后内容
│ 输入 Token: 12,450  输出 Token: 3,200   │
│ ┌─ LLM 输出 ───────────────────────┐   │
│ │ {"content": "# Chapter 1\n..."   │   │
│ └──────────────────────────────────┘   │
│                          [取消转换]     │
└──────────────────────────────────────────┘
```

- **状态指示点**：运行中蓝色脉冲，完成绿色，错误红色，取消黄色
- **进度条**：显示当前页码 / 总页数 + 百分比
- **Token 消耗**：明确标注「输入 Token」和「输出 Token」两个数值的含义
- **LLM 流式输出**：展开后可查看实时内容
- **取消按钮**：展开后可见

### 7.4 文件冲突处理

当检测到同名文件已存在时，弹出确认对话框：

```
┌─────────────────────────────────────┐
│  文件已存在                          │
│                                     │
│  textbook.md 已经存在。              │
│                                     │
│  ○ 替换现有文件                      │
│  ○ 保存为 textbook(1).md            │
│  ○ 取消                             │
│                                     │
│        ┌─────────┐  ┌─────────┐    │
│        │  取消    │  │  确认   │    │
│        └─────────┘  └─────────┘    │
└─────────────────────────────────────┘
```

---

## 八、输出文件结构

### 合并模式

```
parent_directory/
├── textbook.pdf              (原始 PDF)
├── textbook.md               (合并后的 Markdown)
├── textbook_data.json        (结构化中间数据，始终生成)
└── textbook_images/          (提取的图片)
    ├── page_001/
    │   ├── fig_1.png
    │   └── fig_2.png
    ├── page_002/
    │   └── fig_1.png
    └── page_015/
        ├── fig_1.png
        └── ffig_1.png        (公式图片)
```

Markdown 中的图片引用：

```markdown
![图 2.3 单电子原子的能级图](textbook_images/page_001/fig_1.png)
```

### 每页独立模式

```
parent_directory/
├── textbook.pdf              (原始 PDF)
├── textbook_data.json        (结构化中间数据，始终生成)
└── textbook_md/              (输出目录)
    ├── page_001.md
    ├── page_002.md
    ├── ...
    └── images/
        ├── page_001/
        │   ├── fig_1.png
        │   └── fig_2.png
        └── page_002/
            └── fig_1.png
```

---

## 九、技术实现细节

### 9.1 Python 环境检测

后端启动时检测 Python + PyMuPDF 是否可用：依次尝试 `python3` 和 `python` 命令，然后检查 `import fitz`（PyMuPDF）和 `from PIL import Image`（Pillow）是否能成功导入。返回可用性状态、Python 路径和缺失依赖列表。

如果 Python 依赖不可用，「转为 Markdown」按钮灰色禁用，hover 提示安装命令：`pip install PyMuPDF Pillow`

### 9.2 LLM 调用方式

复用现有的 Vercel AI SDK 基础设施。需要区分两种调用模式：

- **流式调用**（`streamText`）：用于文字提取和图片 bbox 提取等主要步骤。流式调用可以将 LLM 的实时输出通过 SSE 推送给前端（用于 7.3 节的"LLM 输出"折叠区域）。从流中收集完整响应后，再解析 JSON。示例：
  ```typescript
  const result = streamText({
    model: languageModel,
    messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      { type: "image", image: pageImageBase64 }
    ]}],
    maxTokens: 8192,
    abortSignal: controller.signal,
  })
  let fullText = ""
  for await (const chunk of result.textStream) {
    fullText += chunk
    yield { type: "stream", content: chunk }  // 推送给 SSE
  }
  const parsed = JSON.parse(fullText)  // 流结束后解析 JSON
  ```

- **非流式调用**（`generateText`）：用于针对性修复（6.4 节）等不需要流式显示的步骤，代码更简洁。

**获取 model 实例**：必须通过现有 Provider 系统获取 `languageModel` 实例，**不要**自行构建 AI SDK provider。调用方式：
```typescript
import { Provider } from "../provider/provider"
const languageModel = Provider.getModel(providerID, modelID)
```
Provider 系统内置了自定义 fetch（含超时处理）、SSE 包装、AbortSignal 组合等基础设施，直接复用即可。

每次调用传入用户选择的 provider 和 model，消息内容包含一个 text part（prompt 文字）和一个 image part（页面图片的 base64 编码）。maxTokens 设为 8192。

### 9.3 并行处理策略

- 同一页内：文字提取和图片 bbox 提取**并行**执行（两次 LLM 调用同时发出）
- 不同页面之间：**串行**处理（避免 API 限流）
- 图片裁剪：每页的 LLM 调用全部完成后，立即裁剪该页的图片（不等所有页面完成）

### 9.4 错误处理

按 Phase 分级实现：

**Phase 1（MVP 必须）：**

- LLM 返回非 JSON 格式 → 尝试从返回文本中提取 JSON（正则匹配 `{...}`）→ 仍失败则跳过该页并记录错误
- Python 脚本执行失败 → 记录错误，继续处理下一页
- 单页全部失败 → 在最终 Markdown 中插入注释 `<!-- 第 X 页转换失败：错误信息 -->`，继续处理下一页

**Phase 3（完善）：**

- 用户取消 → 通过 AbortController 终止所有进行中的 LLM 调用和 Python 进程（参考 `packages/opencode/src/util/abort.ts` 中的 `abortAfter()` 和 `abortAfterAny()` 工具函数）
- API 限流（429 错误）→ 指数退避重试（延迟 5s → 10s → 20s，最多 3 次）

### 9.5 后台任务行为

- 转换任务一旦启动，即使用户在前端导航离开当前文件或切换标签页，**后端任务继续运行**，不会中断
- 用户重新打开该 PDF 文件时，如果任务仍在运行，自动重新连接 SSE 进度流
- 只有用户明确点击「取消」按钮，或关闭整个浏览器页面时，任务才会被取消

### 9.6 任务队列

多个 PDF 转换任务**串行执行**，同一时刻只有一个任务在运行，避免过大的 API 调用压力。

**队列规则**：
- 新任务入队后，如果当前有任务正在运行，新任务排队等待
- 有先后顺序的按入队顺序执行
- 同时入队的多个任务（未来批量选择多个文件场景）按文件名字母顺序排序
- 前一个任务完成（或失败/取消）后自动启动下一个
- 排队中的任务可以被单独取消（不影响队列中的其他任务）

**前端显示**：
- 排队中的任务在右上角浮动条中显示「排队中（第 N 位）」
- 进度事件的 `phase` 字段使用 `queued:N` 格式标识排队状态

### 9.7 Python 环境预检测

配置对话框打开时自动调用 `GET /file/pdf-python-check` 检查 Python 环境：
- 如果 Python + PyMuPDF + Pillow 均可用，正常显示配置表单
- 如果不可用，显示红色错误提示并列出缺少的依赖（如 `pip install PyMuPDF Pillow`），禁用开始按钮

### 9.8 SSE 进度推送

使用现有的 Hono `streamSSE` 函数实现。客户端通过 `GET /file/pdf-to-markdown/progress?taskID=xxx` 连接 SSE 端点，服务端从任务的事件队列中逐条读取事件并推送，直到任务完成或被取消。

---

## 十、功能保留清单（最终确认）

| # | 功能 | 状态 | 调用 LLM | 说明 |
|---|------|------|---------|------|
| 1 | PDF→图片渲染 | ✅ 保留 | 否 | Python + PyMuPDF, 300 DPI |
| 2 | DPI 配置 | ✅ 固定 300 | 否 | 硬编码 |
| 3 | 页面范围选择 | ✅ 保留 | 否 | 弹窗中选择，提示为 PDF 页码 |
| 4 | 基础文字提取 | ✅ 保留 | 是 | 核心功能 |
| 5 | GSA 全局结构分析 | ❌ 删除 | — | — |
| 6 | TOC 目录页检测 | ❌ 删除 | — | — |
| 7 | TOC 专用 prompt | ❌ 删除 | — | — |
| 8 | 上下文参考 | ❌ 删除 | — | — |
| 9 | 外层重试循环 | ✅ 保留 | 否 | 纯代码检测 |
| 10 | LaTeX 语法验证 | ✅ 保留 | 否 | 纯代码检测 |
| 11 | 内容完整性检查 | ✅ 保留 | 否 | 纯代码检测 |
| 12 | 针对性修复 | ✅ 保留（最多 2 次） | 是 | 精简为最多 2 次 LLM 调用 |
| 13 | 模型回退 | ❌ 删除 | — | 用户只选一个模型 |
| 14 | FORMULA_FIGURE 检测 | ✅ 保留（泛化） | 是 | 去掉物理专用描述 |
| 15 | Post-QA 批量质检 | ✅ 保留 | 是 | 图片位置检查 + 错漏检测 |
| 16 | 纯文字图片检测与转录 | ✅ 保留 | 是 | Post-QA 子功能 |
| 17 | 分章节输出 | ❌ 删除 | — | — |
| 18 | 合并 Markdown 导出 | ✅ 保留 | 否 | 弹窗选择合并/每页独立 |
| 19 | LaTeX 导出 | ❌ 删除 | — | — |
| 20 | 跨行断词恢复 | ✅ 保留 | 否 | Prompt 中保留规则 |
| 21 | 基础图片 bbox 提取 | ✅ 保留 | 是 | 核心功能 |
| 22 | bbox 格式验证 | ✅ 保留 | 否 | 纯代码 |
| 23 | bbox 尺寸验证 | ✅ 保留 | 否 | 纯代码 |
| 24 | bbox 居中性检查 | ✅ 保留 | 否 | 纯代码 |
| 25 | 子图合并规则 | ✅ 保留 | 否 | Prompt 中保留规则 |
| 26 | 单图片重试 | ✅ 保留 | 是 | bbox 验证失败时重试 |
| 27 | Fallback 模型重试 | ❌ 删除 | — | — |
| 28 | 图片裁剪保存 | ✅ 保留 | 否 | Python + Pillow |
| 29 | 占位符替换 | ✅ 保留 | 否 | 纯代码 |
| 30 | FORMULA_FIGURE bbox | ✅ 保留（泛化） | 是 | 去掉物理专用描述 |
| 31 | 图片完整性验证 | ✅ 保留 | 否 | 纯代码 |
| 32 | 并行处理 | ✅ 保留 | — | 文字+图片并行 |
| 33 | 进度展示 | ✅ 保留 | — | 前端进度条 |
| 34 | Token 统计 | ✅ 保留 | — | 前端实时更新 |
| 35 | 流式输出 | ✅ 保留 | — | 角落显示，不碍眼 |

---

## 十一、每页 LLM 调用次数分析

**纯文字页面（无嵌入式图片，约占 50%）**：1 次 LLM 调用/页
- 1 次文字提取（图片 bbox 提取被跳过，见 5.2 节）

**有图片的页面，最佳情况**（无问题）：2 次/页
- 1 次文字提取 + 1 次图片 bbox 提取

**有图片的页面，有问题需修复**：最多 5 次/页
- 1 次文字提取 + 1 次图片 bbox 提取
- + 1 次 bbox 验证失败后的重试
- + 1 次 FORMULA_FIGURE bbox 提取（如果有公式图片）
- + 最多 2 次针对性修复

**Post-QA 阶段**：额外 1-2 次/批（每 5 页一批）
- 1 次批量质检 + 可能的纯文字图片转录

---

## 十二、实现优先级

### Phase 1：核心功能（MVP）
1. Python 辅助脚本（PDF 渲染 + 图片裁剪）
2. 后端 API 路由 + 核心转换逻辑
3. LLM Prompt（精简通用版）
4. 文字提取 + 图片 bbox 提取
5. 前端：转换按钮 + 配置对话框 + 进度条
6. 文件保存 + 占位符替换

### Phase 2：质量保证
7. LaTeX 验证 + 内容完整性检查
8. 针对性修复
9. bbox 验证（格式、尺寸、居中性）
10. FORMULA_FIGURE 检测与提取

### Phase 3：Post-QA + 优化
11. Post-QA 批量质检
12. 纯文字图片检测与转录
13. Token 统计 + 流式输出显示
14. 错误处理 + 取消功能完善

---

## 十三、依赖要求

### 服务器端
- **Python 3.8+**
- **PyMuPDF** (`pip install PyMuPDF`)
- **Pillow** (`pip install Pillow`)

### 前端
- 无新增依赖（复用现有 Solid.js 组件库）

### 后端 (TypeScript)
- 无新增 npm 依赖（复用现有 Vercel AI SDK + Hono）

---

## 十四、后续功能适配：Markdown 全文翻译

> 本章不属于当前实现范围，仅记录设计约束，确保当前实现不阻碍后续翻译功能。

### 14.1 功能描述

PDF 转 Markdown 完成后，用户可以将整份 Markdown 翻译为中文（或其他语言），同样使用 LLM 逐页翻译。

### 14.2 当前实现需要遵守的约束

以下约束确保翻译功能可以无缝接入：

1. **后端任务管理框架必须通用化**：SSE 进度推送、AbortController 取消、任务 ID 追踪等机制应抽象为通用的「长任务」基础设施（如 `LongRunningTask` 基类或工具函数），而不是写死在 PDF 转换代码中。翻译功能将复用同一套基础设施。

2. **结构化中间 JSON 必须保存**：`_data.json` 始终生成（见第 5.9 节），其中包含每页的 `final_content`。翻译功能将直接读取此 JSON 逐页翻译，而不需要重新解析合并后的 .md 文件。调试字段（`raw_content`、`issues_detected`、`fixes_applied`）可以在非 debug 模式下省略以减小体积。

3. **图片路径必须语言无关**：图片统一存储在 `{pdf名}_images/` 目录下，翻译版 Markdown 引用同一套图片。翻译后的文件命名为 `{pdf名}_{lang}.md`（如 `textbook_zh.md`），图片路径不变。

4. **模型记忆应区分用途**：当前的「记住模型选择」功能应存储为 `pdf-convert-model`。后续翻译功能会有独立的模型选择（翻译不需要多模态能力，可以用纯文本模型），存储为 `pdf-translate-model`。两者互不干扰。

### 14.3 参考代码

翻译 prompt 已存在于 `/home/bzz/create_problems/src/prompts.py` 中的 `TRANSLATE_PAGE_PROMPT`（约 50 行），包含完善的翻译规则：
- 数学公式 `$...$` 和 `$$...$$` 内容完全不动
- 图片引用 `![...](...)` 和占位符 `[FIGURE:fig_N]` 完全不动
- Markdown 结构保留，内容翻译
- 学术翻译风格，人名保留英文
- 页眉/页脚自动删除
