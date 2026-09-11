# LOCA 运行约定

实现说明见项目 `.aether/workflow/loca/README.md`。该技能只说明怎样使用工作流；真正的状态迁移由插件执行，不由技能文本或主 agent 自行决定。

- `/loca` 输入目标和验收标准；`/loca-status` 查看记录。
- 后续意见成为新一轮合约，未撤销的旧标准继续有效。
- `/loca-cancel` 停止；中断后的 `/loca continue` 重新求解和审核；`/loca-accept` 才是人类明确接受。
- 审核角色使用隔离目录里的真实 Aether 会话，父子关系记在插件账本，不使用跨项目的原生 `parentID`。
- 仅允许当前角色的工具和已声明证据。未验证、未解决和预算耗尽均不能进入成功交付。
- 当前代码交付为完整文件/补丁，计算后端为 Python 标准库，二进制和 PDF 资料需先做可信文本提取。
- 运行数据在 `.aether/workflow/loca/.runtime`，成果及可携带审核包在 `results`；两者均被 Git 忽略。
