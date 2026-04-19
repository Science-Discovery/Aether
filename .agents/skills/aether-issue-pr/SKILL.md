---
name: aether-issue-pr
description: 面向 Science-Discovery/Aether 仓库的 issue 与 PR 工作流。用户要求“提 issue”“创建 issue”“开 PR”“提交 PR”“用 gh 发 issue/PR”“往 Aether 仓库提单并发 PR”时触发。先询问用户是否已有 issue 并要求提供编号；若没有，则先按仓库模板起草 issue，待用户确认后创建；随后再按 PR 模板起草、确认并提交 PR。
---

# Aether Issue And PR Flow

适用于 `Science-Discovery/Aether` 仓库的 GitHub issue 与 PR 操作。

## 核心规则

- 默认目标仓库始终是 `Science-Discovery/Aether`。
- 在做 PR 之前，先向用户询问确认是否已有 issue。
- 如果用户说 issue 已存在，必须要求其提供 issue 编号。
- 如果不存在 issue，先根据仓库模板、当前会话以及用户要求起草 issue，等待用户确认后再发布。
- PR 也必须先按模板起草，等待用户确认后再正式提交。
- 不要跳过模板，也不要在未确认前直接发布 issue 或 PR。
- 凡是涉及 `gh` 认证校验、`gh api`、`gh issue create`、`gh pr create`、`git push` 这类依赖 GitHub 网络或写入 `.git` 的步骤，不要先根据沙箱内失败结果认定为“用户未登录”或“命令本身失败”。
- 若沙箱内出现 `gh auth status` 失败、GitHub API 失败、`.git/index.lock` 无法写入、网络受限等情况，应优先立即用提权方式重试并复核；只有在提权后仍失败，才能把问题归因到用户认证或真实命令错误。

## Issue 流程

### 1. 先确认 issue 状态

先直接问用户：

- 是否已经存在 issue
- 如果已存在，请提供 issue 编号

如果用户未提供编号，不要自行猜测，也不要直接继续创建 PR。

### 2. 若不存在 issue

按下面顺序执行：

1. 读取 `.github/ISSUE_TEMPLATE/` 下的模板。
2. 根据任务性质选择最合适的模板，通常是：
   - 功能或重构类：`feature-request.yml`
   - 缺陷修复类：`bug-report.yml`
   - 单纯提问：`question.yml`
3. 严格依据模板字段草拟 issue 标题与正文。
4. 先把草稿发给用户确认。
5. 用户确认后，再用本地 `gh` 在 `Science-Discovery/Aether` 创建 issue。
6. 创建完成后，记录并回报：
   - issue 编号
   - issue 链接

补充注意：

- 若 `gh auth status` 在沙箱内失败，不要直接要求用户重新登录；先用提权命令检查一次，因为沙箱网络限制可能导致假阴性。
- 创建 issue 时，默认直接使用提权方式执行 `gh issue create`，避免重复卡在沙箱网络问题上。

## PR 流程

### 1. 起草前检查

在准备 PR 前：

1. 读取 `.github/pull_request_template.md`。
2. 确认本次 PR 对应的 issue 编号。
3. 检查当前改动范围，避免混入明显无关的文件；如果用户明确要求“全部提交”，则按用户要求执行。（需要询问）
4. 形成规范的 commit message，优先使用 Conventional Commits 风格，如：
   - `fix: ...`
   - `feat: ...`
   - `refactor: ...`
   - `docs: ...`

### 2. 起草 PR 内容

PR 草稿必须遵循仓库模板，至少包含：

- `Issue for this PR`
- `Type of change`
- `What does this PR do?`
- `How did you verify your code works?`
- `Screenshots / recordings`
- `Checklist`

规则：

- 若已有 issue 编号，优先写 `Closes #<编号>`。
- `What does this PR do?` 要简洁、具体，避免大段空泛 AI 文案。
- 验证部分只写真实执行过的检查或测试。
- 若无截图，`Screenshots / recordings` 可写 `Not applicable.`。

### 3. 确认后再提交

按下面顺序执行：

1. 先把 PR 草稿发给用户确认。
2. 用户确认后再执行 commit、push、`gh pr create`。
3. 默认 PR 目标仓库是 `Science-Discovery/Aether`。
4. 必须先向用户询问 PR 的目标分支，不要自行默认使用任何分支。
5. 询问目标分支时，必须明确给出以下三个选择：
   - `beta`：第一默认选项。
   - `dev`：第二默认选项，并明确提醒用户向 `dev` 发起 PR 需要谨慎。
   - 用户自行输入其他目标分支。
6. 创建完成后，记录并回报：
   - 分支名
   - commit hash
   - commit message
   - PR 编号
   - PR 链接

补充注意：

- `git commit` 可能因沙箱无法写入 `.git/index.lock` 而失败；这种情况应直接改用提权方式继续，不要把它误判成仓库状态异常。
- `git push` 和 `gh pr create` 默认优先使用提权方式执行，因为它们通常依赖沙箱外网络。

## 输出要求

每次执行该工作流时，输出要清楚分成两个阶段：

1. issue 状态确认或 issue 草稿
2. PR 草稿或 PR 结果

如果 issue 和 PR 都已创建，最终回复中应明确给出：

- 目标仓库
- issue 编号与链接
- 分支名
- commit hash
- commit message
- PR 编号与链接

## 禁止事项

- 不要在没有 issue 编号的情况下假装已经关联 issue。
- 不要在未给用户看草稿前直接创建 issue。
- 不要在未给用户看 PR 草稿前直接创建 PR。
- 不要忽略 `Science-Discovery/Aether` 的模板。
- 不要把未实际运行的测试写进 PR。
