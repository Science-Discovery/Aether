---
name: aether-issue-pr
description: 用于处理 Science-Discovery/Aether 协作提交；当用户请求创建 issue/PR、恢复既有 PR、监控修复 CI、审查 cicd-guard 失败或评价受保护路径改动时使用。开 PR 前必须先确定关联 issue：用户给定或本任务已建则复用，都没有则先按模板自动创建；禁止无 issue 的 PR。
---

# 协作提交流程

## 确认范围

- 默认仓库 `Science-Discovery/Aether`，默认 base 为 `dev`；GitHub 操作统一用 `gh`，显式指定 `--repo Science-Discovery/Aether`。
- 普通 issue/PR 按模板直接创建，不等待草稿确认，除非用户要求预览或 draft；仅提 issue 不自动扩展为提交代码或开 PR。
- PR 必须关联真实存在的 issue：先复用用户指定或本任务已建的 issue，均无时先创建 issue 再开 PR。
- 用户指定 `beta`、`main` 等敏感目标时，先提醒风险并等待确认，确认前不为该目标推送或创建 PR。
- 提交、推送及后续修复须符合用户授权和环境权限；只写文档、只调研、禁止提交等限制优先于自动执行流程。

---

## 核实状态

1. 读取适用目录指令，用 `git status --short`、`git remote -v`、`git branch -vv` 确认工作区、远端、当前分支及跟踪关系。
2. 查看 `git diff`、`git diff --cached` 并读取未跟踪文件，记录既有改动；更新相关远端引用后查看 `git log <base>..HEAD`、`git diff <base>...HEAD`，核验全部提交及完整差异，不只看最后一次提交或文件名。
3. 查当前任务记录、用户指定 issue 和已有 PR 的明确关联；用 `gh pr list --state open --head <head> --base <base>` 查重，再用 `gh pr view <number>` 核实 head 仓库、分支、base、正文和关联 issue。
4. 恢复任务时复用已确认属于本任务的 issue/PR；不可仅凭主题相似关联，跨 fork 的同名 head 也不是同一分支。
5. 默认只纳入当前任务改动，包括已提交历史；若混有无关修改或提交，从正确 base 整理专用分支或 worktree，只迁移已确认的任务差异，并重新核验完整 diff。

保留用户工作区、暂存内容及既有历史，不擅自 reset、清理或覆盖；混合文件按差异隔离，无法安全区分时说明阻塞并询问。
检查新增内容不含密钥、凭据等秘密，避免整库暂存或夹带既有提交。

---

## 复用或创建

1. 用户给定 issue 时核实并复用；否则复用本任务已明确关联的 issue；两者皆无时必须先用 `gh issue create` 创建 issue 并关联后才能开 PR，不按相似标题选单。
2. 读取仓库实际 `.github/ISSUE_TEMPLATE/` 和适用 PR 模板，按任务类型填写真实字段与必填项，不硬编码旧模板；本地缺失或过时时用 `gh` 核对目标仓库版本。
3. 用 `gh issue create` 创建缺少的 issue，记录返回编号和链接；请求超时或结果不明时先查询是否已创建，再决定重试，PR 同理。
4. PR 正文描述需求、完整改动和实际验证；默认以 `Closes #<number>` 关联本次复用或创建的 issue，`Refs #<number>` 仅用于已存在 issue 上的部分工作，不得以 Refs 或省略关联替代新建 issue；未运行检查和不适用项如实标注。
5. 对授权范围内的改动运行适用检查，只暂存确认过的任务差异，复核暂存区后按仓库规范提交；推送前再次检查 `<base>...HEAD` 全部差异及提交。
6. 确认推送目的仓库和 head 分支后普通推送；非快进拒绝先分析分歧，不自动 force push、改写共享历史或绕过 hooks。
7. 推送后再次查重：已有本任务 PR 则更新，否则用 `gh pr create --base <base> --head <head>` 创建；fork head 使用正确的 owner 限定，记录 PR、head SHA 和 base SHA。

---

## 分类处理失败

- 保留命令、退出码和脱敏错误证据，区分网络/DNS/代理、认证、仓库权限、环境限制和 Git 锁；单次 `gh auth status` 失败不等于未登录。
- 仅在证据指向环境限制、工具支持且环境规则允许时申请相应权限；认证问题核实凭据，授权问题交由权限持有人处理，不默认提权。
- 锁失败先查占用进程、并发操作和目录权限，不盲删锁；瞬时网络错误可有限重试，持续失败报告原因与下一步。

---

## 审查门禁

先区分路径策略命中与脚本/API 错误，不把所有 `cicd-guard` 失败都当政策拦截。
不得仅为变绿禁用 guard、跳过测试、放宽断言/阈值、吞掉错误、删除合理回归测试、把修改藏到未保护路径或修改白名单/保护名单。

1. 用 `gh run view <run-id> --log-failed` 获取实际 guard run 日志，必要时用 `gh run view <run-id> --log` 读完整日志，不以机器人评论代替日志；记录 run/attempt、事件类型、事件 base SHA 与来源 head，以及当前 PR head SHA 和 base 分支/SHA，GraphQL EOF 可用 `gh api` REST 回退。
2. 从该 run 的事件 base SHA 读取 `.github/workflows/cicd-guard.yml`、`.github/cicd-admins.txt` 和 `.github/cicd-protected-files.txt`，不要用当前工作区或最新 base 代替；可对每个路径执行 `gh api "repos/Science-Discovery/Aether/contents/<path>?ref=<event-base-sha>" -H "Accept: application/vnd.github.raw+json"`。
3. 每次核对 workflow 的触发事件、目标分支、checkout ref、配置来源及实际执行逻辑；当前实现由 `pull_request_target` 的 `opened/reopened/synchronize/ready_for_review` 对 `main/beta/dev` 触发，checkout 事件 `base.sha` 读取两份名单，逻辑内嵌 `github-script`。若实际版本改变，沿真实引用读取脚本或配置并以实际实现为准，不猜测不存在的仓库脚本、批准命令或放行机制。
4. 按实际代码逐项核对作者与路径：当前豁免只看 PR 作者 `pr.user.login` 是否在白名单，不看 reviewer、重跑者或管理员角色；否则分页 `pulls.listFiles`，对 `filename` 和 `previous_filename` 精确匹配保护名单。检查新增、修改、删除及重命名的新旧路径，范围包含普通单测/E2E，不仅是 workflow，不擅自按 glob 或目录前缀解释名单。
5. 分别记录路径策略与质量检查结果：当前 guard 不执行测试、不评估内容合理性，正常通过条件是作者白名单或 PR 不再命中保护路径；测试和 typecheck 通过可以与路径策略失败并存，不能互相替代。
6. 核实放行机制再提出下一步：当前实现无批准评论、标签、SHA 授权或 TTL 机制，评论批准、Approve review、fork workflow approval 和管理员重跑均不等于 guard 放行；若版本发生变化，仅按已核实实现解释其效果。

---

## 评价改动

1. 核对当前 head/base 后审阅 `git diff <base>...<head>` 完整 PR 差异及关联 fixture/setup、helper、脚本和测试配置，追踪原约束与调用，不限于命中文件、最新 commit 或评论。
2. 对比修改前后的输入、初始化状态、执行分支与失败条件；fixture/setup/helper 即使不改断言，也能改变实际覆盖或使回归场景消失。用具体场景和实际验证证明原有保障仍有效，不能以断言未变或测试通过证明安全。
3. 逐项区分**必要语义更新**与**仅为绕过失败的修改**：必要更新须有需求依据、原约束问题、修改必要性、保留或替代保障及实际验证，不以“新实现过不了旧检查”为理由；仅绕过检查的修改须撤回，修复实现或根因并恢复有效验证。
4. 对混合变更分别列出应保留、应撤回和待裁定部分，不整包认可或否决；证据不足时列明缺口和补充验证，交维护者裁定。确需降低保障时披露损失、替代措施和残余风险，不自行放行。
5. 在授权范围内用 `gh pr comment <number> --body <review>` 发布必要改动的证据评价并记录评论链接，请维护者决定符合政策的集成方式；不承诺审查批准后重跑会绿，必要修复仍推送同一 PR 并重新检查。

用紧凑列表或表格保留以下人工评价字段：

- **范围**：PR、head SHA、base 分支与 base SHA。
- **逐项证据**：需求依据、原约束问题、修改必要性、文件行或 diff 链接及相关日志链接。
- **验证与影响**：实际执行结果、保留/替代的质量安全覆盖、影响与残余风险。
- **结论**：各项保留/撤回/待裁定、理由及维护者待办；交付时附审查评论链接。

后续 head/base 相关变化须更新审查并标明新 SHA；评论绑定 SHA 仅作可追溯记录，不是 guard 授权机制，也不等于批准或通过。

---

## 跟踪结果

1. 除非用户明确不需要，创建或恢复 PR 后主动用 `gh pr checks <number>`、`gh pr view <number> --json headRefOid,baseRefName,statusCheckRollup` 跟踪，并核对 run 的事件与来源 head（合并测试核对来源 head，`pull_request_target` 核对事件 base 与实际被检 PR）。
2. 最新 head 有新提交就重新确认检查，不用旧 head 的绿灯作结论；失败读取日志、定位并修复，在授权范围内提交推送原 PR，guard 按上节处理。
3. 只有瞬时故障证据或已修复原因才有限重跑，记录原因、次数和结果；按运行耗时设置有限观察窗口，合理间隔查询，不无限等待或反复刷绿。
   核对重跑使用的事件与配置：当前 guard 重跑旧 run 沿用原事件 base 配置，却查询当前 PR 文件列表；不得凭旧 run 绿灯证明最新 head 已通过，也不得假定重跑会加载更新后的 base 配置，版本变化时重新核实。
4. 排队、基础设施故障、人工批准等阻塞，经合理观察后报告状态、原因、run/检查链接、责任方和下一步；必要时等待管理员，不扩大权限或绕过质量门禁。
5. 声称外部或已有失败须附 base/历史运行、日志等对照证据；归因不代表解决，证据不足标为未定，跳过/取消/未运行也不能冒充通过。
6. guard 标红不一定是 required 合并阻塞项，须查询目标分支的 branch protection、适用 rulesets/effective rules，核对 required 检查名称、来源与对应结果；无权限则明示未知，不凭 `mergeable_state: blocked` 认定 guard 是阻塞原因，也不把非 required 失败描述成已通过。

---

## 汇总交付

用一份简短汇报给出 issue/PR 链接、branch/head SHA、目标 base 和真实检查状态；仅做 issue 时省略不适用项，不强制分两阶段。
适用时附 guard 逐项结论、审查评论链接、未解决原因及待办责任方；未执行、待批准、待复查须明示，不伪造测试、批准或成功状态。

---

## 硬性禁止

- 禁止在未创建或未关联真实 issue 的情况下创建 PR。
- 禁止虚构 issue 编号或假装已完成关联。
