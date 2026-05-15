<h1 align="center">Aether（以太）</h1>
<p align="center"><em>Autonomous Engine for Theoretical & Hands-on Exploration in Research</em></p>
<p align="center">面向科研人員的 AI 研究助手，基於 <a href="https://github.com/anomalyco/opencode">OpenCode</a> 深度定制。</p>
<p align="center"><a href="https://aether.aiphys.cn/">🌐 aether.aiphys.cn</a></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a>
</p>

---

## 專案簡介

Aether 是一個功能豐富的 AI 研究助手平台。它以客戶端/伺服器架構運行——CLI 在本機啟動 HTTP 服務，透過瀏覽器提供完整的互動介面。支援行動端（微信 / 飛書 / QQ）接入。未來預計支援桌面客戶端（Electron）。

### 核心特性

- **開箱即用**：下載安裝包雙擊即可啟動，內建預設模型配置
- **完整程式設計能力**：程式碼執行、LSP 程式碼感知、檔案和終端機操作，覆蓋日常開發全流程
- **25+ AI 提供商**：支援 Anthropic、OpenAI、Google Gemini、AIhubmix、DeepSeek、Z\.AI、Kimi、Qwen 等主流平台，以及任何 OpenAI 相容介面
- **10+ 個內建科研 Skills**：文獻綜述、論文寫作、深度研究、arXiv 搜尋、同行評審、研究基金撰寫等，開箱即用
- **Skill 自進化**：Agent 在完成任務後自動評審對話歷史，將成功經驗固化為可複用的 Skill（copy-on-write 寫入、安全掃描、版本快照），形成持續學習閉環
- **MCP 協定支援**：整合 Model Context Protocol，可連接本機或遠端 MCP 伺服器擴充工具集
- **知識庫（RAG）**：將 PDF 和文字文件向量化索引，支援語義搜尋，按相關性注入上下文，大幅節省 Token
- **PDF 閱讀模式**：在 Web 介面中直接閱讀 PDF，支援高亮標注、書籤、筆記，以及 AI 輔助翻譯和問答
- **PDF 轉 Markdown**：AI 驅動的多階段處理流水線，將 PDF 論文高品質轉換為可編輯的 Markdown（含公式和圖片提取）
- **Markdown 翻譯**：AI 翻譯 Markdown 文件，自動保護 LaTeX 公式不被破壞
- **語音輸入**：基於多模態模型的語音轉文字，自動去除語氣詞並糾正專業術語
- **Git 整合**：在介面中檢視分支、提交歷史、Diff 和檔案變更等
- **定時任務**：支援 Cron 表示式、固定間隔和一次性定時任務，可自動執行研究流程
- **Memory 機制**：AI 自動將使用者偏好和互動經驗持久化到 `memory.instruction.md`，跨會話複用，無需重複說明
- **會話分享**：產生分享連結，即時同步對話內容

---

## 安裝與啟動

### Installer 腳本安裝（推薦）

從[官網](https://aether.aiphys.cn/)下載對應平台的 Installer 腳本，一鍵安裝並享受自動更新。安裝完成後直接從系統應用程式中點擊執行即可。

### 手動安裝

從 [Releases 頁面](https://github.com/Science-Discovery/Aether/releases)下載對應平台的壓縮包。

#### Web 瀏覽器版

解壓後目錄結構：

```
aether          ← CLI 二進位（Windows 為 aether.exe）
web/            ← 前端靜態資源（必須與二進位同目錄）
Aether.vbs      ← Windows 啟動器
Aether.command  ← macOS 啟動器
```

**Windows**：雙擊 `Aether.vbs`（如果報錯，先執行 `Aether.exe`），瀏覽器自動開啟介面。

**macOS**：首次使用賦予執行權限後，雙擊 `Aether.command` 即可啟動：

```bash
chmod +x Aether.command aether   # 首次需要
```

**Linux**：

```bash
chmod +x aether   # 首次需要
./aether web
```

`aether web` 啟動後會顯示本機和區域網路存取位址，瀏覽器自動開啟。

<!-- 支援以下選項：

```bash
./aether web --port 8080              # 指定連接埠
./aether web --hostname 0.0.0.0       # 允許區域網路存取
./aether web --idle-timeout 120       # 空閒逾時（秒），0 表示常駐執行
``` -->

### Electron 桌面版

敬請期待

<!-- 解壓（或安裝）後雙擊執行：

| 平台 | 檔案 |
|---|---|
| Linux | `aether-linux-x64.AppImage` / `.deb` / `.rpm` |
| macOS | `aether-mac-arm64.dmg`（Apple Silicon）/ `aether-mac-x64.dmg` |
| Windows | `aether-win-x64.exe` 安裝程式 / `win-unpacked/` 便攜版 |

--- -->

## 從原始碼執行

適用於開發除錯。**依賴：** [Bun](https://bun.sh/) 1.3+

```bash
bun install
```

### Web UI 開發模式

需要兩個終端機分別啟動後端和前端：

```bash
# 終端機 1：啟動 API Server
bun dev serve

# 終端機 2：啟動前端（然後開啟顯示的 http://localhost:xxxx）
bun run --cwd packages/app dev
```
網頁開啟後如果發現資源載入失敗，可以手動新增終端機 1 中顯示的 `http://localhost:xxxx` 到伺服器列表中。

---

## 設定 AI 提供商

可使用預建免費提供商，也可透過設定介面新增 AI 提供商（推薦）。

## 功能詳解

### 內建 Skills

Aether 預建了 16 個面向科研場景的 Skills，透過描述自動觸發，無需手動呼叫：

| 類別 | Skill | 功能 |
|---|---|---|
| 開發工具 | `skill-creator` | 建立和最佳化 Agent Skills |
| | `skill-manager` | 掃描、分類和管理 Skills 集合 |
| | `code-reviewer` | 程式碼審查（安全、效能、最佳實踐） |
| | `project-signpost` | 產生專案目錄導航檔案 |
| 學術研究 | `academic-researcher` | 文獻綜述、論文分析、公式推導 |
| | `literature-review` | 多資料庫系統文獻綜述 |
| | `peer-review` | 同行評審工具包 |
| | `write-paper` | 從研究專案檔案產生 LaTeX 論文 |
| | `deep-research` | 多源綜合深度研究 |
| | `arxiv-search` | 搜尋 arXiv 預印本 |
| | `read-arxiv-paper` | 閱讀和分析 arXiv 論文 |
| | `research-grants` | 撰寫研究基金申請書 |
| | `scientific-critical-thinking` | 科學證據品質評估 |
| | `scientific-brainstorming` | 科研假設產生與跨學科探索 |
| | `response-to-referee` | 逐條回覆審稿人意見 |
| 通用 | `brainstorming` | 在實作之前將想法轉化為設計方案 |

學術 Skills 可串聯使用：`arxiv-search` → `read-arxiv-paper` → `literature-review` → `write-paper`

### 知識庫

將 PDF 論文或文字文件（`.md`、`.txt`、`.json`、`.yaml`、`.csv`、`.tex`）批次向量化索引：

- **三種嵌入方式**：OpenAI API、本機模型 `all-MiniLM-L6-v2`（無需 API Key）、自訂介面
- **語義搜尋**：基於餘弦相似度檢索最相關段落，只注入必要的上下文，而非整篇文獻
- **自動同步**：偵測檔案增刪改，自動更新索引

### PDF 閱讀模式

在 Web 介面中直接閱讀 PDF：

- **標注系統**：高亮（四種顏色）、書籤、筆記
- **AI 輔助翻譯**：保留專業術語的英中翻譯
- **AI 問答**：基於目前頁及上下文頁面的內容回答問題
- **首次閱讀摘要**：開啟文件時自動產生全文摘要

### PDF 轉 Markdown

AI 驅動的多階段處理流水線：

1. 頁面渲染 → 文字提取 → 圖片定位 → 公式辨識
2. LaTeX 語法驗證和內容完整性檢查
3. 自動修復和跨頁面品質校驗

### MCP 工具整合

支援連接外部 MCP（Model Context Protocol）伺服器擴充 AI 能力：

```bash
aether mcp add <name> <command>    # 新增本機 MCP 伺服器
aether mcp list                     # 列出已設定的伺服器
aether mcp auth <name>              # OAuth 認證
aether mcp debug                    # 除錯 MCP 連線
```

### 行動端

透過微信、飛書、QQ 機器人從手機端與 Aether 對話。在 Web 介面的設定中配置對應平台的憑證即可啟用。

---

## 其他指令

```bash
aether web            # 啟動 Web 服務並開啟瀏覽器
aether serve          # 啟動無頭 API 伺服器
aether run <message>  # 非互動式執行指令
aether models         # 列出可用模型
aether providers      # 檢視提供商
aether mcp            # 管理 MCP 伺服器
aether session        # 會話管理
aether stats          # 檢視使用統計
aether upgrade        # 自更新
aether debug config   # 檢視目前設定
```

---

## 常見問題

**API 回傳 404**：檢查 `baseURL` 是否遺漏了 `/v1`。

**API 回傳 429**：Key 填錯，或被舊的 `auth.json` 覆蓋。刪除 `~/.local/share/opencode/auth.json` 後重試。

**瀏覽器未自動開啟**：手動存取終端機中顯示的 URL（依賴 `xdg-open`）。

**提示找不到前端資源**：確認 `aether` 二進位和 `web/` 目錄在同一目錄下。

**模型列表為空**：檢查環境變數 `OPENCODE_CONFIG` 路徑是否正確。
