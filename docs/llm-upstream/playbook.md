# LLM Upstream Migration Playbook

本文件保存稳定工作流。当前任务队列和完成状态见 [status.md](./status.md)。

## Goal

同步上游 `dev` 中影响 LLM API 调用链的真实行为修复，但不整块覆盖上游文件，不把 Effect/HttpApi 等架构迁移混入 bugfix 回迁。

推荐流程：

1. 先比较当前仓库与上游 clone 的 LLM call chain 相关代码，确认实际行为差异。
2. 再回查相关 commit/PR，理解差异来源、意图和 bugfix 优先级。
3. 输出可执行回迁清单，每项标明影响范围、适合动作和测试。

## Scope

主分析范围：

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/provider/models.ts`
- `packages/opencode/src/provider/schema.ts`
- `packages/opencode/src/provider/sdk/copilot/**`
- `packages/opencode/src/auth/**`
- `packages/opencode/src/config/**` 中影响 provider/model/auth 加载的部分
- `packages/opencode/test/session/**`
- `packages/opencode/test/provider/**`
- `packages/opencode/test/system/**`
- `packages/opencode/package.json`
- `bun.lock` 中 AI SDK/provider SDK 相关依赖

默认降级范围：

- TUI、Desktop、Web UI、安装发布、server route 纯迁移，除非直接影响 LLM 请求、provider auth 或 session tool loop。
- Effect service 化、HttpApi 化、模块拆分和命名重构，除非其中承载了可单独提取的 LLM 行为修复。
- 上游 open PR 或 issue 里的未合并补丁，除非本仓库能复现同类问题并补测试。

## Analysis Flow

固定基线：

```bash
git status --short
git branch --show-current
git rev-parse --short HEAD

(cd "$UPSTREAM" && git status --short && git branch --show-current && git rev-parse --short HEAD && git remote -v)
```

比较关键目录：

```bash
git diff --no-index --stat -- packages/opencode/src/session "$UPSTREAM/packages/opencode/src/session"
git diff --no-index --stat -- packages/opencode/src/provider "$UPSTREAM/packages/opencode/src/provider"
git diff --no-index --stat -- packages/opencode/src/config "$UPSTREAM/packages/opencode/src/config"
```

扫描上游相关 commit：

```bash
(cd "$UPSTREAM" && git log --since='2026-03-26' --date=short --pretty=format:'%h %ad %s' -- \
  packages/opencode/src/session \
  packages/opencode/src/provider \
  packages/opencode/src/config \
  packages/opencode/src/auth \
  packages/opencode/test/session \
  packages/opencode/test/provider \
  packages/opencode/test/system \
  packages/opencode/package.json \
  bun.lock)
```

高价值关键词：

```bash
(cd "$UPSTREAM" && git log --since='2026-03-26' \
  --grep='fix\|bug\|reasoning\|deepseek\|azure\|bedrock\|openrouter\|tool\|provider\|llm\|ai sdk\|usage\|stream' \
  --regexp-ignore-case \
  --date=short \
  --pretty=format:'%h %ad %s' -- \
  packages/opencode/src/session \
  packages/opencode/src/provider \
  packages/opencode/src/config \
  packages/opencode/package.json \
  bun.lock)
```

## Priority Rules

`P0` 必须评估：

- provider 真实 API 报错修复。
- reasoning/thinking 字段修复。
- tool call/tool result 顺序修复。
- usage/token 统计修复。
- AI SDK/provider SDK bump 中明确修复真实 provider 兼容问题的变更。
- retry、abort、SSE chunk timeout、5xx retry、context overflow 等流完整性修复。

`P1` 建议评估：

- 新 provider 支持。
- providerOptions namespace 或 key 映射增强。
- 新模型 reasoning variant、effort、`max`、`xhigh`、fast mode。
- 模型元数据 merge、custom provider 配置、plugin model resolution。
- 官方 provider onboarding、错误信息、可观测性改进。

`P2` 默认暂缓：

- Effect service 化、Layer 化、facade 移除。
- HttpApi route 迁移。
- 模块 barrel 删除、命名扁平化、schema 框架迁移。
- TUI/Desktop/server route 非 LLM 行为。
- 大面积工具系统重构。

## Decision Rules

每个候选项只允许一个动作：

| Action | Meaning |
|--------|---------|
| 移植 | 行为明确、风险低、可直接适配当前结构 |
| 手工改写 | 上游实现依赖新架构，但行为值得保留，需要用当前结构重写 |
| 已覆盖 | 当前本仓库已有等价或更适合本地 provider 的实现 |
| 暂缓 | 价值存在，但依赖太大或没有当前需求 |
| 放弃 | 与本仓库本地策略冲突，或只服务上游特定架构 |

判断顺序：

1. 先确认是否会修复当前真实 provider 或本地契约测试可覆盖的问题。
2. 再确认是否会覆盖 [registry.md](./registry.md) 中的 Local compatibility layer。
3. SDK bump 必须确认 peer dependency 和 lockfile 是否需要成组升级。
4. 新 provider 必须确认本仓库是否维护该 provider，或是否只是上游生态列表扩张。
5. 架构重构只提取行为，不搬迁框架。

## Implementation Rules

- 每个 PR 只处理一组强相关行为。
- 不整块覆盖 `llm.ts`、`provider.ts`、`transform.ts`。
- 不把上游 Effect service 化、HttpApi 化作为 LLM bugfix 前置条件。
- 能用当前结构表达的 bugfix，优先手工移植。
- 涉及依赖升级时，AI SDK core、provider SDK 和 lockfile 必须作为一组评估。
- 每个行为改动必须绑定测试；没有测试入口时，在状态文档中明确只能靠真实 smoke 验证。
- 回迁后更新 [status.md](./status.md)；只有大规模重新调查才新增 archive 报告。

## Verification

常规本地验收从 package 目录运行，不能从 repo root 运行：

```bash
cd packages/opencode
bun typecheck
bun test test/provider/provider.test.ts
bun test test/provider/transform.test.ts
bun test test/session/llm.test.ts
```

涉及 session loop、compaction 或工具结果回灌时，额外运行：

```bash
cd packages/opencode
bun test test/session/compaction-flow.test.ts
```

涉及真实 provider 接受度时，按系统测试文档手动运行 smoke：

```bash
cd packages/opencode
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider deepseek
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-reasoning --p1
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider minimax-cn
```

真实 smoke 不是常规 merge blocker；如果某个回迁项声称修复真实供应商兼容问题，PR 描述必须写明是否已运行 smoke，未运行时必须说明原因。

