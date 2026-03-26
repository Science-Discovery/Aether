# Markdown 一键翻译功能实现计划

> 为 Aether Web UI 中的 Markdown 文件添加一键翻译功能。核心翻译逻辑（公式保护、分块翻译）移植自 `/home/bzz/create_problems/src/translate.py`。

---

## 实现前必读

**在写任何代码之前，必须先完整阅读以下文件**，理解现有模式后再动手：

1. `packages/opencode/src/pdf-converter/index.ts` — 任务队列管理 + AsyncGenerator 转换逻辑（翻译模块的后端结构与此完全一致）
2. `packages/opencode/src/pdf-converter/types.ts` — ProgressEvent、ConvertTask、ConvertDataJSON 类型定义
3. `packages/opencode/src/pdf-converter/util.ts` — resolveConflict、generateTaskID 等工具函数
4. `packages/opencode/src/server/routes/file.ts` — 现有 PDF 转换的 4 个路由（翻译路由结构一致）
5. `packages/app/src/components/dialog-pdf-to-markdown.tsx` — PDF 转换对话框（翻译对话框模式一致但更简单）
6. `packages/app/src/components/pdf-convert-progress.tsx` — 进度条组件（需要泛化此文件）
7. `packages/app/src/pages/session/file-tabs.tsx` — 文件标签页（需要添加翻译按钮）
8. `/home/bzz/create_problems/src/translate.py` — Python 版 FormulaProtector 和 MarkdownTranslator（公式保护器直接移植）
9. `/home/bzz/create_problems/src/prompts.py` — 搜索 `TRANSLATE_PAGE_PROMPT` 变量（位于「翻译 Prompts」section），这是原始翻译 Prompt（需泛化）

---

## 技术栈

- **前端**：SolidJS（不是 React），使用 `createSignal`、`createMemo`、`createEffect`、`Show`、`For` 等 SolidJS 原语
- **后端**：Bun + Hono 框架，路由使用 Hono 的链式 `.get()` / `.post()` 方法
- **SSE**：后端使用 Hono 的 `streamSSE` 函数，前端使用浏览器原生 `EventSource`
- **校验**：路由参数使用 Zod 校验（`validator("json", z.object({...}))` 模式）
- **LLM 调用**：使用 Vercel `ai` 库的 `streamText` 函数，模型通过 `Provider.getModel()` + `Provider.getLanguage()` 两步获取
- **状态管理**：前端用 SolidJS 的 `createStore` + `createSignal` 管理全局状态

---

## 设计决策（已确定）

1. **目标语言**：UI 当前固定翻译为中文，后端 API 预留 `targetLanguage` 参数方便未来扩展。
2. **适用范围**：所有 `.md` / `.mdx` / `.markdown` 文件都显示翻译按钮，但排除文件名已以 `_zh` 结尾的文件（避免产生 `_zh_zh.md`）。
3. **Prompt 风格**：从原始物理专用 Prompt 泛化为通用学术翻译（删除物理术语示例，保留公式保护规则）。
4. **基础设施**：泛化现有进度条组件使其同时支持 PDF 转换和翻译两种任务类型；翻译模块在后端维护独立的任务队列（与 PDF 转换队列互不阻塞）。

---

## 一、功能概述

用户在文件查看器中打开 Markdown 文件时，顶部工具栏出现「翻译为中文」按钮。点击后弹出配置对话框选择模型，点击开始后进度条实时显示翻译进度，完成后生成 `{filename}_zh.md` 保存在原文件旁边。

### 用户操作流程

```
用户在文件树中点击 .md 文件
  → 文件查看器顶部工具栏出现「翻译为中文」按钮（与编辑、换行等按钮并排）
  → 点击按钮 → 弹出配置对话框（选模型、确认冲突处理）
  → 点击开始 → 对话框关闭，顶部进度条实时显示「翻译 3/10 块 · 翻译中 52%」
  → 完成后自动打开生成的 _zh.md 文件
```

---

## 二、需要修改的现有文件（共 3 个）

修改时必须保持与现有 PDF 转换功能的完全兼容（不能破坏 PDF 转换功能）。

### 2.1 进度条组件：`packages/app/src/components/pdf-convert-progress.tsx`

**目标**：泛化进度条，使其同时支持 PDF 转换和翻译两种任务。

需要做的事情：

1. **在 `PdfConvertTask` 接口中新增两个字段**：一个 `taskType` 字段标识任务类型（值为 `"pdf-convert"` 或 `"translate"`），一个 `cancelUrl` 字段存储取消 API 的路径（如 `"/file/pdf-to-markdown/cancel"` 或 `"/file/translate-markdown/cancel"`）。这两个字段必须在 `emptyTask` 默认值中设定，分别默认为 `"pdf-convert"` 和 `"/file/pdf-to-markdown/cancel"`，这样现有 PDF 对话框调用 `registerConvertTask` 时不传这两个字段也能正常工作。

2. **取消功能动态化**：当前 `handleCancel` 函数（约第 145 行）中取消 API 路径是硬编码的 `"/file/pdf-to-markdown/cancel"`。改为从全局任务状态中读取 `cancelUrl` 字段：`await globalFetchApi(task.cancelUrl, ...)`。

3. **阶段标签扩展**：在 `phaseLabel` 的 switch 映射中增加 `"translate"` 对应 `"翻译中"`。注意：翻译任务不会产生 `"postqa"` 阶段，因此 postqa 相关分支（第 184-188 行的 `<Show when={task.phase === "postqa"}>` 显示"正在检查"）无需修改——当 taskType 为 translate 时该分支的 when 条件永远为 false，自然走 fallback。

4. **显示文字动态化**：当前进度条 JSX 中有多处硬编码 "PDF" 字样（散布在约第 180-198 行的多个 `<Show>` 块中）。需要根据 `taskType` 动态切换。建议在组件内部添加两个 helper 函数，然后在各 `<Show>` 块中使用：

   ```tsx
   // 在组件内部添加
   const isTranslate = () => task.taskType === "translate"
   const unitLabel = () => isTranslate() ? "块" : "页"
   ```

   然后逐个替换硬编码文字（**不要重构 JSX 结构**，只替换文字部分）：

   | 原始文字 | 替换为 |
   | --- | --- |
   | `PDF 排队中（第 {queuePosition()} 位）` | `{isTranslate() ? "翻译" : "PDF"} 排队中（第 {queuePosition()} 位）` |
   | `PDF {task.currentPage}/{task.totalPages} 页 · {phaseLabel()}` | `{isTranslate() ? "翻译" : "PDF"} {task.currentPage}/{task.totalPages} {unitLabel()} · {phaseLabel()}` |
   | `PDF 转换完成` | `{isTranslate() ? "翻译完成" : "PDF 转换完成"}` |

   其余文字（"转换失败"、"已取消"）不含 "PDF" 字样，无需改动。

5. **兼容性保证**：由于新字段在 `emptyTask` 中有默认值，`registerConvertTask` 的函数签名（`task: Partial<PdfConvertTask>`）无需修改——Partial 自动接受新字段。现有 PDF 对话框（`dialog-pdf-to-markdown.tsx`）完全不需要任何修改。

### 2.2 文件标签页：`packages/app/src/pages/session/file-tabs.tsx`

**目标**：在 Markdown 文件的工具栏中添加「翻译为中文」按钮。

需要做的事情：

1. **添加翻译按钮**：在顶部工具栏区域（约第 582 行的 `<div class="flex justify-end px-3 pb-1 shrink-0 gap-1.5">` 中，与 Python 运行按钮、换行按钮并排），为 Markdown 文件添加一个「翻译为中文」按钮。具体位置：在已有的 `<Show when={!isEditing() && isPython()}>` 块（约第 583 行）附近，新增一个类似的 `<Show>` 块。按钮使用 `IconButton` 组件，样式与现有按钮一致（可使用 `"translate"` 或 `"language"` 图标，如果没有合适图标则用文字按钮）。

2. **显示条件**：按钮仅在以下条件同时满足时显示：
   - 当前文件是 Markdown 文件（复用现有的 `isMarkdown()` 判断）
   - 不处于编辑模式
   - 文件名（去掉扩展名后）不以 `_zh` 结尾（避免对已翻译文件显示翻译按钮）

3. **点击行为**：点击按钮时，使用现有的 `dialog.show()` 弹出翻译配置对话框（新建的 `DialogTranslateMarkdown` 组件），传入当前文件路径。

### 2.3 后端路由：`packages/opencode/src/server/routes/file.ts`

**目标**：新增 4 个翻译相关的 API 路由。

所有路由都遵循现有 PDF 转换路由的模式（Hono 链式调用、`describeRoute` + `validator` + async handler），在现有 PDF 路由之后链式添加。

**重要**：现有路由中所有 API 调用都会由前端附加 `directory` 查询参数（表示项目目录），翻译路由也需要支持这一模式。

#### 路由 1：预检查 — `GET /file/translate-markdown/check`

请求参数（query）：`path`（Markdown 文件路径）

返回 JSON 包含以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `hasDataJson` | boolean | 是否存在对应的 `_data.json` |
| `chunkCount` | number | 预估分块数（有 `_data.json` 时为其 `pages` 数组长度；否则实际读取文件内容并调用分块器的分块逻辑计算，这是一个轻量操作——只做字符串分割不调用 LLM） |
| `outputPath` | string | 预计输出路径（`{basename}_zh.md`） |
| `existingFiles` | string[] | 已存在的同名输出文件路径列表（空数组表示没有冲突） |
| `fileSize` | number | 原始文件大小（字节） |

#### 路由 2：启动翻译 — `POST /file/translate-markdown`

请求 body（JSON）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | Markdown 文件路径 |
| `providerID` | string | LLM provider ID |
| `modelID` | string | LLM model ID |
| `targetLanguage` | string | 目标语言代码，默认 `"zh-CN"` |
| `conflictAction` | `"replace"` \| `"rename"` \| `"cancel"` | 同名文件冲突处理策略 |

返回 JSON：`{ taskID: string }`

#### 路由 3：进度流 — `GET /file/translate-markdown/progress`

请求参数（query）：`taskID`

SSE 端点，使用 Hono 的 `streamSSE` 实现。逻辑与现有 `/file/pdf-to-markdown/progress` 完全一致：先发送任务已有的事件历史，然后注册实时监听器，5 秒心跳保活，连接中断或任务结束时清理。

SSE 事件数据格式（JSON），翻译功能使用以下事件类型：

| 事件 type | 字段 | 说明 |
| --- | --- | --- |
| `progress` | `currentPage`, `totalPages`, `phase` | 当前翻译进度。`phase` 固定为 `"translate"` |
| `token` | `input`, `output`, `total` | 累计 token 使用量 |
| `page_done` | `page`, `figureCount` | 一个块翻译完成。`figureCount` 固定为 `0` |
| `done` | `outputPath`, `totalTokens` | 翻译完成，`totalTokens` 包含 `input` 和 `output` |
| `error` | `message`, `page?` | 错误。有 `page` 字段表示单块错误（不终止），无 `page` 表示致命错误 |

#### 路由 4：取消翻译 — `POST /file/translate-markdown/cancel`

请求 body（JSON）：`{ taskID: string }`

返回 JSON：`{ ok: boolean }`

---

## 三、需要新建的文件

### 3.1 后端：`packages/opencode/src/markdown-translator/` 目录（5 个文件）

#### 3.1.1 类型定义文件

定义翻译功能所需的类型，参照 `packages/opencode/src/pdf-converter/types.ts` 的结构：

- **翻译任务配置**：包含字段 `path`（文件绝对路径）、`providerID`、`modelID`、`targetLanguage`、`conflictAction`。
- **进度事件**：联合类型，包含 progress / token / page_done / done / error 五种变体（字段定义见上方路由 3 的 SSE 事件表格）。翻译只使用 `phase: "translate"` 这一个阶段。
- **翻译任务状态**：包含 `id`、`config`、`status`（"running" / "done" / "error" / "cancelled"）、`events`（进度事件数组）、`listeners`（实时监听回调集合）、`abortController`。

#### 3.1.2 公式保护器

**核心目的**：在翻译前将数学公式和图片引用替换为不可翻译的占位符，翻译后再回填原始内容。这是翻译质量的关键保障——双重保护（Prompt 层面 + 代码层面）。

**直接从 Python 移植**，源代码在 `/home/bzz/create_problems/src/translate.py` 第 36-157 行的 `FormulaProtector` 类。移植时保持完全一致的逻辑、正则表达式和处理顺序。

三个核心方法：

- **protect**：提取所有公式和图片引用，替换为占位符。处理顺序非常重要，必须严格按此顺序：①图片引用 `![...](...)` → ②Figure 占位符 `[FIGURE:fig_N]` 和 `[FORMULA_FIGURE:ffig_N]` → ③块级公式 `$$...$$`（必须先于行内，避免 `$$` 被当作两个 `$`） → ④行内公式 `$...$`
- **restore**：将翻译后文本中的占位符回填为原始公式，回填顺序与替换顺序相反。
- **verify**：验证回填后的结果是否保留了所有原始公式（比对块级和行内公式数量）。返回问题列表，为空表示通过。

占位符使用 Unicode 特殊字符包裹（如 `⟦FORMULA_BLOCK_0⟧`），不太可能出现在自然文本中。具体格式和正则表达式请直接参考 Python 源码。

#### 3.1.3 Markdown 分块器

提供两种分块模式，以及一个检测函数：

**模式 A：从 `_data.json` 获取分页**（用于 PDF 转换产物）

- 读取 `_data.json` 中每一页的最终内容，每页作为一个独立的翻译块。
- `_data.json` 的结构定义在 `packages/opencode/src/pdf-converter/types.ts` 的 `ConvertDataJSON` 接口中，其中 `pages` 数组的每个元素都有 `final_content` 字段。

**模式 B：按内容分块**（用于普通 .md 文件）

- 优先按 `##` 二级标题分块（每个标题及其下属内容为一个块）
- 如果没有二级标题，按连续空行分块
- 如果单块超过 8000 字符（约 4000 token），在段落边界处进一步拆分
- 最小块不设下限

**检测函数 `detectDataJson`**：签名为 `detectDataJson(mdPath: string): Promise<string | null>`。给定 .md 文件路径（如 `/path/to/textbook.md`），检查同目录下是否存在 `textbook_data.json`（即将文件名的扩展名替换为 `_data.json`），存在则返回该路径，否则返回 null。使用 `Bun.file(path).exists()` 检查。

#### 3.1.4 翻译 Prompt

从 `/home/bzz/create_problems/src/prompts.py` 中的 `TRANSLATE_PAGE_PROMPT` 变量泛化而来（搜索该变量名定位，不要依赖行号）。

**保留的规则**：

- 数学公式完全不动（`$...$` 和 `$$...$$` 之间的内容原封不动，包括 `\text{...}` 中的英文）
- 图片引用完全不动（`![...](...)` 和 `[FIGURE:fig_N]` 等占位符）
- Markdown 结构保留（标题层级、列表、表格、粗体斜体标记保留，文字翻译）
- 学术翻译风格（严谨准确、术语标准译名、人名保留原文）
- 引用翻译规则（Eq. → 式，Chapter → 第X章，Figure → 图 X 等）
- 输出要求（只返回翻译后内容，不加代码块包裹，空白返回空字符串）

**删除/修改的部分**：

- 「精通物理学」改为「专业的学术翻译专家」
- 删除物理术语示例（Hamiltonian、coupling constant 等），改为通用规则「专业术语使用目标语言的标准译名」
- 删除页眉/页脚处理规则（翻译输入已经是干净的 Markdown）

Prompt 是一个模板，包含 `{targetLanguage}`（目标语言名称，如"中文（简体）"）和 `{content}`（待翻译内容）两个占位符。提供一个函数将它们填入模板。

#### 3.1.5 主入口（任务管理 + 翻译逻辑）

此文件包含两部分：

**Part A：任务队列管理**

与 `packages/opencode/src/pdf-converter/index.ts` 的任务管理逻辑结构完全一致，但使用独立的变量实例和不同的导出函数名。翻译任务和 PDF 转换任务各自有独立的队列，互不阻塞。

需要导出三个函数供路由使用：`getTranslateTask(taskID)`（根据 taskID 查找）、`startTranslation(taskID, config)`（创建任务并入队）、`cancelTranslateTask(taskID)`（取消翻译）。

同一时刻只有一个翻译任务在运行，其他排队等待。

**Task ID 生成**：新建一个 `generateTranslateTaskID()` 函数（或复用 `pdf-converter/util.ts` 的 `generateTaskID` 并修改前缀）。翻译任务的 ID 使用 `translate-{timestamp}-{random}` 格式，与 PDF 任务的 `pdf-` 前缀区分。该函数在路由层调用（与 PDF 路由一致）。

**Part B：核心翻译逻辑**

实现为 AsyncGenerator，逐步 yield 进度事件供 SSE 推送。

翻译流程：

1. **获取 LLM 模型实例**：通过 `Provider.getModel(ProviderID.make(...), ModelID.make(...))` 获取模型信息，再通过 `Provider.getLanguage(modelInfo)` 获取 LanguageModel 实例。这是本项目调用 LLM 的标准两步模式。
2. **获取分块**：调用检测函数判断是否有 `_data.json`，有则按页分块，否则按内容分块。
3. **逐块翻译**（支持 3 并发）：
   - 对每个块执行：公式保护 → 构建 Prompt → 调用 LLM（使用 `ai` 库的 `streamText`，纯文本输入，`maxOutputTokens` 设为 16000） → 清理响应（去除 LLM 可能添加的 ` ```markdown ` 代码块包裹） → 公式回填 → 验证公式完整性
   - 每完成一个块，yield 一次 progress、token、page_done 事件
   - 并发策略：同时启动最多 3 个翻译，但按块的原始顺序 yield 进度事件。实现方式如下伪代码：

     ```typescript
     // 信号量控制并发
     const CONCURRENCY = 3
     let running = 0
     const wait = () => new Promise<void>(r => { /* 当 running < CONCURRENCY 时 resolve */ })

     // 为每个块创建 Promise（立即全部启动，信号量限流）
     const results: Promise<ChunkResult>[] = chunks.map((chunk, i) => {
       return (async () => {
         await wait()  // 等待信号量
         running++
         try {
           return await translateOneChunk(chunk, i, abortSignal)
         } finally {
           running--
           // 释放信号量，唤醒等待者
         }
       })()
     })

     // 按原始顺序依次 await 并 yield 进度事件
     for (let i = 0; i < results.length; i++) {
       const result = await results[i]
       completedCount++
       yield { type: "progress", currentPage: completedCount, totalPages: total, phase: "translate" }
       yield { type: "token", input: totalInput, output: totalOutput, total: totalInput + totalOutput }
       yield { type: "page_done", page: i + 1, figureCount: 0 }
     }
     ```

4. **容错**：如果某个块翻译失败（LLM 调用报错），使用原文作为该块的翻译结果（保证输出完整性），记录警告日志，继续翻译后续块。不中断整个任务。
5. **合并翻译块**：按原始顺序用双换行拼接所有翻译后的块。
6. **计算输出路径**：`{原文件目录}/{原文件名去扩展名}_zh.md`，根据冲突策略处理同名文件（直接 import 并复用 `pdf-converter/util.ts` 的 `resolveConflict` 函数）。
7. **写入文件**并 yield done 事件。

---

### 3.2 前端：`packages/app/src/components/dialog-translate-markdown.tsx`

翻译配置对话框。整体模式参考 `dialog-pdf-to-markdown.tsx`，但更简单（不需要页面范围选择、输出模式选择、Python 环境检查）。

#### 前端 API 调用模式（重要）

本项目的前端 API 调用有固定模式，翻译对话框必须遵循。参考 `dialog-pdf-to-markdown.tsx` 中的 `fetchApi` 函数：

- 每个请求都需要注入 HTTP Basic Auth 头（如果服务器配置了密码）
- 每个请求的 URL 都需要附加 `directory` 查询参数（表示当前项目目录）
- 使用 `useSDK()` 获取 API base URL，`useServer()` 获取认证信息

对话框组件需要使用以下 SolidJS context（与 PDF 对话框一致）：`useDialog()`、`useLocal()`、`useSDK()`、`useServer()`、`useModels()`。

#### 模型选择器适配模式（重要）

翻译对话框需要使用 `ModelSelectorPopover` 组件选择模型。这个组件需要一个特殊的 adapter 对象作为 `model` prop，用于将对话框自己的模型状态适配为组件期望的接口。参考 `dialog-pdf-to-markdown.tsx` 中的 `pdfModelState` 对象——翻译对话框需要创建一个类似的 adapter，但使用独立的全局 signal 存储翻译模型选择（与 PDF 转换的模型选择互不影响）。

首次打开时，如果没有保存过翻译模型，使用当前聊天模型作为默认值。之后独立记住用户的选择。

#### 对话框内容

1. **模型选择**：使用 `ModelSelectorPopover`（见上方模式说明）。提示文字：「翻译不需要多模态能力，纯文本模型即可」。

2. **费用提醒**：黄色提示框「翻译会对每一块调用 LLM，较长文件会产生一定 API 费用」。

3. **`_data.json` 检测提示**：如果预检查接口返回 `hasDataJson: true`，显示提示「检测到该文件由 PDF 转换生成，将使用逐页翻译模式（共 N 页）以获得更好效果」。

4. **自动打开复选框**：「翻译完成后自动打开生成的文件」，默认勾选。

5. **文件冲突提示**：如果预检查接口返回已存在的文件，显示冲突处理选项（覆盖/重命名），模式与 PDF 对话框完全一致。

6. **操作按钮**：取消 / 开始。

#### 对话框行为

- **打开时**（onMount）：调用预检查接口 `GET /file/translate-markdown/check` 获取文件信息，显示加载状态。
- **点击开始**：
  1. 调用 `POST /file/translate-markdown` 启动翻译，获取 taskID
  2. 调用 `registerConvertTask()` 注册到全局进度条——**关键**：必须传入 `taskType: "translate"` 和 `cancelUrl: "/file/translate-markdown/cancel"`，否则进度条会显示 "PDF" 文字并调用错误的取消接口
  3. 创建 `EventSource` 连接到 `GET /file/translate-markdown/progress?taskID=xxx`，并调用 `registerEventSource()` 注册引用
  4. 在 SSE 的 `onmessage` 回调中，根据事件 type 调用 `updateConvertTask()` 更新全局进度条状态（与 PDF 对话框逻辑一致，区别是 done 事件不需要 postqa 延迟判断，直接完成并调用 `triggerOpenFile`）
  5. 关闭对话框
- **设置持久化**：模型选择、自动打开、冲突处理选项存储在 localStorage 中（使用独立的 key，如 `"translate-markdown-settings"`），下次打开时恢复。

---

## 四、输出文件结构

### 普通 .md 文件翻译

```
parent_directory/
├── paper.md              (原始文件)
└── paper_zh.md           (翻译后)
```

### PDF 转换产物翻译

```
parent_directory/
├── textbook.pdf
├── textbook.md           (PDF 转换产物)
├── textbook_data.json    (结构化数据，翻译时只读，不修改)
├── textbook_zh.md        (翻译后)
└── textbook_images/      (图片目录，翻译版复用同一套图片)
```

翻译后的 `textbook_zh.md` 中的图片路径与 `textbook.md` 相同，指向同一个 `textbook_images/` 目录，无需复制图片。

---

## 五、实现顺序

建议按以下顺序实现，确保每一步都可以独立验证：

1. 后端类型定义
2. 公式保护器（从 Python 移植）
3. 翻译 Prompt（从 Python 泛化）
4. 分块器
5. 主入口（任务管理 + 翻译 AsyncGenerator + 并发控制）
6. 后端 API 路由（4 个）
7. 前端进度条泛化
8. 前端翻译对话框
9. 前端翻译按钮

---

## 六、验证清单

1. 打开一个普通 .md 文件，确认顶部工具栏出现「翻译为中文」按钮
2. 打开一个 `_zh.md` 文件，确认**不**出现翻译按钮
3. 点击翻译按钮，确认对话框正确显示模型选择
4. 对 PDF 转换产物的 .md 文件，确认对话框中显示 `_data.json` 检测提示和页数
5. 选择模型后点击开始，确认进度条显示「翻译 3/10 块 · 翻译中 52%」（不是"PDF"）
6. 确认进度条的取消按钮正确调用 `/file/translate-markdown/cancel`（不是 PDF 的取消路由）
7. 确认翻译完成后进度条显示「翻译完成」（不是"PDF 转换完成"）
8. 确认生成 `_zh.md` 文件且自动打开
9. 检查翻译结果中的 LaTeX 公式（`$...$` 和 `$$...$$`）是否被完整保留
10. 检查图片引用路径是否正确（与原文件相同）
11. 启动一个 PDF 转换任务，同时启动一个翻译任务，确认两者互不阻塞
12. 同名文件已存在时，确认冲突处理（替换/重命名）正常工作
13. 翻译一个很长的文件，确认某个块翻译失败时不中断整个任务（失败块用原文替代）

---

## 七、完整文件清单汇总

| 类型 | 文件路径 | 说明 |
| --- | --- | --- |
| 新建 | `packages/opencode/src/markdown-translator/types.ts` | 类型定义 |
| 新建 | `packages/opencode/src/markdown-translator/formula-protector.ts` | 公式保护器 |
| 新建 | `packages/opencode/src/markdown-translator/prompts.ts` | 翻译 Prompt |
| 新建 | `packages/opencode/src/markdown-translator/chunker.ts` | 分块逻辑 |
| 新建 | `packages/opencode/src/markdown-translator/index.ts` | 主入口 + 任务管理 |
| 新建 | `packages/app/src/components/dialog-translate-markdown.tsx` | 前端对话框 |
| 修改 | `packages/opencode/src/server/routes/file.ts` | 新增 4 个 API 路由 |
| 修改 | `packages/app/src/components/pdf-convert-progress.tsx` | 泛化进度条支持多任务类型 |
| 修改 | `packages/app/src/pages/session/file-tabs.tsx` | 添加翻译按钮 |
