---
name: loca-workflow
description: 在 Aether 中使用 LOCA 里程碑门控增量审核工作流完成科研目标（里程碑、验证器沉淀、e2e/semi-e2e/unit 三级审核、A/B/C 影响分级）；适用于用户明确选择 LOCA 工作流、补充验收标准或查看 LOCA 审核记录。
---

通过 `/loca` 或 `loca` 主 agent 进入工作流。目标和验收标准直接来自人类消息，不要代填用户的接受决定。

1. 首次输入目标和可验证的验收标准；之后输入意见会开启新一轮，保留未撤销的旧标准。
2. 主 agent 只调用 `loca` 工具。插件负责计划图、并行求解、里程碑裁决（gate）、验证器实现与审计（anchor/vaudit）、快检与深审（e2e/semi-e2e/unit/adversarial/compat）、影响分级（triage A/B/C）与集成交付。
3. 审核与求解并行推进：里程碑通过快检后下游可推测执行（深度受限）；深审失败按影响分级处置——A 补洞、B 局部重做+下游三态刷新、C 回滚+重规划，均不盲目整体返工。
4. 查看 `/loca-status`；取消用 `/loca-cancel`。重启或中断后 `/loca continue` 从保留状态恢复（frontier 从持久化状态重建）。
5. 最后用户使用 `/loca-accept` 明确验收，或继续输入修改意见。沉默不代表接受。weak 证据链会在交付责任表中显式标注，由人类裁决。

角色输出必须通过 schema、证据 ID、完整检查项和阶段闸门。审核结论 FAIL 是合法审核结果，不得以重试/投票抹去。

实现和边界见 [运行说明](references/runtime.md)。完整配置位于 `.aether/workflow/loca/workflow.json`；agent 提示词位于 `.aether/agent/loca-*.md`。没有原生 workflow 文件加载器，JSON 由 `.aether/plugins/loca.js` 加载并执行。
