---
name: aether-dispatch-tasks
description: 在 Aether (aether-dev) 中执行开发任务（修复 bug/漏洞/缺陷、实现/添加功能等）并管理全生命周期（修复+测试+issue+PR+review 闭环）。两种模式按用户措辞判定：用户强调"分配/派发"任务（到沙箱/工作区/多会话/并行 agents）→ 多沙箱模式（主 agent 在主工作区建子会话，每任务一个 worktree，全自治修复+review，主 agent 看门监控）；用户未强调分配派发 → 当前会话模式（不创建子会话、不创建沙箱，在当前会话直接完成同一套标准，含 subagent review 与返工决策）。当用户提到把任务分配/派发给沙箱、sandbox、工作区、worktree、多个会话/agents 并行执行，或要求修复 bug/漏洞、实现/添加功能等开发任务时使用。
---

# 开发任务派发与执行

## 模式判定（先于一切）

- 用户明确要求**分配/派发**任务（提到派给沙箱、工作区、worktree、多个会话/agents 并行）→ **多沙箱模式**：走下文全流程（建子会话 + 分配 worktree + 看门监控）。
- 用户只要求**修复 bug/漏洞/缺陷、实现/添加功能**等开发任务，**未强调分配派发** → **当前会话模式**：不创建子会话、不创建任何新会话、不创建沙箱/worktree，就在当前会话直接完成；其余标准与多沙箱模式完全一致（见下一节）。

## 当前会话模式（未要求派发时的默认路径）

不开子会话、不建沙箱/worktree、无看门监控；在当前会话、当前仓库工作区直接执行，质量标准与多沙箱模式一致：

1. `git fetch origin dev` → `git checkout -b <branch> origin/dev` 在当前工作区切新分支（无 worktree，任务书里的 `git -C` / worktree 路径约定不适用）。
2. 沿用 `references/task-prompt.md` 的全部标准节（把"分配的 worktree"换成当前工作区）：准备步骤含**历史修复考古**；修复要求含**边界条件专项检查**；测试要求两层（验证测试必须、入库回归测试按需）；提交与 PR 走 aether-issue-pr skill（禁止无 issue 的 PR，CI 跟踪到绿）。
3. **review 闭环在当前会话内**：派 `task` subagent（general 类型，只读审查）review PR 代码 → 结果回传当前会话，**由当前会话做进一步决策** → review 结果必须发 PR comment（FAIL 也要发，公开审计）→ FAIL 则自己在当前会话返工（同一分支 push 同一 PR、CI 到绿）再派新 subagent 复审，循环到 PASS。subagent 阻塞当前会话没有关系——单任务没有可并行的工作。
4. 完成后向用户最终汇报：issue/PR/分支/改动摘要/测试/CI/review 结论（PASS 与轮数）/考古结论。

`scripts/dispatch.py`、`status.py`、`send-to-session.py` 与看门监控均不适用（没有子会话可监控）。

## 架构总览（多沙箱模式）

```
主 agent（主工作区）
 ├─ 准备 worktree：已存在且干净→复用；被占用/不存在→git worktree add
 ├─ 在主工作区 directory 下建 N 个子会话，每会话派发一个任务书（prompt_async，不阻塞）
 └─ 看门监控：周期轮询子会话是否在工作（busy=正常）
     ├─ 停止工作且任务未完成 → prompt_async 发续跑指令到该子会话，留在监控中
     └─ 任务完成 → 读最终汇报确认放行，移出监控

子会话 i（directory=主工作区，全自治）
 ├─ 在分配的 worktree 里：fetch → checkout -b → 修复 → 测试验证 → issue+PR → CI 到绿
 ├─ 派 subagent review 自己的 PR（阻塞的只是子会话自己，主 agent 不受影响）
 ├─ review 结果发 PR comment（必发，公开审计）
 ├─ FAIL → 自己返工（同一会话、同一 worktree）→ 复审循环，直到 PASS
 └─ PASS → 发最终汇报，会话结束
```

关键设计（多沙箱模式）：**不要用 `task` 工具在主 agent 层派 review subagent**（结果必须回传主 agent，只要有一个 subagent 在跑主 agent 就繁忙被阻塞）；也**不要为任务单独建 worktree 会话**。子会话统一建在主工作区，agent 用 bash 在 worktree 目录干活；review 放在子会话内部，阻塞的只有子会话自己——主 agent 始终空闲，可持续看门。（当前会话模式相反：review 就是用 `task` 工具在当前会话派，阻塞无妨。）偶发停止（模型中断、SSE 断连等）由看门循环兜底：不信任"会话从 status 消失=完成"，消失后必须读最终汇报核实。

## 多沙箱模式适用前提

- 用户要求把任务**分配/派发**出去，且有一批**相互独立**的任务（如 bug 修复列表），每任务一个子会话 + 一个 worktree。**即使只有一个任务，也完整走本流程**（建 1 个子会话 + 1 个 worktree、review 闭环、看门监控一样不少）——流程不为任务数量裁剪，保证质量门禁一致。
- worktree 优先**复用已有的**（`git worktree list`）；被占用（有未提交改动）或不够时**新建**（见下）。沙箱目录上挂的分支名可能是旧任务残留，以任务书指定的**新分支**为准（从 `origin/dev` 切）。
- 用户希望每个任务是一个可跟踪的"会话"（侧边栏可见、可随时点进去看进度）。

## 派发

1. `git worktree list` 确认现有沙箱清单；`git fetch origin dev` 确认基线。
2. **分配 worktree**（每任务一个，路径记入任务书）：
   - 复用判定：`git -C <worktree> status --porcelain` 为空（干净）→ 复用，无论当前挂的分支是什么（子会话会自己 `checkout -b`）。
   - 不干净或数量不够 → 新建：`git worktree add --detach <worktree父目录>/sandbox-N origin/dev`（**N 从现有 `git worktree list` 中 sandbox 前缀的最大编号 +1 顺延**，不重号；`--detach` 不占分支名，子会话再 checkout -b）。**用 `git worktree add`，禁止走 Aether 的 Worktree.create API**（连续创建会触发 watcher.node Bun segfault 闪退；外部 git worktree add 由 WorktreeDiscover 5s 轮询自动注册进侧边栏，是安全路径）。
3. 写派发脚本（见 `scripts/dispatch.py`，可按任务改 `TASKS` 表）：
   - 全部子会话 `POST /session?directory=<URL编码的主工作区路径>` 建会话，body 带 title + **permission 规则集**。
   - `POST /session/<id>/prompt_async?directory=<同主工作区>` 派发任务书（含分配的 worktree 路径），立即返回 204，全部并行不阻塞；body 可带可选 `model`。
   - 落盘 task↔session↔worktree 映射 JSON（供监控与异常介入用）。
4. **权限与模型**（派发时设定；默认继承，可按任务覆盖）：
   - **权限**：`permission` 是规则数组 `[{permission: "<工具名>", pattern: "*", action: "allow"}]`。**默认继承当前派发 agent 的会话权限**：先 `GET /session/<当前sessionID>` 读出本会话 `permission` 字段，原样传入新会话 body（子会话获得与派发者一致的操作面；注意 worktree 只隔离 git 历史不隔离文件系统，`pattern: "*"` 的 allow 不限制路径，安全性取决于对 agent 的信任）。派发者无显式规则集时给最小 allow 集（bash/edit/write），否则 headless 会话卡在默认 `ask` 上无人应答。可按任务收紧/覆盖，如 edit/write 的 pattern 限定为 `<worktree>/**` 防止文件工具误改主工作区（但 bash `*` 全开时这只是防手滑，不是安全边界）。
   - **模型**：`prompt_async` body 可带 `"model": {"providerID": "...", "modelID": "..."}`；**默认不传（子会话用当前默认模型）**，需要分模型跑任务时才按任务指定（派发脚本中 per-task MODEL，见 `scripts/dispatch.py` 的 TASKS 表）。
5. 任务书必须包含（模板见 `references/task-prompt.md`）：
   - 目标 + 参考报告路径 + **分配的 worktree 路径与工作目录约定**。
   - 准备步骤（fetch origin/dev → `git checkout -b <branch> origin/dev`；fetch 遇 ref lock 等 2 秒重试最多 3 次）。
   - 先读码确认问题在当前基线仍存在；不存在则停下汇报，不开 issue/PR。
   - **历史修复考古**（修 bug/功能类任务必做）：查 GitHub closed issue/PR 与 `git log -S` 历史修复提交；发现修过但 bug 仍在时，必须弄清"为什么没修好/为何复现"（补丁被绕过/覆盖窗口不同/后续改动破坏），结论写进 issue 与 PR——复现类 bug 优先从"上次为何没修住"找根因（见模板准备步骤第 4 条）。
   - 修复要求：优雅、健壮、最小侵入，遵循仓库 AGENTS.md 风格；**边界条件专项检查**（概念+枚举清单都要传给子会话，枚举仅是起点须按功能语义自行补全，见模板"修复要求"）。
   - 测试要求分两层：验证本次修改正确的临时测试（**必须**，工作验证手段，不必入库）+ 放入仓库保护相关功能的回归测试（**按需**自行决定，易复发/修复过又复现/竞态类建议入库，见模板"测试要求"）；bun test 从 package 目录跑（禁从仓库根）；Solid 响应式单测用 `*.vitest.ts`；bun typecheck 通过；需要时可用 Playwright e2e（多沙箱并行跑 e2e 的注意事项见踩坑记录）。
   - 提交流程：按 aether-issue-pr skill——**若无 issue 就先建 issue 再开 PR**，base=dev，`Closes #N`，跟踪 CI 到绿。
   - **review 自治闭环**（完成后在本会话内自行执行，见模板）：派 subagent review → 结果发 PR comment → FAIL 自返工循环 → PASS 才结束会话。
   - 边界：只修自己的任务，不顺手修别的；最终汇报 issue/PR/分支/改动/测试/CI/review 结论。
   - 同文件相邻区域的多任务要互相注明冲突风险。
6. 派发后抽查 status 确认全部 busy。

## 看门监控（主 agent 持续职责，直到所有任务完成）

主 agent 派发完不结束，周期性执行看门循环（间隔建议几分钟级，避免打爆 server）：

1. `GET /session/status?directory=<主工作区>`：一次返回所有子会话状态，形如 `{"ses_xxx":{"type":"busy"}}`。
2. **busy = 在正常工作**，跳过。
3. **session 不在 status 里（停止工作）**：**不能直接当完成**——读最终汇报 `GET /session/<id>/message?directory=<主工作区>` 核实：
   - 汇报中任务已完成（issue/PR/CI/review PASS 齐备）→ 放行，**移出监控，此后不再过问**。
   - 任务未完成（没有最终汇报，或汇报显示中断/半途而废）→ `prompt_async` 发续跑指令到该子会话（`scripts/send-to-session.py`：提醒其继续当前任务、从头绪处续跑、完成完整闭环后才结束），留在监控中，下轮继续看门。偶发停止（模型中断、网络断连等）靠这个循环兜底恢复。
   - 疑似卡死（busy 挂很久无产出，或续跑多轮仍停在同一处）→ 读 message 时间线定位卡点再决定介入方式；正常流程不要干预 review/返工循环——那是子会话自己的职责。
4. 全部子会话都放行后，看门结束，派发任务整体收官（向用户总结各任务 PR/issue/review 结果）。

监控期间主 agent 保持空闲可响应：子会话的 review subagent 只阻塞子会话自己，主 agent 不派任何 `task` subagent。子会话的 busy 状态全部显示在主工作区（会话属于主工作区 directory），worktree 沙箱行不会显示 busy——这是预期行为，不要误判为"沙箱没在干活"。

## 子会话内的 review（模板 `references/task-prompt.md` 已含）

子会话完成任务后**必须在本会话内闭环 review，不得跳过、不得把 review 交回主 agent**：

- 派 `task` subagent（general 类型）review 自己的 PR——只读审查，禁止改文件/提交。阻塞的只是子会话自己，主 agent 不受影响。
- 审查清单：完整 diff（含测试/fixture）；修复语义与竞态推演；回归风险；测试判别力（**实测**：仓库内测试在基线代码上失败、修复后通过；未入库时核实验证测试的说明）；CI 与 PR 描述真实性。
- 结论 PASS/FAIL；关键问题=功能错误/回归/竞态/数据丢失/测试无效（file:line + 失败场景 + 修复建议）。
- **review 结果必须作为 comment 发布到对应 GitHub PR**（`gh pr comment <N> --repo Science-Discovery/Aether --body-file <file>`），FAIL 的也要发（公开审计，PR 上保留完整 review 历史）。
- **FAIL**：子会话自己在同一 worktree 返工（附 PR 评论链接、逐条定位修复、补对应测试——验证测试必补、按需补入库回归测试、push 同一 PR、CI 到绿），再派新 subagent 复审，循环到 PASS。
- **PASS**：非关键建议自行决定修不修（都接受），发最终汇报，结束会话。

## 本地 server API 关键命令（Windows 实测）

```
# 0. 定位本实例 server（端口每次可能变）：
netstat -ano | grep "$OPENCODE_PID"        # 找 LISTENING 端口
# 认证：Basic auth，用户 opencode，密码取环境变量 OPENCODE_SERVER_PASSWORD

# 1. 建子会话：POST /session?directory=<URL编码的主工作区路径>
#              body {"title":"...", "permission":[<派发agent会话的permission规则，原样继承>]}
#              （先 GET /session/<当前sessionID> 读自己的 permission 再传入；
#                派发者无规则集时至少给 bash/edit/write allow，否则 headless 卡在权限询问）
# 2. 派任务：  POST /session/<sessionID>/prompt_async?directory=<同主工作区>
#              body {"parts":[{"type":"text","text":"<完整任务书>"}],
#                    "model":{"providerID":"<可选>","modelID":"<可选>"}}   # model 不传=当前默认模型
# 3. 看门监控：GET /session/status?directory=<同主工作区> → {"ses_xxx":{"type":"busy"}}（全部子会话一次可见；
#              不在 status=停止工作：读 message 核实，未完成→发续跑指令（send-to-session.py），完成→移出监控）
# 4. 读汇报：  GET /session/<sessionID>/message?directory=<同主工作区>
# 5. 介入：    POST /session/<sessionID>/prompt_async?directory=<同主工作区>（scripts/send-to-session.py，续跑/叫停）
```

**踩坑记录（Windows）**：

- python 处理含中文的 JSON/文件必须 `-X utf8`（默认 GBK 解码失败）。
- API 长响应先落盘文件再解析（长响应走 stdout 管道会被截断）。
- 消息接口是单数 `message`；`messages` 会命中前端路由返回 HTML。
- URL 参数 `directory` 要对完整路径做 quote（safe=""）。
- 多沙箱并行时 CI runner 资源紧张，重载测试（如 packages/opencode 的 30s 超时类）偶发 flaky：先对照 dev 基线 run 判断是否环境性，是则单次有限重跑并记录原因，不算回归。
- 共享 worktree 上可能残留其他沙箱实验的未提交改动：分配时用 `git -C <worktree> status --porcelain` 检查，不干净就换/新建；review 以已推送的 HEAD 提交为准；返工前让 agent 确认基线是自己的 PR head。
- 新建 worktree 用 `git worktree add --detach <path> origin/dev`，编号取 `git worktree list` 中 sandbox 前缀最大编号 +1（不重号）；**不要**用 Aether 的 Worktree.create/UI 创建（连续创建触发 watcher.node segfault 闪退）。
- 子会话的 bash 默认 cwd 是主工作区：任务书必须明确"所有 git 用 `git -C <worktree>`、文件操作用 worktree 绝对路径"，防止误改主工作区。
- 多沙箱并行跑 Playwright e2e：端口与数据沙箱本就按 run 隔离（freePort 动态端口、mkdtemp+XDG\_\* 沙箱、脚本 LLM 绑 port 0），但 ① `freePort()` 探测到真正 bind 之间有竞态窗口，本地 `reuseExistingServer=true` 会静默复用别的 run 起的服务——测试跑到别人 worktree 的代码上；② **禁止设置 `PLAYWRIGHT_SERVER_HOST`**（未配 PORT 时后端端口被硬编码为 4096，并行必串台）；③ 并行 vite 冷启动与 Windows 沙箱清理有资源挤兑/已知 flaky 面——e2e 失败先对照 dev 基线判断是否环境性（端口竞态/资源挤兑），单次有限重跑并记录，不要直接当回归修（风险点详见 issue：并行 e2e 隔离加固）。
