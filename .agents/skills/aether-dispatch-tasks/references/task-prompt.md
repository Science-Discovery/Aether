# 沙箱任务书模板

把 `{...}` 占位符替换为实际值后，经 `prompt_async` 发给沙箱会话。

---

你是任务执行 agent，负责 Aether 仓库（aether-dev）的第 {NUM} 号任务。你在独立 worktree 中工作，可放心修改文件、创建分支。

## 任务

{任务描述}。先读参考报告 {REPORT} 确认原文与全文（含"修复执行建议"），再读对应源码确认问题在当前基线仍存在（基线 = origin/dev）。

## 准备步骤（必做，按序）

1. `git fetch origin dev`（如遇 ref lock 冲突，等 2 秒重试，最多 3 次）
2. `git checkout -b {BRANCH} origin/dev`
3. 读报告相关条目 + 相关源码，确认问题存在；若已不存在或与描述严重不符，停止修复，不开 issue 不开 PR，最终汇报里说明原因。

## 修复要求

- 优雅、健壮、最小侵入；优先按报告"修复方向"实现，若有更优方案须在 PR 中论证理由。
- 严格遵循仓库 AGENTS.md 代码风格：单词条命名、避免 try/catch 与 else、const 优先、Bun API、不写注释除非必要。

## 测试要求（必须全部满足）

- 为报告中的失败场景写回归测试（测试保护），并全部跑通。
- bun test 必须在对应 package 目录运行（如 packages/opencode），禁止从仓库根运行。
- 涉及 Solid 响应式（createMemo/store/effect）的单测必须命名为 \*.vitest.ts 放 vitest 目录（bun test 下 solid-js 解析为 server build，会假通过）。
- bun typecheck 在对应 package 目录运行并通过。
- Playwright e2e 可以正常运行。

## 提交与 PR（必须按序执行）

1. 若无关联 issue，先按 .agents/skills/aether-issue-pr skill 流程建 issue（按仓库 issue 模板填写），记录返回编号；用户已给定或本任务已建则复用。禁止无 issue 的 PR。
2. 规范 commit message 提交，push 到 origin。
3. `gh pr create --repo Science-Discovery/Aether --base dev --head <fork所有者>:{BRANCH}`，正文以 `Closes #<issue号>` 关联，描述含问题、改动点、测试与验证结果（head 所有者按 `gh auth status` 实际账号/仓库 remote 填）。
4. `gh pr checks <PR号>` 跟踪 CI；失败读日志、修复后推同一 PR，直到绿或确认环境阻塞（此时汇报原因）。CI 偶发 flaky（多沙箱并行 runner 紧张）时先对照 dev 基线判断，环境性问题单次有限重跑并记录原因。

## 边界

- 只修本任务，不要顺手修其他问题；不要修改参考报告文件本身。
- {同文件相邻区域的其他并行任务提示（如有）：改动尽量局部化，PR 中注明可能冲突区域。}
- 最终汇报：issue 链接、PR 链接、分支名、改动摘要、测试清单与结果、CI 状态。

## 任务原文

{报告条目原文}
