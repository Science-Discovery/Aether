# LOCA 运行说明

## 与 LOCA v2 的关系

LOCA（第三版）替代归档于 `archive/loca-v2/` 的第二版实现。核心差异：解答与审核交织（不再先产后审）、以里程碑为审核单位、程序化验证器沉淀、推测执行与 A/B/C 影响分级。设计文档：`docs/loca-workflow-design-v3.zh-CN.md`。两版可在同一 Aether 中共存（命名空间独立：`loca` / `loca_*` 工具、`/loca*` 命令、`loca/` 运行目录）。

## 一次运行的解剖

```
/loca <目标与验收标准>
  ├─ contract + fidelity        契约与忠实性（沿用 v2 语义）
  ├─ planner                    问题图：子问题 + 预期引用 + 预注册验证方案 + 目标抗失效性
  ├─ frontier（事件驱动循环）
  │   ├─ solve (attack/patch/refine/refresh/continue)   并行子问题，增量记账，申报里程碑
  │   ├─ anchor                 验证方案（计划锚实现 / 涌现锚独立提出）
  │   ├─ gate                   五判据裁决：promote / merge / continue
  │   ├─ vaudit                 验证器一次性审计（语义 + 阴性对照，观察到的 fail 必须真实）
  │   ├─ quick                  程序化快检（引擎直接执行验证器，exit 0 = pass）
  │   ├─ 深审（与下游 solve 并行推测）：e2e / branch(semi) / unit / adversarial / compat
  │   ├─ triage                 失败分类 A/B/C + 受影响集合
  │   └─ 传播：A→patch；B→refine+三态刷新（验证器重跑通过即止 / stale 复核 / 计划边自动消费新值）；C→回滚+replan
  ├─ integrate                  跨里程碑一致性 + 逐标准责任表 + 证据强度链
  └─ awaiting_human → /loca-accept
```

## 关键机制备忘

- **推测深度**（`workflow.json: depth`，默认 1）：允许越过几个仅快检未深审的里程碑继续下游求解。前提链上有任何未过快检的里程碑则硬阻塞。
- **验证器协议**：Python stdlib；读 `LOCA_INPUTS/manifest.json`（列里程碑产物的 id/hash/name/file）；exit 0 = pass。vaudit 阴性对照的执行记录退出码必须非零（引擎核验）。
- **B 类停止条件**：stale 沿账本传播，遇到"已验证且有 trusted 验证器"的消费者改为重跑其验证器；**重跑通过且前提无版本漂移/状态退化**才吸收传播。实现事实：propagateB 触发的重跑必然携带漂移或状态退化（消费者申报版本落后于前提新版本，或处于 stale 传染链），因此**传播路径上的重跑总是保守转 triage→refine**；重跑的执行记录作为 refine 的证据保留。吸收分支仅在"前提 verified 且版本与申报一致"时可达——当前传播机制无法构造该形态，保留它是为了未来验证器直接消费前提产物的扩展。
- **C 类选择性回滚**：仅 supersede 依赖闭包内的里程碑、中止闭包内在飞的推测性 solve；独立分支保留。回滚任务通过任务级 AbortController 单独中止（不影响整 run）。
- **强度链**：结论强度 = min(自身锚强度, 前提链最弱环节)。四档：programmatic > independent > crosscheck > weak。weak 不阻断过程，但交付责任表强制标注。

## 中断恢复

所有调度状态（计划版本、里程碑注册表、账本、验证器状态、子问题结果）持久化在 `loca/.runtime/state.sqlite` 的 run 行内；frontier 是状态的纯投影。恢复时在飞 job 标记 stale 并 abort 其会话，frontier 从持久化状态重新计算任务集合。中断恢复不消耗计划版本号（cycle 回退）。

## 命令与工具

| 命令                 | 行为                                   |
| -------------------- | -------------------------------------- |
| `/loca 目标与标准`  | 开始工作，或将新意见作为下一轮目标澄清 |
| `/loca-status`      | 查看阶段、里程碑注册表、调用预算       |
| `/loca-cancel`      | 停止当前工作，保留证据                 |
| `/loca continue`    | 中断后继续                             |
| `/loca-accept`      | 人类明确接受交付                       |
| `/loca-assumptions` | 查看假设清单                           |

| 工具             | 权限角色                   | 作用                                                 |
| ---------------- | -------------------------- | ---------------------------------------------------- |
| `loca`          | 主会话桥                   | 控制器入口                                           |
| `loca_source`   | 全部角色                   | 冻结 UTF-8 文件/HTTP 原文为证据                      |
| `loca_artifact` | solve                      | 注册不可变成果产物                                   |
| `loca_evidence` | 全部角色                   | 按区间读取冻结证据                                   |
| `loca_execute`  | solve/verify/vaudit/anchor | OS 沙箱执行 Python（验证器试跑、阴性对照、数值比较） |

## 已知边界（v3.0）

- 里程碑修订（B 类）后的深审是**全量重跑**该里程碑的深审组件，未做增量组件复用——验证器重跑是廉价的，LLM 组件的重跑成本在实测后优化。
- gate "merge" 固定折叠到同子问题的主里程碑；不支持跨子问题合并。
- 迟到结果守卫：任务执行期间里程碑被版本递增/回滚/刷新改写后，迟到的组件结果（深审各席、快检、gate 裁决）整体丢弃并记录 `stale_result_dropped` 事件——排空窗口竞态不产生状态覆盖。
- 程序层矛盾检测仅覆盖结构化声明量（values 字段的同符号异值）；语义矛盾依赖 compat 席。
- e2e 的 literature 锚引用文献时依赖 solve/anchor 冻结的来源证据；不自动检索。
- 单机 SQLite 账本；多实例通过租约互斥（沿用 v2）。
