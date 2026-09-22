# 任务书模板与完整示例

任务书 = 公共模板 + 每条专属内容。模板用 `{ID}` `{DIR}` `{EXTRA}` 占位符，派发时替换后拼接专属内容。

## 六段结构（每段不可省）

1. **角色**：你是谁、负责哪一项、在独立目录 {DIR} 工作可放心读写。
2. **准备步骤**（必做、按序）：含失败停止条件（目标与描述不符 → 停止 + 汇报原因，不产出）。
3. **执行要求**：质量约束（风格/规范/最小侵入）+ 要求用 subagents 并行处理独立子问题。
4. **验证要求**：具体命令与运行目录（如测试必须从 package 目录跑）；不可执行的操作给替代方案（如禁跑 e2e 时改单测 + CI 验证）。
5. **提交与产出**：产出形式（提交/文件/报告）；协作规范引用对应 skill（如 issue/PR 流程），不复制规范原文。
6. **边界与汇报格式**：只处理本项；最终汇报 = 改动摘要 + 验证结果 + 产出链接 + 未解决项。

## 并行冲突约束（多任务派发时必须显式写）

- **共享端口/资源的操作禁止并行**：如 Playwright e2e 端口冲突 → 统一禁跑本地 e2e，改单测/集成测试 + PR CI 验证。
- **改同一文件相邻区域的任务**：要求各自改动局部化 + PR 中注明冲突风险，方便 base 合并时解冲突。
- **受保护路径/门禁**：先查白名单与门禁流程，失败按流程核实原因，不得绕过。

## 完整示例（简化）

```
你是修复 agent，负责第 {ID} 项。你在独立 worktree 中工作，可放心修改文件、创建分支。

## 准备步骤（必做，按序）
1. git fetch origin dev（ref lock 冲突等 2s 重试，最多 3 次）
2. git checkout -b <branch> origin/dev
3. 读报告 + 相关源码确认问题仍存在；若已不存在，停止修复，最终汇报说明原因。

## 执行要求
- 优雅、健壮、最小侵入；遵循仓库 AGENTS.md 代码风格。
- 尽量用 subagents（Task 工具）并行调研/读码/写测试。

## 验证要求
- 为失败场景写回归测试并全部跑通；测试从对应 package 目录运行。
- bun typecheck 通过。
- 不要运行 Playwright e2e（N 个沙箱并行会端口冲突），e2e 交给 PR CI。

## 提交与产出
- 按 .agents/skills/aether-issue-pr skill 流程：先建 issue 再开 PR（base=dev）。
- 跟踪 CI，失败读日志修复后推同一 PR，直到绿或确认环境阻塞。

## 边界
- 只修第 {ID} 项；不要修改输入报告文件本身。
- 最终汇报：issue 链接、PR 链接、分支名、改动摘要、测试清单与结果、CI 状态。

## 任务内容
{EXTRA: 摘录该项的位置/场景/修复方向原文，再补一段"补充"写并行冲突约束}
```

## API 速查

| 操作   | 请求                                              | body                                       |
| ------ | ------------------------------------------------- | ------------------------------------------ |
| 建会话 | `POST /session?directory=<dir>`                   | `{"title": "..."}`                         |
| 派发   | `POST /session/:sid/prompt_async?directory=<dir>` | `{"parts":[{"type":"text","text":"..."}]}` |
| 查状态 | `GET /session/status?directory=<dir>`             | —（返回 `{sessionID:{type}}` 映射）        |
| 读消息 | `GET /session/:sid/messages?directory=<dir>`      | —                                          |
| 中止   | `POST /session/:sid/abort?directory=<dir>`        | —                                          |
| 删除   | `DELETE /session/:sid?directory=<dir>`            | —                                          |

- directory 必须 `urllib.parse.quote(dir, safe="")`；路径统一正斜杠。
- 并行派发必须用 `prompt_async`（204 立即返回）；同步 `/prompt` 会阻塞。
