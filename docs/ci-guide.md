# CI/CD 与仓库自动化备忘

本文档基于当前仓库 [`.github/workflows`](/home/dsjian/researches/Aether/.github/workflows) 与 [`.github/actions`](/home/dsjian/researches/Aether/.github/actions) 的实际配置整理。当前共存在 `30` 条 workflow，以及 `2` 个复用 action。

需要先说明一点：这个仓库的 GitHub Actions 不只有传统意义上的 CI/CD，还包含了大量仓库治理、社区运营和 AI 自动化流程。所以更准确的分类是：

- CI 质量校验
- CD 构建、发布、部署
- 生成与文档自动化
- 仓库治理与社区流程
- 报表与通知

## 总览

### 1. CI 质量校验

#### `test.yml`

- 类型：CI
- 触发：`push` 到 `dev`、`pull_request`、`workflow_dispatch`
- 主要内容：
  - `app-unit`：执行 `bun --cwd packages/app test:unit`
  - `opencode-unit`：在 `packages/opencode` 下执行 `bun test --timeout 30000`
- 作用：
  - 提供当前主线单元测试门禁
  - 区分稳定测试与暂未纳入 required baseline 的测试
- 备注：
  - 注释明确说明 Windows 测试与 app E2E 暂时不作为当前 required baseline

#### `typecheck.yml`

- 类型：CI
- 触发：`push` 到 `dev`、`pull_request` 到 `dev`、`workflow_dispatch`
- 主要内容：
  - 执行 `bun typecheck`
- 作用：
  - 检查 TypeScript 类型错误
  - 作为快速、低成本的静态校验

#### `storybook.yml`

- 类型：CI
- 触发：
  - `push` 到 `dev`
  - `pull_request` 到 `dev`
  - `workflow_dispatch`
  - 仅在 `packages/storybook/**`、`packages/ui/**`、锁文件或 workflow 本身变化时触发
- 主要内容：
  - 执行 `bun --cwd packages/storybook build`
- 作用：
  - 验证 UI 组件文档站能否正常构建
  - 防止 UI 组件和 Storybook 配置回归

#### `nix-eval.yml`

- 类型：CI
- 触发：`push` 到 `dev`、`pull_request` 到 `dev`、`workflow_dispatch`
- 主要内容：
  - 安装 Nix
  - 运行 `nix flake metadata`
  - 运行 `nix flake show --all-systems`
  - 校验多系统下的 `packages.<system>.opencode`
  - 校验可选包 `desktop`
  - 校验 `devShells.<system>.default`
- 作用：
  - 保证 flake 结构没有坏
  - 保证 Nix 输出在多平台仍可求值

### 2. CD 构建、发布、部署

#### `publish.yml`

- 类型：CD / 主发布流水线
- 触发：
  - `push` 到 `ci`、`dev`、`beta`、`snapshot-*`
  - `workflow_dispatch`
- 主要内容：
  - `version`
    - 计算版本号、tag、release id、目标仓库
  - `build-cli`
    - 构建 CLI
    - 产出 macOS、Linux、Windows 的 artifact
  - `sign-cli-windows`
    - 使用 Azure Trusted Signing 为 Windows CLI 签名
    - 重新打包 zip
    - 验签后上传 release asset
  - `build-tauri`
    - 多平台构建 Tauri 桌面端
    - macOS 导入签名证书
    - Windows 登录 Azure
    - Linux 安装原生依赖
    - 通过 `tauri-action` 上传制品并关联 release draft
  - `build-electron`
    - 多平台构建 Electron 桌面端
    - 按平台打包、签名、发布或仅打包
    - Windows 产物验签
  - `publish`
    - 汇总下载前面产生的 artifact
    - 登录 GHCR
    - 准备 AUR 发布环境
    - 执行 `./script/publish.ts`
- 作用：
  - 统一完成版本生成、制品构建、代码签名、桌面端打包、GitHub Release 上传、容器与包分发
- 说明：
  - 这是仓库里最完整、最接近“标准企业级发布流水线”的 workflow

#### `deploy.yml`

- 类型：CD / 部署
- 触发：`push` 到 `dev`、`production`，或手动触发
- 主要内容：
  - 安装 Bun 与 Node
  - 删除 runner 预装的 `pulumi-language-nodejs` 以规避 SST 与 Pulumi 版本冲突
  - 执行 `bun sst deploy --stage=${{ github.ref_name }}`
- 作用：
  - 把基础设施和服务部署到对应环境
  - 根据分支名区分 `dev` 与 `production`

#### `containers.yml`

- 类型：CD / 镜像发布
- 触发：
  - `push` 到 `dev`
  - 且仅在 `packages/containers/**`、`package.json` 或 workflow 自身变化时运行
  - `workflow_dispatch`
- 主要内容：
  - Setup QEMU / Buildx
  - 登录 `ghcr.io`
  - 执行 `bun ./packages/containers/script/build.ts --push`
- 作用：
  - 构建并推送容器镜像到 GHCR

#### `publish-vscode.yml`

- 类型：CD / 扩展发布
- 触发：
  - `vscode-v*.*.*` tag
  - `workflow_dispatch`
- 主要内容：
  - 安装 `@vscode/vsce`
  - 安装 `sdks/vscode` 依赖
  - 执行 `./script/publish`
- 作用：
  - 发布 VS Code 扩展
  - 同时使用 `VSCE_PAT` 与 `OPENVSX_TOKEN`

#### `publish-github-action.yml`

- 类型：CD / GitHub Action 发布
- 触发：
  - `github-v*.*.*` tag
  - `workflow_dispatch`
- 主要内容：
  - 拉取 tags
  - 在 `./github` 目录执行 `./script/publish`
- 作用：
  - 发布仓库中的 GitHub Action 产物

#### `release-github-action.yml`

- 类型：CD / GitHub Action 版本准备
- 触发：
  - `push` 到 `dev`
  - 且路径命中 `github/**`
- 主要内容：
  - 拉取 tags
  - 在 `./github` 目录执行 `./github/script/release`
- 作用：
  - 为 GitHub Action 相关代码变更自动做 release 处理

#### `sync-zed-extension.yml`

- 类型：CD / 外部生态同步
- 触发：
  - `release.published`
  - `workflow_dispatch`
- 主要内容：
  - 根据事件获取 tag
  - 执行 `./script/sync-zed.ts`
- 作用：
  - 将扩展版本同步到 Zed 生态

#### `notify-discord.yml`

- 类型：CD 辅助 / 发布通知
- 触发：`release.released`
- 主要内容：
  - 使用 `SethCohen/github-releases-to-discord@v1`
- 作用：
  - 在正式 release 发布后发送 Discord 通知

#### `beta.yml`

- 类型：发布通道维护
- 触发：
  - 每小时一次
  - `workflow_dispatch`
- 主要内容：
  - 安装 `opencode-ai`
  - 执行 `bun script/beta.ts`
  - 使用 GitHub App token 推送变更
- 作用：
  - 同步和维护 beta 分支或 beta 发布通道

### 3. 生成与文档自动化

#### `generate.yml`

- 类型：自动生成
- 触发：`push` 到 `dev`
- 主要内容：
  - 执行 `./script/generate.ts`
  - 若有变更则自动 `commit` 并 `push`
- 作用：
  - 保持生成代码、派生文件与源码一致

#### `docs-update.yml`

- 类型：文档自动化
- 触发：
  - 每 12 小时
  - `workflow_dispatch`
- 主要内容：
  - 获取最近 `4` 小时的提交
  - 调用 `sst/opencode/github@latest`
  - 让 docs agent 检查是否有用户可见的新功能未被文档覆盖
  - 如有需要，自动更新 `packages/web/src/content/docs/*`
- 作用：
  - 减少“代码已变，文档没跟上”的情况

#### `docs-locale-sync.yml`

- 类型：文档自动化
- 触发：
  - `push` 到 `dev`
  - 且只在英文 docs 变化时触发
- 主要内容：
  - 计算变更过的英文文档
  - 调用 opencode docs agent
  - 要求使用 translator 子代理并行更新多语言文档
  - 自动提交并推送
- 作用：
  - 设计目标是同步英文文档与各 locale 文档
- 当前状态：
  - `if: false`
  - 也就是说现在被显式关闭，不会真正执行

#### `nix-hashes.yml`

- 类型：构建辅助 / 可复现性维护
- 触发：
  - `workflow_dispatch`
  - `push` 到 `dev`、`beta`
  - 仅在 `bun.lock`、`package.json`、`flake.lock`、`nix/**`、`patches/**` 等变化时触发
- 主要内容：
  - 在四个平台 runner 上分别计算 `node_modules` 哈希
  - 上传 hash artifact
  - 汇总并更新 `nix/hashes.json`
  - 自动提交推送
- 作用：
  - 维护 Nix 构建所需的依赖哈希
  - 保证多平台可复现构建

### 4. 仓库治理与社区流程

#### `duplicate-issues.yml`

- 类型：Issue 治理
- 状态：待恢复（当前禁用）
- 触发（原本预期）：issue `opened`、`edited`
- 主要内容（原本预期）：
  - 在 issue 新建时：
    - 检查是否符合 issue 模板与贡献规范
    - 检查是否疑似重复 issue
    - 检查是否属于 keybind 相关问题
    - 若不合规，自动打 `needs:compliance` 标签并评论
  - 在 issue 编辑时：
    - 若 issue 原本带 `needs:compliance`
    - 则重新检查是否已经修复
    - 修复后自动去标签、删除旧评论、发确认评论
- 作用：
  - 降低低质量 issue
  - 及早提示重复问题
- 当前触发：`workflow_dispatch`
- 当前现状：
  - 这条 workflow 原本承担 issue 合规检查、重复 issue 检查、keybind 提示等工作
  - 现在因为强依赖 OpenCode CLI 与 `OPENCODE_API_KEY`，已经从自动触发改为仅手动触发
  - 当前 fork 仓库不再把它视为可直接启用的社区入口
- 后续处理：
  - 需要在与 OpenCode 脱钩后重新设计 issue 合规/重复检查方案
  - 本轮只保留条目说明，不恢复实现

#### `compliance-close.yml`

- 类型：Issue/PR 治理
- 状态：已验证
- 触发：
  - 每 30 分钟
  - `workflow_dispatch`
- 主要内容：
  - 扫描所有带 `needs:compliance` 的 open issue/PR
  - 查找带 `<!-- issue-compliance -->` 标记的提醒评论
  - 若超过 2 小时未修复，则自动关闭
- 作用：
  - 形成“提醒后限时整改”的自动收口机制

#### `close-issues.yml`

- 类型：Issue 治理
- 状态：已验证
- 触发：
  - 每天一次
  - `workflow_dispatch`
- 主要内容：
  - 执行 `bun script/github/close-issues.ts`
- 作用：
  - 自动关闭 stale issue
- 当前现状：
  - 脚本已修复为针对当前仓库运行，不再写死上游仓库名
  - stale 阈值与提示文案已统一为 `60` 天

#### `close-stale-prs.yml`

- 类型：PR 治理
- 状态：已验证
- 触发：
  - 每天一次
  - `workflow_dispatch`
- 主要内容：
  - 拉取全部 open PR
  - 计算最近活动时间，包含创建、提交、评论、review
  - 对超过 `60` 天无活动的 PR 自动评论并关闭
  - 内置限流重试与退避逻辑
- 作用：
  - 减少长期无人维护 PR 的积压

#### `triage.yml`

- 类型：Issue 治理 / AI 分诊
- 状态：⚠️ 当前保留但不处理
- 触发（原本预期）：issue `opened`
- 主要内容：
  - 执行 `opencode run --agent triage`
- 作用：
  - 对新 issue 做自动分诊
- 当前触发：`workflow_dispatch`
- 当前现状：
  - 这条 workflow 仍依赖旧的 OpenCode 执行链路：安装 `opencode` CLI 后执行 `opencode run --agent triage`
  - 当前 fork 仓库没有恢复这条链路，也不再把它作为自动 issue 分诊入口
- 备注：
  - 本轮不移除文件
  - 本轮也不恢复实现，仅在文档中明确现状

#### `review.yml`

- 类型：PR 治理 / 按需 AI 审查
- 状态：⚠️ 当前保留但不处理
- 触发（原本预期）：PR 评论中出现 `/review`
- 权限条件：
  - 评论者必须是 `OWNER` 或 `MEMBER`
- 主要内容：
  - 获取 PR 标题、正文、head SHA
  - 调用模型检查风格规范和潜在 bug
  - 使用 `gh api` 在具体文件行上创建 review comments
  - 若没有问题，仅回复 `lgtm`
- 作用：
  - 让维护者可以手动触发一次 AI code review
- 当前触发：`workflow_dispatch`
- 当前现状：
  - 这条 workflow 虽然使用 `ANTHROPIC_API_KEY` 作为底层模型凭据，但执行器仍是旧的 `opencode` CLI
  - 当前 fork 仓库暂未恢复这条 AI review 能力，也不再保留评论触发入口
- 备注：
  - 本轮不移除文件
  - 本轮不继续改造实现，仅保留现状说明

#### `pr-management.yml`

- 类型：PR 治理
- 状态：部分启用 / 待重构
- 触发：`pull_request_target` `opened`
- 主要内容：
  - 检查作者是否是团队成员或 bot
  - 若不是，则构建 PR 信息并运行 `bun script/duplicate-pr.ts`
  - 如果疑似重复 PR，则自动评论
  - 若作者 `author_association` 为 `CONTRIBUTOR`，自动加 `contributor` 标签
- 作用：
  - 减少重复 PR
  - 标记外部贡献者
- 当前现状：
  - `contributor` 标签逻辑仍然启用，依旧会在合适条件下为外部贡献者打标签
  - 重复 PR 检查 job 已被显式停用，不再依赖 OpenCode 运行
- 后续处理：
  - 这条 workflow 需要在脱钩后补上一套新的重复 PR 检查方案
  - 本轮不展开恢复设计，只保留状态说明

#### `pr-standards.yml`

- 类型：PR 治理 / 规范校验
- 状态：活跃，但本轮不继续验证
- 触发：`pull_request_target` 的 `opened`、`edited`、`synchronize`
- 主要内容：
  - `check-standards`
    - 校验 PR 标题是否符合 conventional commit 格式
    - 校验是否关联 issue
    - 不符合时打 `needs:title` 或 `needs:issue`
  - `check-compliance`
    - 校验 PR 模板 section 是否齐全
    - 校验 “What does this PR do?” 是否有真实内容
    - 校验 Type of change 是否勾选
    - 校验验证方式是否填写
    - 校验 checklist 是否完成
    - 不合规时打 `needs:compliance`
    - 修复后自动删旧评论、移除标签并回评
- 作用：
  - 确保 PR 标题、issue 关联、模板内容、验证说明符合仓库要求
- 当前现状：
  - 这条 workflow 仍然启用
  - 它会跳过团队成员与 bot，因此对维护者自测不一定有可见结果

#### `vouch-check-issue.yml`

- 类型：Issue 治理 / 信任体系
- 状态：已验证
- 触发：issue `opened`
- 主要内容：
  - 读取 `.github/VOUCHED.td`
  - 若作者在 denounced 列表中，则自动评论并关闭
  - 若作者在 vouched 列表中，则自动加 `Vouched` 标签
- 作用：
  - 用一套显式名单管理 issue 作者信誉

#### `vouch-check-pr.yml`

- 类型：PR 治理 / 信任体系
- 状态：已验证
- 触发：`pull_request_target` `opened`
- 主要内容：
  - 与 `vouch-check-issue.yml` 同逻辑，但对象是 PR
- 作用：
  - 用同一套信誉策略治理 PR 作者

#### `vouch-manage-by-issue.yml`

- 类型：仓库治理工具
- 状态：已移除
- 原始作用：
  - 原本用于通过 issue comment 驱动 vouch 列表维护
  - 依赖旧的 GitHub App 配置 `OPENCODE_APP_ID` 与 `OPENCODE_APP_SECRET`
- 当前现状：
  - 这条 workflow 已不再是当前仓库支持的社区流程入口
  - 因为与当前 fork 的治理方式不匹配，已从仓库中直接移除

#### `opencode.yml`

- 类型：仓库内 AI 助手入口
- 状态：已移除
- 原始作用：
  - 原本用于通过 `/oc` 或 `/opencode` 评论触发仓库内 AI 助手
  - 依赖 `anomalyco/opencode/github@latest` 与旧的 `OPENCODE_API_KEY`
- 当前现状：
  - 这条 workflow 已不再是当前仓库支持的社区流程入口
  - 评论触发式 AI 助手能力已随 OpenCode 绑定能力一起移除

### 5. 报表与通知

#### `daily-issues-recap.yml`

- 类型：社区日报
- 触发：
  - 每天 `23:00 UTC`
  - `workflow_dispatch`
- 主要内容：
  - 检索当天新开的 open issue
  - 排除团队成员创建的 issue
  - 让模型归纳严重程度、活跃度、重复趋势
  - 生成 Discord 兼容摘要并通过 webhook 推送
- 作用：
  - 让团队快速了解当天社区 issue 动态

#### `daily-pr-recap.yml`

- 类型：社区日报
- 触发：
  - 每天 `22:00 UTC`
  - `workflow_dispatch`
- 主要内容：
  - 检索当天新建或更新的 open PR
  - 排除团队成员和指定 bot 活动
  - 聚焦 bug fix、高活跃 PR、quick wins
  - 生成 Discord 摘要并推送
- 作用：
  - 帮助团队快速抓住当天最值得看的社区 PR

#### `stats.yml`

- 类型：统计自动化
- 触发：
  - 每天 `12:00 UTC`
  - `workflow_dispatch`
- 主要内容：
  - 执行 `bun script/stats.ts`
  - 更新 `STATS.md`
  - 如有变化则自动提交
- 作用：
  - 维护下载统计等项目指标
- 备注：
  - 只在 `anomalyco/opencode` 仓库中执行

## 复用 action

### `.github/actions/setup-bun`

- 作用：
  - 为多数 Bun/Node 相关 workflow 提供统一环境准备
- 主要内容：
  - 解析 Bun 版本
  - 配置 Bun
  - 缓存 `bun pm cache`
  - 安装 `setuptools`
  - 执行 `bun install`
- 价值：
  - 减少各 workflow 中重复的依赖安装逻辑
  - 保持缓存策略一致

### `.github/actions/setup-git-committer`

- 作用：
  - 为需要自动提交、推 tag、发布 release 的 workflow 统一配置 GitHub App 身份
- 主要内容：
  - 创建 GitHub App token
  - 配置 git 用户名和邮箱
  - 清理默认 checkout 认证信息
  - 重写 `origin` 为 token 认证地址
- 价值：
  - 让自动提交与发布流程使用独立、更可控的机器身份

## 从“真正 CI/CD”视角看主干流程

如果只从狭义的 CI/CD 角度理解，这个仓库最关键的主干流程大致是：

- CI：
  - `test.yml`
  - `typecheck.yml`
  - `storybook.yml`
  - `nix-eval.yml`
- 发布：
  - `publish.yml`
  - `containers.yml`
  - `publish-vscode.yml`
  - `publish-github-action.yml`
- 部署：
  - `deploy.yml`

其余 workflow 大多属于文档同步、生成维护、Issue/PR 治理、社区运营和通知自动化。

## 当前特征总结

这个仓库的自动化体系有几个明显特点：

- 传统 CI 比较克制，主门禁集中在测试、类型检查、UI 构建、Nix 求值
- 发布体系很重，覆盖 CLI、Tauri、Electron、容器、VS Code 扩展、GitHub Action、Zed 扩展
- 仓库治理自动化很多，尤其是 issue/PR 合规、重复检查、stale 清理、vouch 体系
- AI 深度参与多个流程，包括 docs 更新、issue triage、duplicate 检查、日报生成和按需 review
- 有些流程当前处于“已设计但暂时关闭”状态，例如 `docs-locale-sync.yml`

## 维护建议

后续查看这套体系时，可以优先关注这几个文件：

- [`.github/workflows/test.yml`](/home/dsjian/researches/Aether/.github/workflows/test.yml)
- [`.github/workflows/typecheck.yml`](/home/dsjian/researches/Aether/.github/workflows/typecheck.yml)
- [`.github/workflows/publish.yml`](/home/dsjian/researches/Aether/.github/workflows/publish.yml)
- [`.github/workflows/deploy.yml`](/home/dsjian/researches/Aether/.github/workflows/deploy.yml)
- [`.github/workflows/pr-standards.yml`](/home/dsjian/researches/Aether/.github/workflows/pr-standards.yml)
- [`.github/workflows/duplicate-issues.yml`](/home/dsjian/researches/Aether/.github/workflows/duplicate-issues.yml)
- [`.github/actions/setup-bun/action.yml`](/home/dsjian/researches/Aether/.github/actions/setup-bun/action.yml)
- [`.github/actions/setup-git-committer/action.yml`](/home/dsjian/researches/Aether/.github/actions/setup-git-committer/action.yml)
