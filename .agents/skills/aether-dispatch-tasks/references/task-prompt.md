# 沙箱任务书模板

把 `{...}` 占位符替换为实际值后，经 `prompt_async` 发给子会话（主工作区 directory 下建的会话）。

**当前会话模式同样沿用本模板的全部标准节**（准备步骤/修复要求/测试要求/提交与 PR/Review 自治闭环/边界）：把 `{WORKTREE}` 换成当前仓库工作区、`git -C {WORKTREE}` 去掉即可；review 闭环改在当前会话内执行（派 subagent → 结果回传当前会话决策 → PR comment → FAIL 返工循环）。

---

你是任务执行 agent，负责 Aether 仓库（aether-dev）的第 {NUM} 号任务。你在主工作区的一个会话中工作，但**所有实际改动都在分配给你的 worktree 中进行**。

## 工作目录约定（必须遵守）

- 你的 worktree：`{WORKTREE}`（主 agent 已分配；初始基于 origin/dev）。
- 你的 bash 默认 cwd 是主工作区——**所有 git 命令必须用 `git -C {WORKTREE} ...`**，**所有文件读/改/写必须用 `{WORKTREE}` 下的绝对路径**，禁止改动主工作区与其他 worktree 的任何文件。
- worktree 上挂的分支可能是旧任务残留：直接 `git -C {WORKTREE} checkout -b {BRANCH} origin/dev` 切新分支（见准备步骤）。

## 任务

{任务描述}。先读参考报告 {REPORT} 确认原文与全文（含"修复执行建议"），再读对应源码确认问题在当前基线仍存在（基线 = origin/dev）。

## 准备步骤（必做，按序）

1. `git -C {WORKTREE} fetch origin dev`（如遇 ref lock 冲突，等 2 秒重试，最多 3 次）
2. `git -C {WORKTREE} checkout -b {BRANCH} origin/dev`
3. 读报告相关条目 + 相关源码（都在 `{WORKTREE}` 下），确认问题存在；若已不存在或与描述严重不符，停止修复，不开 issue 不开 PR，最终汇报里说明原因。
4. **历史修复考古（修 bug/功能类任务必做）**：在 GitHub 仓库查这个 bug 之前有没有被修过：
   - 搜 closed issue/PR：`gh search issues --repo Science-Discovery/Aether --state closed "<关键词>"`、`gh search prs --repo Science-Discovery/Aether --state closed "<关键词>"`；再 `git -C {WORKTREE} log --oneline origin/dev -S"<关键标识>" -- <相关文件>` 找历史修复提交。
   - 找到过修复尝试 → 弄清楚**为什么 bug 仍然存在**（修了没修好/修好又复现）：读该 PR 的 diff 与讨论，对照当前代码确认补丁是否还在、覆盖路径是否与你观察到的失败场景一致（条件分支不同/竞态窗口/另一条调用路径绕过/后续改动又破坏了它）；把结论写进本任务的 issue 与 PR（说明与历史修复的关系、本次为何能真正修住，如新增保护性回归测试锁定该场景）。
   - 完全没有修复历史 → 跳过此步，正常流程。
   - 这一步的结论影响修复方向：复现类 bug 优先排查"上次为什么没修住"（根因常在假设失效处），再决定补丁位置。

## 修复要求

- 优雅、健壮、最小侵入；优先按报告"修复方向"实现，若有更优方案须在 PR 中论证理由。
- **边界条件专项检查**：实现完成后系统自查**边界条件**——即输入、状态、时序、资源在取值域边缘或极端组合下行为仍正确的情形。以下枚举只是起点，**不保证齐全**，必须自行按本功能的语义补全边界条件清单：空输入/空集合/undefined、数值 0/负数/溢出、首末元素、并发与竞态时序、失败与重试路径、资源耗尽/超时等；每识别一个边界条件，要么被正确处理、要么明确不适用（PR 中说明）。修 bug 类任务重点推演触发 bug 的边界条件是否被补丁真正覆盖（含与历史修复考古对照出的绕过路径）。
- 严格遵循仓库 AGENTS.md 代码风格：单词条命名、避免 try/catch 与 else、const 优先、Bun API、不写注释除非必要。

## 测试要求（必须全部满足）

- **验证测试（必须）**：写临时测试验证本次修改的正确性，覆盖报告中的失败场景并全部跑通；这是工作验证手段，不要求提交进仓库。
- **保护性回归测试（按需）**：是否把测试放进仓库长期保护相关功能，根据需求自行决定（易复发、历史修复过又复现、竞态时序类建议入库）；入库则与修复一起提交并在 PR 中说明。
- bun test 必须在对应 package 目录运行（如 `{WORKTREE}/packages/opencode`），禁止从仓库根运行。
- 涉及 Solid 响应式（createMemo/store/effect）的单测必须命名为 \*.vitest.ts 放 vitest 目录（bun test 下 solid-js 解析为 server build，会假通过）。
- bun typecheck 在对应 package 目录运行并通过。
- Playwright e2e 可以正常运行。多沙箱并行时：**禁止设置 `PLAYWRIGHT_SERVER_HOST`**（会把后端端口钉死 4096，并行必串台）；e2e 偶发失败先对照 dev 基线判断是否端口竞态/资源挤兑等环境性问题，是则单次有限重跑并记录，不要直接当回归修。

## 提交与 PR（必须按序执行）

1. 若无关联 issue，先按 .agents/skills/aether-issue-pr skill 流程建 issue（按仓库 issue 模板填写），记录返回编号；用户已给定或本任务已建则复用。禁止无 issue 的 PR。
2. 规范 commit message 提交，push 到 origin。
3. `gh pr create --repo Science-Discovery/Aether --base dev --head <fork所有者>:{BRANCH}`，正文以 `Closes #<issue号>` 关联，描述含问题、改动点、测试与验证结果（head 所有者按 `gh auth status` 实际账号/仓库 remote 填）。
4. `gh pr checks <PR号>` 跟踪 CI；失败读日志、修复后推同一 PR，直到绿或确认环境阻塞（此时汇报原因）。CI 偶发 flaky（多沙箱并行 runner 紧张）时先对照 dev 基线判断，环境性问题单次有限重跑并记录原因。

## Review 自治闭环（PR 就绪后必须在本会话内完成，不得跳过、不得交回主 agent）

1. **派一个 review subagent**（`task` 工具，general 类型），任务书：只读审查（禁止改文件/提交），对象=`{WORKTREE}` 分支 `{BRANCH}` head（以已推送 HEAD 为准）+ PR/issue 链接 + bug 原文；审查清单：完整 diff（含测试/fixture）、修复语义与竞态推演、回归风险（非目标路径行为不变）、测试判别力**实测**（仓库内回归测试：在 origin/dev 基线代码上跑应失败、在 PR head 上应通过——用 `git -C {WORKTREE} worktree add` 临时检出或 stash 切换实现；未入库时核实 PR 对验证测试方式与结果的说明）、CI 与 PR 描述真实性。输出：**结论 PASS/FAIL** + 关键问题列表（file:line + 失败场景 + 修复建议；只有功能错误/回归/竞态/数据丢失/测试无效才算关键）+ 非关键建议 + 已验证项清单。
2. **把 review 结果作为 comment 发布到 PR**：`gh pr comment {PR号} --repo Science-Discovery/Aether --body-file <文件>`（FAIL 的也要发；这是公开审计记录，不能省）。
3. **FAIL**：自己在同一 worktree 返工——逐条修复关键问题（附 review 的 file:line 与建议）、补上对应测试（验证测试必补；review 指出需长期保护时补入库回归测试）、push 到同一 PR、CI 到绿；然后回到第 1 步重新派 review，循环直到 PASS。
4. **PASS**：非关键建议自行决定修不修（修了更好，不修也算完成）；之后进入最终汇报。

## 边界

- 只修本任务，不要顺手修其他问题；不要修改参考报告文件本身；不要改动主工作区与其他 worktree 的文件。
- {同文件相邻区域的其他并行任务提示（如有）：改动尽量局部化，PR 中注明可能冲突区域。}
- 最终汇报：issue 链接、PR 链接、分支名、改动摘要、测试清单与结果、CI 状态、review 结论（PASS 与轮数）、PR comment 链接、历史修复考古结论（有无过往修复尝试、bug 为何仍存在）。

## 任务原文

{报告条目原文}
