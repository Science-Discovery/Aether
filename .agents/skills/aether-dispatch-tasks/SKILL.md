---
name: aether-dispatch-tasks
description: Dispatch autonomous tasks in parallel to multiple directories/worktrees in the aether-dev repo by creating one real session per directory via the local opencode server API (POST /session + prompt_async). Use when the user asks to 分派/派发任务给多个沙箱/worktree/目录, run one task per sandbox in parallel ("每个worktree一个任务", "分配给N个沙箱"), wants each task to be a real trackable session in the sidebar (输出可跟踪), or asks how the dispatch mechanism works. Covers locating the server port and auth, writing complete task briefs, the dispatch script, status verification, and progress tracking/cleanup.
---

# Aether Dispatch Tasks

向多个目录（worktree/沙箱）并行派发自主体任务：每个目录建一个真实会话（侧边栏可跟踪），通过 `prompt_async` 立即返回、天然并行。通用流程与任务内容无关。

## Workflow

1. 定位 server 端点与鉴权 → 2. 枚举执行位置 → 3. 组装任务书 → 4. 派发脚本执行 → 5. 落盘映射 → 6. 验证 busy → 7. 跟踪/回收

### Step 1: 定位 server 端点与鉴权

```bash
echo $OPENCODE_PID
netstat -ano | grep "$OPENCODE_PID" | grep LISTENING   # → 127.0.0.1:<port> LISTENING <pid>
echo $OPENCODE_SERVER_PASSWORD
```

- base URL `http://127.0.0.1:<port>`；HTTP Basic，username 固定 `opencode`
- 每个请求都带 `?directory=<执行位置绝对路径>`（否则落到默认目录）

### Step 2: 枚举执行位置

`git worktree list` 或任何"目录 → 标识"映射来源，产出 `[(标识, 目录绝对路径, 任务正文), ...]`。

### Step 3: 组装任务书

任务书 = 公共模板（占位符 `{ID}` `{DIR}` `{EXTRA}`）+ 每条专属内容。模板与完整示例见 [references/task-brief-template.md](references/task-brief-template.md)。

六段结构（子 agent 没有调用方上下文，缺一段就返工一次）：

1. 角色（你在独立目录 {DIR} 工作，可放心读写）
2. 准备步骤（按序，含失败时的停止条件）
3. 执行要求（质量约束 + 要求其用 subagents 并行处理独立子问题）
4. 验证要求（具体命令与运行目录；不可执行的操作给替代方案）
5. 提交与产出（产出形式；引用相关 skill 而非复制规范）
6. 边界与汇报格式（只处理本项；汇报改动摘要/验证结果/产出链接/未解决项）

**把并行冲突显式写进任务书**：共享端口的操作禁止并行（如 Playwright e2e）；改同一文件相邻区域的任务要求改动局部化 + 注明冲突风险；受保护路径要求先查门禁。

### Step 4: 派发

用 [scripts/dispatch.py](scripts/dispatch.py)（Python + urllib，见脚本头部用法注释）。核心两个 endpoint：

| 操作   | 请求                                              | body                                       |
| ------ | ------------------------------------------------- | ------------------------------------------ |
| 建会话 | `POST /session?directory=<dir>`                   | `{"title": "..."}`                         |
| 派发   | `POST /session/:sid/prompt_async?directory=<dir>` | `{"parts":[{"type":"text","text":"..."}]}` |

`prompt_async` 返回 204 立即返回不阻塞；同步的 `/prompt` 会阻塞，并行场景禁用。

### Step 5-6: 落盘与验证

- 脚本自动写 `dispatch-results.json`（id → dir → session 映射），后续跟踪只依赖它
- 派发后必须抽查 `/session/status?directory=<dir>`，全部目标会话 `busy` 才算成功；HTTP 200 不代表任务真的在跑

### Step 7: 跟踪与回收

| 操作   | 请求                                                               |
| ------ | ------------------------------------------------------------------ |
| 查进度 | `GET /session/status?directory=<dir>`（`{sessionID:{type}}` 映射） |
| 读消息 | `GET /session/:sid/messages?directory=<dir>`                       |
| 中止   | `POST /session/:sid/abort?directory=<dir>`                         |
| 删除   | `DELETE /session/:sid?directory=<dir>`                             |

## 关键坑

| 坑                             | 处理                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| Windows 路径塞 query 会坏      | `urllib.parse.quote(dir, safe="")`，路径统一正斜杠 `C:/...`  |
| Python 读 UTF-8 JSON 报 GBK 错 | 显式 `encoding="utf-8"`                                      |
| `/session/status` 返回结构     | `{sessionID:{type}}` 映射，不是数组                          |
| 用了同步 `/prompt`             | 并行必须 `prompt_async`                                      |
| 一次性检查被重复               | 鉴权/权限/基线检查在派发前做一次，别让 N 个 agent 各失败一次 |
| 目录未绑定                     | 每个 endpoint 都带 `?directory=`                             |

验证机制先行：先对一个目录做"建会话→prompt→删除"最小闭环，确认通路后再批量派发。
