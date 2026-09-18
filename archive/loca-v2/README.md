# LOCA v2 归档

这是 LOCA 工作流第二版实现（produce-then-review 批处理模型）的完整归档，2026-09-18 被 v3（里程碑门控增量审核）取代后停止维护。

- 设计文档：`docs/loca-workflow-design.zh-CN.md`（保留为历史基线）
- v3 设计文档：`docs/loca-workflow-design-v3.zh-CN.md`
- v3 实现：`.aether/plugins/loca.js`、`.aether/workflow/loca/` 等

## 内容

| 路径                    | 说明                                     |
| ----------------------- | ---------------------------------------- |
| `plugins/loca.js`       | 插件入口（原 `.aether/plugins/loca.js`） |
| `agent/loca*.md`        | 主入口与角色定义                         |
| `command/loca*.md`      | `/loca` 系列命令                         |
| `skills/loca-workflow/` | 使用技能                                 |
| `workflow/loca/`        | 引擎、调度、存储、沙箱、测试             |
| `install_loca.sh`       | 安装脚本                                 |

归档实现不做任何修复或演进；仅为对照组保留。测试依赖 zod：`cd archive/loca-v2/workflow/loca && bun install && bun test`。
