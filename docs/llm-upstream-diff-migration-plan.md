# LLM 调用链差异与回迁计划

此文件已不再作为每轮 vibe coding 会话的长 prompt 使用。

新的文档入口：

- 每轮会话先读：[docs/llm-upstream/session-brief.md](./llm-upstream/session-brief.md)
- 当前状态唯一事实源：[docs/llm-upstream/status.md](./llm-upstream/status.md)
- 稳定差异登记：[docs/llm-upstream/registry.md](./llm-upstream/registry.md)
- 回迁工作流与验收规则：[docs/llm-upstream/playbook.md](./llm-upstream/playbook.md)
- 历史审计报告：[docs/llm-upstream/archive/2026-05-04-report.md](./llm-upstream/archive/2026-05-04-report.md)

维护规则：

- 新会话 prompt 只引用 `session-brief.md`，不要把历史报告整篇塞进上下文。
- 当前状态只更新 `status.md`。
- 只有大规模重新调查时才新增 `archive/` 报告。
- 本文件仅保留为旧路径兼容入口。
