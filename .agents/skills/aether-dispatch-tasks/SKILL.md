---
name: aether-dispatch-tasks
description: 在 Aether (aether-dev) 中把多个独立任务派发到现有 worktree 沙箱（sandbox/多工作区/multi-worktree/并行会话/parallel agents）并行执行并管理其全生命周期：派发任务书（含分支/测试/提交规范）、监控完成状态、派 subagent 逐个 review、review 结果作为 comment 发布到 GitHub PR、FAIL 返工循环到 PASS 放行。当用户提到把任务分配/派发给沙箱、sandbox、工作区、worktree 或多个会话/agents 并行执行时使用。
---

# 多沙箱任务派发与监控

## 适用前提

- 有一批**相互独立**的任务（如 bug 修复列表），每任务一个沙箱（worktree）。
- 沙箱必须**已存在**（`git worktree list` 确认）；本 skill 不新建 worktree。注意：沙箱目录上挂的分支名可能是旧任务残留，以任务书指定的**新分支**为准（从 `origin/dev` 切）。
- 用户希望每个沙箱是一个可跟踪的"会话"——通过本地 server API 在沙箱目录下创建会话并 `prompt_async` 派发，与用户手动新建会话完全同构。

## 派发

1. `git worktree list` 确认沙箱清单；`git fetch origin dev` 确认基线。
2. 写派发脚本（见 `scripts/dispatch.py`，可按任务改 `TASKS` 表）：
   - 在每个沙箱目录下 `POST /session?directory=<worktree>` 建会话，body 同时带 title 与 **permission 规则集（默认继承派发 agent 的权限，见下）**。
   - `POST /session/<id>/prompt_async?directory=<worktree>` 派发任务书，立即返回 204，全部并行不阻塞；body 可带可选的 `model` 指定模型。
   - 落盘 session↔sandbox↔任务 映射 JSON（供监控与后续回话用）。
3. **权限与模型**（派发时设定）：
   - **权限**：建会话 body 的 `permission` 是规则数组 `[{permission: "<工具名>", pattern: "*", action: "allow"}]`（工具名如 bash/edit/write/webfetch，pattern 可限定命令/路径）。**默认继承当前派发任务的 agent 的权限**：先 `GET /session/<当前sessionID>` 读出本会话的 `permission` 字段，原样传入新建会话的 body——沙箱 agent 获得与派发者一致的操作面。若派发者无显式规则集，则给出最小 allow 集（至少 bash/edit/write），否则 headless 会话会卡在默认 `ask` 上无人应答。注意：worktree 只隔离 git 历史，不隔离文件系统——`pattern: "*"` 的 allow 不限制路径，安全性取决于对 agent 的信任而非目录边界，需收紧时用 pattern 限定命令/路径。
   - **模型**：`prompt_async` body 可带 `"model": {"providerID": "...", "modelID": "..."}` 指定该沙箱用的模型；**默认不传（用当前会话/项目默认模型）**，需要分模型跑任务时才设。
4. 任务书必须包含（模板见 `references/task-prompt.md`）：
   - 目标 + 参考报告路径；准备步骤（fetch origin/dev → `git checkout -b <branch> origin/dev`；fetch 遇 ref lock 等 2 秒重试最多 3 次）。
   - 先读码确认问题在当前基线仍存在；不存在则停下汇报，不开 issue/PR。
   - 修复要求：优雅、健壮、最小侵入，遵循仓库 AGENTS.md 风格。
   - 测试要求：为失败场景写回归测试；bun test 从 package 目录跑（禁从仓库根）；Solid 响应式单测用 `*.vitest.ts`；bun typecheck 通过；需要时可用 Playwright e2e。
   - 提交流程：按 aether-issue-pr skill——**若无 issue 就先建 issue 再开 PR**（复用已有 issue 则直接开），base=dev，`Closes #N`，跟踪 CI 到绿。
   - 边界：只修自己的任务，不顺手修别的；最终汇报 issue/PR/分支/改动/测试/CI。
   - 同文件相邻区域的多任务要互相注明冲突风险。
5. 派发后抽查 status 确认全部 busy。

## 监控

- 轮询 `GET /session/status?directory=<worktree>`：`{"ses_xxx":{"type":"busy"}}`。busy=在跑；session 从 status 消失=完成。
- 完成后读最终汇报：`GET /session/<id>/message?directory=<worktree>`，确认产出（issue/PR/CI 状态）再进入 review。

## Review（必须派 subagent，禁止主 agent 自己审）

每个完成的任务派一个独立 review subagent（`task` 工具，general 类型），任务书要点：

- 只读审查：禁止修改文件、禁止提交。
- 给出 worktree 路径、分支、head SHA、PR/issue 链接、bug 原文。
- 审查清单：完整 diff（含测试/fixture）；修复语义与竞态推演；回归风险（非目标路径行为不变）；测试判别力（**实测**：基线代码上失败、修复后通过）；CI 与 PR 描述真实性。
- 输出格式：**结论 PASS/FAIL** + 关键问题列表（file:line + 失败场景 + 修复建议；只有功能错误/回归/竞态/数据丢失/测试无效才算关键）+ 非关键建议 + 已验证项清单。

**每份 review 结果必须作为 comment 发布到对应 GitHub PR**（`gh pr comment <N> --repo Science-Discovery/Aether --body-file <file>`），FAIL 的也要发（PR 上保留完整 review 历史）。

## FAIL 返工与 PASS 放行

- **FAIL**：把关键问题转达给该沙箱 agent 返工。消息必须发到**当初解决问题的原始会话**（`prompt_async` 到原 session ID），**不要新开会话**；附 review 评论链接、逐条问题定位与修复建议、回归测试要求、push 同一 PR、CI 到绿。返工完成后派新 subagent 复审，仍有关键问题继续循环，**直到 PASS 才放行**。
- **PASS**：放行。同时把 review 结果（含非关键建议）发回**原始会话**（同样不开新会话），由该 agent 自行决定是否处理非关键建议；修不修都接受。此后**不再监控该任务**。

## 本地 server API 关键命令（Windows 实测）

```
# 0. 定位本实例 server（端口每次可能变）：
netstat -ano | grep "$OPENCODE_PID"        # 找 LISTENING 端口
# 认证：Basic auth，用户 opencode，密码取环境变量 OPENCODE_SERVER_PASSWORD

# 1. 建会话：POST /session?directory=<URL编码的worktree路径>
#            body {"title":"...", "permission":[<派发agent会话的permission规则，原样继承>]}
#            （先 GET /session/<当前sessionID> 读自己的 permission 再传入；
#              派发者无规则集时至少给 bash/edit/write allow，否则 headless 卡在权限询问）
# 2. 派任务：POST /session/<sessionID>/prompt_async?directory=<同上>
#            body {"parts":[{"type":"text","text":"<完整任务书>"}],
#                  "model":{"providerID":"<可选>","modelID":"<可选>"}}   # model 不传=当前默认模型
# 3. 监控：  GET /session/status?directory=<同上>            → {"ses_xxx":{"type":"busy"}}
# 4. 读汇报：GET /session/<sessionID>/message?directory=<同上>
```

**踩坑记录（Windows）**：

- python 处理含中文的 JSON/文件必须 `-X utf8`（默认 GBK 解码失败）。
- API 长响应先落盘文件再解析（长响应走 stdout 管道会被截断）。
- 消息接口是单数 `message`；`messages` 会命中前端路由返回 HTML。
- URL 参数 `directory` 要对 worktree 完整路径做 quote（safe=""）。
- 多沙箱并行时 CI runner 资源紧张，重载测试（如 packages/opencode 的 30s 超时类）偶发 flaky：先对照 dev 基线 run 判断是否环境性，是则单次有限重跑并记录原因，不算回归。
- 共享 worktree 上可能残留其他沙箱实验的未提交改动：review 以已推送的 HEAD 提交为准；返工前让 agent 确认基线是自己的 PR head。
