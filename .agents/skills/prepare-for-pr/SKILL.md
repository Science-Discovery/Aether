---
name: prepare-for-pr
description: github PR 操作的前期准备。用于当前分支准备合入 dev 前，检查与 dev 的冲突、分支差异、代码/文档规范、文档与实现一致性，并产出 PR description。
---

# Prepare For PR

把当前分支合入 `dev` 分支前，执行一次只读审查和 PR 描述准备。默认分支是 `dev`；不要假设本地有 `main`。

## Workflow

1. 收集基线信息：
   - `git status --short --branch`
   - `git branch --show-current`
   - `git diff --stat dev...HEAD`
   - `git diff --name-status dev...HEAD`
   - 若工作区有未提交或未跟踪文件，单独在结论中说明；不要把未跟踪文件默认为 PR 内容。

2. 冲突预检：
   - 必须运行：
     ```bash
     git merge-tree --write-tree dev HEAD > /dev/null 2>&1 && echo "无冲突" || echo "有冲突"
     ```
   - 如果输出 `有冲突`：提示用户先执行 `git rebase dev` 或自行解决冲突，并中止本 skill，不继续做差异审查。
   - 如果输出 `无冲突`：继续后续检查。

3. 差异分析：
   - 以 `dev...HEAD` 为主分析范围，识别改动类别：运行时代码、测试、文档、配置、依赖、patch、生成文件。
   - 阅读关键 diff，不只看文件名。重点检查跨模块契约、异步/流式逻辑、错误处理、权限/鉴权、真实外部服务调用、配置解析、schema 变化和测试入口。
   - 如果存在工作区未提交修改，并且它们会影响 PR 结论，额外检查工作区 diff；明确区分“已在 HEAD 中的 PR 内容”和“当前工作区额外修改”。

4. 静态检查：
   - 必跑格式检查：
     - `git diff --check dev...HEAD`
     - 若工作区有额外修改，也跑 `git diff --check` 或 `git diff --check dev`
   - TypeScript 项目按包目录运行 typecheck，不能从 repo root 直接跑 `tsc`：
     - 常见命令：`cd packages/opencode && bun typecheck`
   - 根据 diff 选择最小但有代表性的测试：
     - provider / transform 改动：`bun test test/provider/provider.test.ts test/provider/transform.test.ts`
     - session / LLM / compaction 改动：`bun test test/session/llm.test.ts test/session/message-v2.test.ts test/session/prompt.test.ts test/session/compaction-flow.test.ts`
     - 工具或 registry 改动：运行对应 `test/tool/*`
     - 真实 provider smoke 只在有本地凭据且用户明确需要时运行；未运行时说明原因。

5. 文档一致性检查：
   - 对新增或修改的文档，核对文档中提到的命令、路径、环境变量、默认值、provider/model 矩阵、测试范围是否与代码一致。
   - 对新增测试或脚本，核对文档是否说明启用方式、跳过条件、失败行为和输出位置。
   - 对代码注释里的文档路径、issue/PR 编号、状态文档引用做存在性检查。
   - 如果文档承诺的行为和代码不一致，必须作为问题列出；不要只写“文档已更新”。

6. Bug 风险审查：
   - 按 severity 列出可能引入的 bug。优先关注可复现行为、缺失测试、边界输入、0 tests 成功退出、错误被吞掉、配置无效却误判成功、真实外部调用风险。
   - 对每个问题给出文件和行号；能复现的，写出复现命令和实际结果。
   - 如果未发现问题，也要说明残余风险和未运行的检查。

7. PR description：
   - 无论结论好坏，都要产出 PR description。
   - PR description 应包含：
     - `Summary`
     - `Verification`
     - `Notes / Risks`
   - 如果有未修复问题、未运行真实 smoke、工作区有未跟踪文件，都写进 `Notes / Risks`。

## Output

最终展示必须包含：

- 冲突预检结果。
- 当前分支、目标分支和工作区状态摘要。
- 代码静态检查结论。
- 文档与代码一致性结论。
- Bug 风险 / 发现的问题，按严重程度排序。
- 已运行和未运行的测试。
- 可直接复制到 PR 的 description。
