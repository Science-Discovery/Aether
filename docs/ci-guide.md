# CI/CD 与仓库自动化备忘

本文档基于当前仓库 [`.github/workflows`](/home/dsjian/researches/Aether/.github/workflows) 与 [`.github/actions`](/home/dsjian/researches/Aether/.github/actions) 的实际配置整理。当前共存在 `22` 条 workflow，以及 `2` 个复用 action。

需要先说明一点：这个仓库的 GitHub Actions 不只有传统意义上的 CI/CD，还包含了大量仓库治理、社区运营和 AI 自动化流程。所以更准确的分类是：

- CI 质量校验
- CD 构建、发布、部署
- 生成与文档自动化
- 仓库治理与社区流程
- 报表与通知

## 总览

### 1. CI 质量校验

#### `test.yml`

- 类型：CI / 单元测试
- 状态：活跃
- 触发（当前）：
  - `push` 到 `dev`
  - 所有 `pull_request`
  - `workflow_dispatch`
- 主要内容：
  - workflow 配置了并发控制：
    - `dev` 分支上的 run 使用独立 group，不会互相取消，避免默认分支历史出现“检查被新提交中断”的噪音
    - PR 和其他 ref 会按 `workflow + PR 编号/ref` 分组，新的 run 会取消旧的同组 run
  - `app-unit`
    - checkout 仓库
    - 调用复用 action `.github/actions/setup-bun`，解析 Bun 版本、恢复 `bun pm cache`、执行 `bun install`
    - 配置 git 身份
    - 执行 `bun --cwd packages/app test:unit`
    - 该命令实际会跑 `packages/app` 下的 `bun test --preload ./happydom.ts ./src`
  - `opencode-unit`
    - checkout 仓库
    - 调用 `.github/actions/setup-bun`
    - 在 `packages/opencode` 下设置 `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`
    - 执行 `bun test --timeout 30000`
    - 这条 job 设置了 `20` 分钟超时
- 作用：
  - 为 `packages/app` 和 `packages/opencode` 提供持续的单元测试校验
  - 把较稳定的前端单测与核心包单测分开展示，便于区分问题来源
- 备注：
  - workflow 注释明确说明：
    - Windows 测试当前不纳入 required baseline，原因是仓库 symlink 在 GitHub Hosted Windows runner 上会遇到 checkout 阶段的 `Filename too long`
    - app E2E 当前也不纳入 required baseline，原因是 CI 中临时端口分配尚未稳定

#### `typecheck.yml`

- 类型：CI / 静态类型校验
- 状态：活跃
- 触发（当前）：
  - `push` 到 `dev`
  - `pull_request` 到 `dev`
  - `workflow_dispatch`
- 主要内容：
  - checkout 仓库
  - 调用 `.github/actions/setup-bun`
  - 执行仓库根脚本 `bun typecheck`
  - 根脚本在 `package.json` 中定义为 `bun turbo typecheck`，会把类型检查分发到各 workspace 的 `typecheck` 脚本，例如 `packages/app` 的 `tsgo -b`、`packages/opencode` 的 `tsgo --noEmit`、`packages/ui` 的 `tsgo --noEmit`
- 作用：
  - 作为全仓静态类型门禁
  - 在不执行测试的情况下尽早暴露跨包类型回归
- 备注：
  - 这条 workflow 没有路径过滤；只要命中触发条件，就会对整个 monorepo 的类型检查图执行一次聚合校验

#### `storybook.yml`

- 类型：CI / UI 构建校验
- 状态：活跃
- 触发（当前）：
  - `push` 到 `dev`
  - `pull_request` 到 `dev`
  - `workflow_dispatch`
  - 仅在 `packages/storybook/**`、`packages/ui/**`、锁文件或 workflow 本身变化时触发
- 主要内容：
  - workflow 配置了基于 `workflow + ref` 的并发组，新 run 会取消旧 run
  - checkout 仓库
  - 调用 `.github/actions/setup-bun`
  - 执行 `bun --cwd packages/storybook build`
  - 该命令实际会运行 `packages/storybook/package.json` 中的 `storybook build`，把 Storybook 静态站点完整构建一遍
- 作用：
  - 验证 Storybook 站点和 `packages/ui` 组件依赖链没有被改坏
  - 把 UI 文档站构建问题限制在相关路径变更时再触发，减少无关提交的 CI 开销
- 备注：
  - 这条 workflow 的路径过滤比较严格；与 UI/Storybook 无关的改动不会触发它

#### `nix-eval.yml`

- 类型：CI / Nix Flake 求值校验
- 状态：活跃
- 触发（当前）：
  - `push` 到 `dev`
  - `pull_request` 到 `dev`
  - `workflow_dispatch`
- 主要内容：
  - workflow 配置了基于 `workflow + ref` 的并发组，新 run 会取消旧 run
  - checkout 仓库
  - 安装 Nix
  - 在单个 shell 步骤中依次执行：
    - `nix --version`
    - `nix flake metadata`
    - `nix flake show --all-systems`
  - 然后对四个平台逐一做求值检查：
    - `x86_64-linux`
    - `aarch64-linux`
    - `x86_64-darwin`
    - `aarch64-darwin`
  - 对 `packages.<system>.opencode` 做强校验：
    - 通过 `nix eval .#packages.<system>.opencode.drvPath --raw`
    - 任一系统失败都会把 workflow 标红并退出
  - 对 `packages.<system>.desktop` 做可选校验：
    - 同样尝试 `nix eval`
    - 但失败只记 `warning`，不会终止 workflow
  - 对 `devShells.<system>.default` 做强校验：
    - 任一系统失败都会终止 workflow
- 作用：
  - 保证 flake 元数据、包输出和开发 shell 仍然可以在多系统维度求值
  - 在真正构建前尽早发现 Nix 层面的结构性回归
- 备注：
  - `desktop` 当前被当作 optional package 处理；workflow 内有注释说明，等上游问题修复后再转入必过校验

### 2. CD 构建、发布、部署

#### `publish.yml`

- 类型：CD / 主发布流水线
- 状态：活跃（已于 2026-04-06 精简为 Aether 自有发布流程；同日切到仅发布纯浏览器版）
- 触发：
  - `workflow_dispatch`
- 主要内容：
  - `release`
    - 根据手动输入的版本号创建或复用 GitHub draft release
  - `build-electron`
    - 在 macOS、Windows、Linux 上分别构建 Electron 桌面版
    - 先构建本地 sidecar，再打包 Electron 安装包
    - 不做代码签名，不直接发布到 GitHub Release
    - 相关 job 仍保留在 workflow 中，作为后续恢复 Electron 发布的备用配置
    - 当前被顶层开关禁用，不参与实际 CD 发布链路
  - `build-web-mac` / `build-web-linux` / `build-web-windows`
    - 分别调用现有打包脚本产出纯浏览器版安装包
    - 保留各平台更新脚本与元数据文件
  - `publish`
    - 汇总所有（当前启用的平台浏览器版）artifact
    - 上传到同一个 GitHub draft release
- 作用：
  - 统一完成 Aether 的 （Electron 桌面版）与纯浏览器版打包
  - 统一将产物上传到 GitHub Release，作为当前唯一正式分发入口
- 说明：
  - 旧版 workflow 中的 Tauri、Azure 签名、Apple 签名、npm、GHCR、AUR、Homebrew、GitHub App 等上游耦合逻辑已移除
  - 当前发布模式改为“手动输入版本号 -> GitHub Actions 构建 -> 生成 draft release -> 上传附件”
  - Electron 发布步骤没有直接删除，而是通过 workflow 顶层开关暂时停用，便于后续恢复
  - 这条 workflow 当前不依赖仓库级自定义 secrets，默认使用 `GITHUB_TOKEN`

#### `deploy.yml`

- 类型：CD / 部署
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
- 触发：`push` 到 `dev`、`production`，或手动触发
- 主要内容：
  - 安装 Bun 与 Node
  - 删除 runner 预装的 `pulumi-language-nodejs` 以规避 SST 与 Pulumi 版本冲突
  - 执行 `bun sst deploy --stage=${{ github.ref_name }}`
- 作用：
  - 把基础设施和服务部署到对应环境
  - 根据分支名区分 `dev` 与 `production`
- 备注：
  - 当前项目阶段目标是本地 GUI 程序发布，而不是云端基础设施部署，因此已从实际 workflow 中移除

#### `containers.yml`

- 类型：CD / 镜像发布
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
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
- 备注：
  - 当前项目明确不做 Docker / GHCR 分发，因此已从实际 workflow 中移除

#### `publish-vscode.yml`

- 类型：CD / 扩展发布
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
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
- 备注：
  - 当前项目明确不维护 VS Code 扩展发布，因此已从实际 workflow 中移除

#### `publish-github-action.yml`

- 类型：CD / GitHub Action 发布
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
- 触发：
  - `github-v*.*.*` tag
  - `workflow_dispatch`
- 主要内容：
  - 拉取 tags
  - 在 `./github` 目录执行 `./script/publish`
- 作用：
  - 发布仓库中的 GitHub Action 产物
- 备注：
  - 当前项目明确不对外发布 GitHub Action，因此已从实际 workflow 中移除

#### `release-github-action.yml`

- 类型：CD / GitHub Action 版本准备
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
- 触发：
  - `push` 到 `dev`
  - 且路径命中 `github/**`
- 主要内容：
  - 拉取 tags
  - 在 `./github` 目录执行 `./github/script/release`
- 作用：
  - 为 GitHub Action 相关代码变更自动做 release 处理
- 备注：
  - 当前项目明确不维护 GitHub Action 产品线，因此已从实际 workflow 中移除

#### `sync-zed-extension.yml`

- 类型：CD / 外部生态同步
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
- 触发：
  - `release.published`
  - `workflow_dispatch`
- 主要内容：
  - 根据事件获取 tag
  - 执行 `./script/sync-zed.ts`
- 作用：
  - 将扩展版本同步到 Zed 生态
- 备注：
  - 当前项目明确不维护 Zed 扩展同步，因此已从实际 workflow 中移除

#### `notify-discord.yml`

- 类型：CD 辅助 / 发布通知
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
- 触发：`release.released`
- 主要内容：
  - 使用 `SethCohen/github-releases-to-discord@v1`
- 作用：
  - 在正式 release 发布后发送 Discord 通知
- 备注：
  - 当前项目明确不需要 Discord 发布通知，因此已从实际 workflow 中移除

#### `beta.yml`

- 类型：发布通道维护
- 状态：🚫 已删除（2026-04-06，仅保留文档说明作历史参考）
- 触发：
  - 每小时一次
  - `workflow_dispatch`
- 主要内容：
  - 安装 `opencode-ai`
  - 执行 `bun script/beta.ts`
  - 使用 GitHub App token 推送变更
- 作用：
  - 同步和维护 beta 分支或 beta 发布通道
- 备注：
  - 当前项目不再维护上游式 beta 通道，且该流程深度耦合 OpenCode 的 GitHub App 与 API，因此已从实际 workflow 中移除

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

- 类型：Issue 治理 / 合规与重复检测
- 状态：保留文件，但当前基本不可用
- 触发（原本预期）：issue `opened`、`edited`
- 触发（当前）：
  - `workflow_dispatch`
- 主要内容：
  - 定义了两个 job：
    - `check-duplicates`
    - `recheck-compliance`
  - `check-duplicates`
    - 只在 `github.event.action == 'opened'` 时才会运行
    - checkout 仓库
    - 调用 `.github/actions/setup-bun`
    - 通过 `curl` 安装 `opencode` CLI
    - 调用 `opencode run -m opencode/claude-sonnet-4-6`
    - prompt 要求 agent 一次性完成两件事：
      - 检查 issue 是否符合 issue template 与贡献规范
      - 检查是否疑似重复 issue，并对 keybind 相关问题提示固定参考 issue `#4997`
    - agent 被限制只能使用 `gh issue*` 类命令，不允许通用 bash 与 webfetch
    - 如果发现不合规，要求 agent：
      - 在评论中加入 `<!-- issue-compliance -->` 标记
      - 解释需要修复的问题
      - 给 issue 加上 `needs:compliance`
    - 如果发现重复 issue，则把候选 issue 链接和相似原因一并写进同一条评论
  - `recheck-compliance`
    - 只在 `github.event.action == 'edited'` 且 issue 带 `needs:compliance` 标签时运行
    - 同样 checkout、setup-bun、安装 `opencode`
    - 再次检查 issue 是否修复
    - 若已修复，则要求 agent：
      - 移除 `needs:compliance`
      - 删除旧的 `<!-- issue-compliance -->` 评论
      - 发送一条简短确认评论
    - 若仍不合规，则继续保留标签并补充说明
- 作用：
  - 降低低质量 issue
  - 及早提示重复问题
- 备注：
  - 当前 `on:` 只有 `workflow_dispatch`，但两个 job 的执行条件仍然依赖 `github.event.action == 'opened'/'edited'` 和 `github.event.issue.*`
  - 这意味着在正常手动触发场景下，这两个 job 实际上都不会运行，当前文件基本等于“保留了旧逻辑，但没有可用入口”
  - 即使未来恢复 issue 事件触发，它仍然依赖 `OPENCODE_API_KEY` 与外部 `opencode` CLI 执行链路

#### `compliance-close.yml`

- 类型：Issue/PR 治理
- 状态：活跃
- 触发（当前）：
  - 每 30 分钟
  - `workflow_dispatch`
- 主要内容：
  - 通过 `actions/github-script@v7` 直接调用 GitHub API
  - 列出当前仓库所有带 `needs:compliance` 标签且仍处于 open 状态的 issue/PR
  - 对每个条目读取评论，查找包含 `<!-- issue-compliance -->` 标记的那条提醒评论
  - 如果没有这条标记评论，就跳过，不做关闭动作
  - 如果存在标记评论，则按评论创建时间计算是否已经超过 `2` 小时整改窗口
  - 若仍在时限内，只记录日志并跳过
  - 若已超时：
    - 先发送一条自动关闭说明评论
    - 尝试移除 `needs:compliance`
    - 如果是 PR，则调用 `pulls.update` 关闭
    - 如果是 issue，则调用 `issues.update` 关闭，并设置 `state_reason: not_planned`
- 作用：
  - 形成“提醒后限时整改”的自动收口机制
- 备注：
  - 这条 workflow 自身不负责发现不合规内容；它依赖其他流程先打上 `needs:compliance`，并创建带 `<!-- issue-compliance -->` 的提醒评论
  - 因此它实际是一个收口器，而不是入口校验器

#### `close-issues.yml`

- 类型：Issue 治理
- 状态：活跃，但实现有边界风险
- 触发（当前）：
  - 每天 `02:00 UTC`
  - `workflow_dispatch`
- 主要内容：
  - checkout 仓库
  - 安装最新 Bun
  - 执行 `bun script/github/close-issues.ts`
  - 脚本逻辑如下：
    - 依赖 `GITHUB_REPOSITORY` 与 `GITHUB_TOKEN`
    - 把 stale 阈值固定为 `60` 天
    - 通过 `GET /repos/{owner}/{repo}/issues?state=open&sort=updated&direction=asc` 从最旧更新的条目开始分页读取
    - 逐页收集所有超过 `60` 天未更新的条目
    - 一旦遇到第一个“仍然新鲜”的条目，就停止继续翻页
    - 对每个 stale 条目：
      - 先发表评论，说明因 `60` 天无活动而自动关闭
      - 再调用 `PATCH /issues/{num}` 关闭，并写入 `state_reason: completed`
- 作用：
  - 自动关闭 stale issue
- 备注：
  - 当前脚本已经使用 `GITHUB_REPOSITORY`，不再写死上游仓库名
  - 实现上直接调用的是 GitHub Issues API 列表接口，代码里没有显式排除 PR；从程序逻辑看，理论上存在把 PR 也当成 issue 处理的风险
  - 仓库里另有专门的 `close-stale-prs.yml` 负责 PR 清理，因此这条 workflow 更适合作为“issue stale 清理”来理解

#### `close-stale-prs.yml`

- 类型：PR 治理
- 状态：活跃
- 触发（当前）：
  - 每天 `06:00 UTC`
  - `workflow_dispatch`
- 主要内容：
  - 手动触发时支持布尔输入 `dryRun`
    - `true` 时只记录“将要关闭哪些 PR”，不会真的执行关闭
  - 通过 `actions/github-script@v8` 调 GitHub GraphQL API，分页拉取所有 open PR
  - 对每个 PR 收集最近活动时间，取以下时间中的最新值：
    - PR 创建时间
    - 最后一次提交时间
    - 最后一次 issue 评论时间
    - 最后一次 review 时间
  - 以 `60` 天为阈值筛出 stale PR
  - 内置 `withRetry` 重试逻辑，针对 rate limit / secondary rate limit 做指数退避
  - 根据 stale PR 数量自适应调整请求间隔：
    - 小批量 `1s`
    - 大批量 `2s`
  - 非 `dryRun` 模式下，对每个 stale PR：
    - 先发关闭说明评论
    - 再调用 `pulls.update` 关闭
  - 最后输出汇总日志，包括扫描总数、识别到的 stale 数、关闭成功数、跳过数和耗时
- 作用：
  - 减少长期无人维护 PR 的积压
- 备注：
  - 手动 `dryRun` 很适合先做一次人工核验，再决定是否真的批量关闭
  - 这条 workflow 是当前仓库中真正面向 PR 的 stale 清理主入口

#### `triage.yml`

- 类型：Issue 治理 / AI 分诊
- 状态：保留文件，但当前基本不可用
- 触发（原本预期）：issue `opened`
- 触发（当前）：
  - `workflow_dispatch`
- 主要内容：
  - checkout 仓库
  - 调用 `.github/actions/setup-bun`
  - 通过 `curl` 安装 `opencode` CLI
  - 从 `github.event.issue.number/title/body` 读取 issue 上下文，写入环境变量
  - 执行 `opencode run --agent triage`
  - 从 workflow 结构看，这条链路设计目标是把“新 issue 的内容”交给 triage agent，由 agent 继续做标签分类与后续处理
- 作用：
  - 对新 issue 做自动分诊
- 备注：
  - 当前 `on:` 已改成 `workflow_dispatch`，但 workflow 仍依赖 `github.event.issue.*` 上下文
  - 这意味着手动触发时即使 job 会执行，传给 agent 的 `ISSUE_NUMBER`、`ISSUE_TITLE`、`ISSUE_BODY` 通常也是空的，当前几乎没有实际分诊价值
  - 同时它仍依赖 `OPENCODE_API_KEY` 和外部 `opencode` CLI，当前仓库并未把这条链路恢复为可用的自动入口

#### `review.yml`

- 类型：PR 治理 / 按需 AI 审查
- 状态：保留文件，但当前不可达
- 触发（原本预期）：PR 评论中出现 `/review`
- 触发（当前）：
  - `workflow_dispatch`
- 主要内容：
  - job 级别先检查三个条件：
    - 评论目标必须是 PR 线程
    - 评论正文必须以 `/review` 开头
    - 评论者必须是 `OWNER` 或 `MEMBER`
  - 如果条件满足，workflow 才会继续：
    - 解析 PR 编号
    - checkout 仓库
    - 调用 `.github/actions/setup-bun`
    - 安装 `opencode` CLI
    - 用 `gh api` 拉取 PR 标题、正文和 head SHA
    - 调用 `opencode run -m anthropic/claude-opus-4-5`
    - prompt 明确要求 agent：
      - 阅读 PR 变更并检查代码风格和潜在 bug
      - 使用 `gh api` 在具体文件行上创建 review comments
      - 如果没有问题，只回 `lgtm`
- 作用：
  - 让维护者可以手动触发一次 AI code review
- 备注：
  - 当前 `on:` 是 `workflow_dispatch`，但 job 的 `if:` 仍然严格依赖 `github.event.issue.pull_request`、`github.event.comment.body` 和 `github.event.comment.author_association`
  - 因此在正常手动触发场景下，job 条件不会满足，workflow 实际上不会进入审查步骤
  - 也就是说：这条文件目前不是“手动 review 入口”，而是“保留了旧评论触发逻辑，但触发器已经被拿掉”
  - 另外它仍依赖 `ANTHROPIC_API_KEY` 与旧的 `opencode` CLI 执行链路

#### `pr-management.yml`

- 类型：PR 治理
- 状态：活跃
- 触发（当前）：
  - `pull_request_target` `opened`
- 主要内容：
  - 这条 workflow 有两个独立 job
  - `check-duplicates`
    - checkout 仓库
    - 先用 shell 检查 PR 作者是否是 bot，或是否出现在 `.github/TEAM_MEMBERS`
    - 如果作者属于团队成员或 bot，则直接跳过重复检查
    - 如果是外部贡献者，则调用 `.github/actions/setup-bun`
    - 把当前 PR 的编号、标题、正文、仓库名，以及治理用 LLM 的密钥/模型/基地址传给 `bun script/duplicate-pr.ts`
    - `duplicate-pr.ts` 的具体逻辑是：
      - 先校验 `GITHUB_TOKEN`、`GITHUB_REPOSITORY`、`PR_NUMBER`、`PR_TITLE`
      - 如果治理 LLM 配置缺失，则安全退出并输出 `No duplicate PRs found`
      - 从 PR 标题和正文提取多组搜索线索：
        - 原始标题
        - 标题关键词
        - 标题+正文的去重关键词
        - 反引号或双引号中的短语
      - 用这些线索调用 GitHub Search API，在当前仓库检索 open PR 候选集
      - 去重后最多拉取 `8` 个候选 PR 详情
      - 把“当前 PR + 候选 PR 摘要”发给 OpenAI-compatible `chat/completions` 接口
      - 只接受严格 JSON 输出，并只保留 `confidence` 为 `medium` 或 `high` 的候选
      - 如果存在候选，就生成说明文本，由 workflow 用 `gh pr comment` 发到当前 PR
  - `add-contributor-label`
    - 不依赖重复检测 job
    - 只要当前 PR 作者的 `author_association === CONTRIBUTOR`，就给 PR 增加 `contributor` 标签
- 作用：
  - 减少重复 PR
  - 标记外部贡献者
- 备注：
  - 当前 `.github/TEAM_MEMBERS` 里只有 `code-JDS`，因此“团队成员跳过”范围目前非常窄
  - 重复 PR 检查已不依赖旧的 OpenCode CLI，而是 `GitHub API + 第三方 OpenAI-compatible LLM API`
  - 如果 `GOVERNANCE_LLM_API_KEY` 或 `GOVERNANCE_LLM_MODEL` 未配置，脚本会安全跳过，不阻塞 PR
  - `contributor` 标签只会加给 `author_association === CONTRIBUTOR` 的 PR；`FIRST_TIMER`、`FIRST_TIME_CONTRIBUTOR` 不在这条逻辑里

#### `pr-standards.yml`

- 类型：PR 治理 / 规范校验
- 状态：活跃
- 触发（当前）：
  - `pull_request_target` 的 `opened`、`edited`、`synchronize`
- 主要内容：
  - `check-standards`
    - 通过 `actions/github-script@v7` 执行
    - 先跳过 `2026-02-19T00:00:00Z` 之前创建的历史 PR
    - 再跳过 bot 与 `.github/TEAM_MEMBERS` 中的团队成员
    - 校验 PR 标题是否符合 conventional commit 风格，只接受：
      - `feat`
      - `fix`
      - `docs`
      - `chore`
      - `refactor`
      - `test`
      - 可选 scope
    - 如果标题不合规：
      - 增加 `needs:title`
      - 创建一条带 `<!-- pr-standards:title -->` 标记的提醒评论
      - 已有同标记评论时不会重复发
    - 如果标题合规，则尝试移除 `needs:title`
    - 然后检查是否必须关联 issue：
      - `docs`、`refactor`、`feat` 标题会跳过 issue 关联校验，并移除 `needs:issue`
      - 其他类型通过 GraphQL 读取 `closingIssuesReferences.totalCount`
      - 如果没有关联 issue，就打 `needs:issue` 并创建带 `<!-- pr-standards:issue -->` 标记的提醒评论
      - 如果已经关联 issue，则移除 `needs:issue`
  - `check-compliance`
    - 同样会跳过旧 PR、bot 和团队成员
    - 针对 PR 描述做模板合规校验，检查这些 section 是否存在：
      - `What does this PR do?`
      - `Type of change`
      - `How did you verify your code works?`
      - `Checklist`
      - `Issue for this PR`
    - 然后继续检查内容质量：
      - `What does this PR do?` 不能只有占位文本
      - `Type of change` 至少要勾选一个复选框
      - 非 `docs/refactor/feat` PR 的 issue section 必须包含 issue 引用
      - `How did you verify your code works?` 不能留空
      - `Checklist` 至少要有 `2` 个已勾选项
    - 如果发现问题：
      - 增加 `needs:compliance`
      - 创建或更新带 `<!-- issue-compliance -->` 标记的评论
      - 评论中明确列出需要修复的项，并给出 `2` 小时整改窗口
    - 如果 PR 之前带 `needs:compliance`，现在已修复：
      - 移除标签
      - 删除旧的 compliance 评论
      - 发送一条感谢更新的确认评论
- 作用：
  - 确保 PR 标题、issue 关联、模板内容、验证说明符合仓库要求
- 备注：
  - 这条 workflow 只针对 `2026-02-19T00:00:00Z` 之后创建的 PR 生效，属于显式的“新规生效时间线”
  - 它会跳过 bot 与团队成员，因此维护者自己开的 PR 不一定会看到这些标签或提醒评论
  - 当前团队成员名单同样来自 `.github/TEAM_MEMBERS`，目前只有 `code-JDS`

#### `vouch-check-issue.yml`

- 类型：Issue 治理 / 信任体系
- 状态：活跃，但当前策略表为空
- 触发（当前）：
  - issue `opened`
- 主要内容：
  - 通过 `actions/github-script@v7` 直接执行，无需 checkout
  - 新 issue 创建时读取 `.github/VOUCHED.td`
  - 解析文件中的两类名单：
    - vouched：正向信任用户
    - denounced：拒绝用户
  - 解析时支持：
    - 裸用户名
    - `github:username`
    - `-username` / `-github:username`
    - 用户名后的附加说明文本
  - 如果作者是 bot，直接跳过
  - 如果作者在 denounced 列表中：
    - 自动评论
    - 自动关闭 issue，并设置 `state_reason: not_planned`
  - 如果作者在 vouched 列表中：
    - 自动给 issue 加 `Vouched` 标签
  - 如果两边都不在，则什么也不做
- 作用：
  - 用一套显式名单管理 issue 作者信誉
- 备注：
  - 当前 `.github/VOUCHED.td` 只有注释和格式说明，没有实际用户名
  - 所以按当前仓库状态，这条 workflow 一般会运行，但既不会加标签，也不会自动关闭任何 issue

#### `vouch-check-pr.yml`

- 类型：PR 治理 / 信任体系
- 状态：活跃，但当前策略表为空
- 触发（当前）：
  - `pull_request_target` `opened`
- 主要内容：
  - 整体逻辑与 `vouch-check-issue.yml` 一致
  - 区别在于处理对象变成了 PR：
    - denounced 用户会被自动评论并关闭 PR
    - vouched 用户会被加 `Vouched` 标签
  - 同样跳过 bot，同样直接从 API 读取 `.github/VOUCHED.td`
- 作用：
  - 用同一套信誉策略治理 PR 作者
- 备注：
  - 当前 `.github/VOUCHED.td` 为空策略表，因此这条 workflow 现在通常也是“运行但不产生治理动作”

#### 已移除的历史条目

- `vouch-manage-by-issue.yml`
  - 类型：历史 workflow
  - 状态：已移除
  - 备注：当前仓库 `.github/workflows` 中已不存在该文件，不再是当前治理流程的一部分
- `opencode.yml`
  - 类型：历史 workflow
  - 状态：已移除
  - 备注：当前仓库 `.github/workflows` 中已不存在该文件，评论触发式仓库内 AI 助手入口也已不再保留

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
- 部署：
  - 当前无活跃部署 workflow（`deploy.yml` 已删除，文档保留作历史参考）

其余 workflow 大多属于文档同步、生成维护、Issue/PR 治理、社区运营和通知自动化。

## 当前特征总结

这个仓库的自动化体系有几个明显特点：

- 传统 CI 比较克制，主门禁集中在测试、类型检查、UI 构建、Nix 求值
- 发布体系已收敛到 GitHub Release 主线，当前围绕 Electron 桌面版与纯浏览器版两类产物
- 仓库治理自动化很多，尤其是 issue/PR 合规、重复检查、stale 清理、vouch 体系
- AI 深度参与多个流程，包括 docs 更新、issue triage、duplicate 检查、日报生成和按需 review
- 有些流程当前处于“已设计但暂时关闭”状态，例如 `docs-locale-sync.yml`

## 维护建议

后续查看这套体系时，可以优先关注这几个文件：

- [`.github/workflows/test.yml`](/home/dsjian/researches/Aether/.github/workflows/test.yml)
- [`.github/workflows/typecheck.yml`](/home/dsjian/researches/Aether/.github/workflows/typecheck.yml)
- [`.github/workflows/publish.yml`](/home/dsjian/researches/Aether/.github/workflows/publish.yml)
- [`.github/workflows/pr-standards.yml`](/home/dsjian/researches/Aether/.github/workflows/pr-standards.yml)
- [`.github/workflows/duplicate-issues.yml`](/home/dsjian/researches/Aether/.github/workflows/duplicate-issues.yml)
- [`.github/actions/setup-bun/action.yml`](/home/dsjian/researches/Aether/.github/actions/setup-bun/action.yml)
