# LOCA workflow 插件（里程碑门控增量审核）

第三版 LOCA 工作流。设计文档：`docs/loca-workflow-design-v3.zh-CN.md`；第二版实现归档于 `archive/loca-v2/`。

该实现运行在 Aether 现有插件、agent、command 和 skill 扩展接口上，不修改 Aether 内核、数据库 schema、SDK 或前端。`workflow.json` 由本插件解释。

## 安装（开发仓库内）

本仓库重启 Aether 项目实例即可加载。复制到其他项目用仓库根的 `install_loca.sh`：

```sh
./install_loca.sh /path/to/target/project
```

然后在目标项目重启 Aether，输入：

```text
/loca
目标：计算二维伊辛模型在临界点的比热奇异性指数并给出数值验证。
验收标准：
1. 给出指数的理论推导与最终值（含误差或适用域）。
2. 提供可重跑的数值验证程序，其结果与理论值一致。
3. 交付推导文档、验证代码与执行记录。
```

## 与 v2 的结构对照

| v2（produce-then-review）            | v3（里程碑门控增量审核）                             |
| ------------------------------------ | ---------------------------------------------------- |
| explore → attack → assemble 串行攻坚 | planner 问题图 + frontier 事件驱动并行求解           |
| split 全量 DAG 拆分                  | solve 增量申报里程碑（结论级账本）                   |
| 每块 3 席 panel 全量条件式审核       | e2e 验证器沉淀（一次性审计 + 重跑）为主，unit 按需   |
| inputs/replay 端口审核               | pre-flight 版本核对 + e2e 独立性                     |
| 审核失败整轮回 solve                 | triage A/B/C：补洞 / 局部重做+三态刷新 / 回滚+replan |
| 串行等待审核                         | 快检硬门禁 + 深审并行推测执行（深度可配）            |

## 模块

```text
.aether/plugins/loca.js        插件入口（工具边界、上下文隔离、UI 进度）
.aether/agent/loca*.md         主入口 + 12 个角色定义
.aether/command/loca*.md       五个命令
.aether/skills/loca-workflow/  使用技能 + 运行说明
.aether/workflow/loca/
  workflow.json                 策略（并发/深度/预算/检查清单）
  engine.js                     frontier 事件驱动调度机 + 角色任务
  milestone.js                  注册表、传播（B 三态/C 回滚）、强度链
  graph.js                      计划图校验、pre-flight、推测预算
  runner.js / store.js          隔离会话调度 / SQLite 账本（v2 骨架 copy 改造）
  execute.js                    OS 沙箱执行（v2 copy 改造）
  schema.js                     角色输出 schema + id 自愈
<项目根>/loca/
  .runtime/                     私有运行数据（Git 忽略）
  results/<run>/round-*/plan-*/ 交付物、summary.md、audit.json、evidence/
```

## 验证

```sh
cd .aether/workflow/loca
bun install
bun run check
bun test
LOCA_SANDBOX_TEST=1 bun test test/sandbox.test.js   # OS 沙箱（CI/嵌套沙箱环境跳过）
```

流程测试使用受控样例模型响应，检验控制器协议与分支（调度、传播、回滚、预算、恢复），不代替真实模型质量评估。
