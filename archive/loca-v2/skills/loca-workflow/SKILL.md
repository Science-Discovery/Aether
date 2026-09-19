---
name: loca-workflow
description: 在 Aether 中使用 LOCA 工作流完成目标、模块化 DAG、独立验收和多 agent 审核；适用于用户明确选择 LOCA 工作流、补充验收标准或查看 LOCA 审核记录。
---

通过 `/loca` 或 `loca` 主 agent 进入工作流。目标和验收标准直接来自人类消息，不要代填用户的接受决定。

1. 首次输入目标和可验证的验收标准；之后输入意见会开启新一轮，保留未撤销的旧标准。
2. 主 agent 只调用 `loca` 工具。插件负责 solve、DAG、输入审核、独立验收、每块并行审核、核心概念追问和汇总。
3. solve 有已知问题就继续解决；无法完成只能停为 unfinished/needs_human，不能作为成功候选。
4. 查看 `/loca-status`；取消用 `/loca-cancel`。重启或中断后 `/loca continue` 从保留证据重新审核。
5. 最后用户使用 `/loca-accept` 明确验收，或继续输入修改意见。沉默不代表接受。

角色输出必须通过 schema、证据 ID、完整检查项和阶段闸门。审核结论 FAIL 是合法审核结果，不得以重试/投票抹去。

实现和边界见 [运行说明](references/runtime.md)。完整配置位于 `.aether/workflow/loca/workflow.json`；agent 提示词位于 `.aether/agent/loca-*.md`。没有原生 workflow 文件加载器，JSON 由 `.aether/plugins/loca.js` 加载并执行。
