---
name: aether-issue-pr
description: 面向 Science-Discovery/Aether 仓库的 issue 与 PR 工作流。用户要求“提 issue”“创建 issue”“开 PR”“提交 PR”“用 gh 发 issue/PR”“往 Aether 仓库提单并发 PR”时触发。若用户已指定 issue 则直接关联；否则按仓库模板自动起草并直接创建 issue，无需用户确认。PR 默认提交到 dev 分支并直接创建，无需草稿确认；仅当目标为 beta、main 等敏感分支时提醒用户谨慎并等待确认。
---

# Aether Issue And PR Flow

适用于 `Science-Discovery/Aether` 仓库的 GitHub issue 与 PR 操作。

## 核心规则

- 默认目标仓库始终是 `Science-Discovery/Aether`。
- 除用户明确要求确认草稿外，issue 与 PR 均直接创建，不暂停等待用户确认。
- issue 关联：以用户在会话中明确给出的 issue 编号为准；若用户未指定，则直接自动创建相关 issue。
- PR 目标分支：用户明确指定分支时使用该分支；未指定时默认 `dev`，不要为此询问用户。
- 若用户要求向 `beta` 或 `main` 分支提交 PR，必须先明确提醒用户需要谨慎，并等待用户确认后才继续。
- 不要跳过模板：issue 与 PR 正文仍必须严格按仓库模板生成。
- 凡是涉及 `gh` 认证校验、`gh api`、`gh issue create`、`gh pr create`、`git push` 这类依赖 GitHub 网络或写入 `.git` 的步骤，不要先根据沙箱内失败结果认定为“用户未登录”或“命令本身失败”。
- 若沙箱内出现 `gh auth status` 失败、GitHub API 失败、`.git/index.lock` 无法写入、网络受限等情况，应优先立即用提权方式重试并复核；只有在提权后仍失败，才能把问题归因到用户认证或真实命令错误。

## Issue 流程

### 1. 确定 issue

- 若用户已明确提供 issue 编号，直接使用该 issue，进入 PR 流程。
- 若用户未提供 issue 编号，不要询问用户，直接按下面步骤自动创建。

### 2. 自动创建 issue

按下面顺序执行：

1. 读取 `.github/ISSUE_TEMPLATE/` 下的模板。
2. 根据任务性质选择最合适的模板，通常是：
   - 功能或重构类：`feature-request.yml`
   - 缺陷修复类：`bug-report.yml`
   - 单纯提问：`question.yml`
3. 严格依据模板字段草拟 issue 标题与正文。
4. 直接用本地 `gh` 在 `Science-Discovery/Aether` 创建 issue，无需先把草稿发给用户确认（除非用户明确要求先看草稿）。
5. 创建完成后，记录并回报：
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
3. 检查当前改动范围，默认只提交与本次任务相关的文件，避免混入明显无关的文件；如果用户明确要求“全部提交”，则按用户要求执行。
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

### 3. 直接提交

按下面顺序执行：

1. 按模板生成 PR 正文后，直接执行 commit、push、`gh pr create`，无需先把草稿发给用户确认（除非用户明确要求先确认草稿）。
2. 默认 PR 目标仓库是 `Science-Discovery/Aether`。
3. 目标分支规则：
   - 用户明确指定分支时，使用用户指定的分支。
   - 用户未指定时，直接使用 `dev`，不要询问。
   - 用户要求 `beta` 或 `main` 时，先明确提醒用户向该分支发起 PR 需要谨慎，并等待用户确认；确认前不得执行 push 和 `gh pr create`。
4. 创建完成后，记录并回报：
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

1. issue 创建结果（或用户指定 issue 的关联结果）
2. PR 创建结果

如果 issue 和 PR 都已创建，最终回复中应明确给出：

- 目标仓库
- issue 编号与链接
- 分支名
- commit hash
- commit message
- PR 编号与链接

## 禁止事项

- 不要在没有 issue 编号的情况下假装已经关联 issue。
- 不要在未创建 issue 的情况下直接创建 PR（用户明确指定 issue 的除外）。
- 不要在目标分支为 `beta` 或 `main` 且未经用户确认时执行 push 或创建 PR。
- 不要忽略 `Science-Discovery/Aether` 的模板。
- 不要把未实际运行的测试写进 PR。
