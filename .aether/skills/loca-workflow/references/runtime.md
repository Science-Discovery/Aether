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
- **B 类停止条件**：stale 沿账本传播，遇到"已验证且有 trusted 验证器"的消费者改为重跑其验证器；重跑通过且**前提无漂移**才吸收。漂移按**内容指纹**判定（语义核心）：账本在注册时记录前提的内容指纹（pcf）——版本前进但指纹一致（"确认不变"的刷新）→ 语义放行并吸收（记 `drift_bypass` 事件）；指纹变化或前提状态退化 → 阻断，走 triage→refine。这消除了旧实现中"确认不变也触发全链重审"的假阳性浪费。
- **C 类选择性回滚**：仅 supersede 依赖闭包内的里程碑、中止闭包内在飞的推测性 solve；独立分支保留。回滚任务通过任务级 AbortController 单独中止（不影响整 run）。
- **强度链**：结论强度 = min(自身锚强度, 前提链最弱环节)。四档：programmatic > independent > crosscheck > weak。weak 不阻断过程，但交付责任表强制标注。

## 中断恢复

所有调度状态（计划版本、里程碑注册表、账本、验证器状态、子问题结果）持久化在 `loca/.runtime/state.sqlite` 的 run 行内；frontier 是状态的纯投影。中断恢复不消耗计划版本号（cycle 回退）。

**job 级会话续传**：进程/实例中断后 continue，在飞 job（preparing/running/checking/correcting）标 `interrupted` 并**保留其隔离子会话与上下文目录**；frontier 重算任务时同 role+slot+packet 的调度命中该 job，向**原会话**发送带 resume 指令的 packet 继续未完成部分——已完成的轮次、已注册证据（loca_source/loca_artifact/loca_execute 产物按 job 字段回填 `produced`）全部保留，不重做。packet 变化（里程碑版本递增）或 epoch 前进（新用户输入）不命中：这些续传候选转 `stale` 归档，由重调度自然重做。用户 cancel、任务级 abort、watchdog stall/timeout 走 `cancelled`/`retrying` 路径，不受续传影响（新 attempt 新会话）。lease owner 带 pid 前缀：实例重启后立即接管死租约，不再等待 90 秒过期。

**timeout 继承**：因 backstop/绝对上限**健康超时**（非 stall/sandbox 挂死）的 attempt，重试的新 attempt 沿用原会话与上下文目录（correction 指示"从中断处继续，不要重做已完成检查"）。stall/sandbox 类超时（会话疑似挂死）仍走全新会话重试。

**statement 归一化**（v3.1）：patch/refine 重复申报里程碑时，命题文本先剥离轮次/审计叙述样板（"经第 N 轮…后维持"、"round-N patch 完成X后维持"）再比较。模型常把过程性叙述写进 statement——主干未变则沿用已 trusted 的验证方案（不重跑 anchor/vaudit），仅重跑快检与深审。

与旧语义（v2：中断即 stale + abort 会话整体重做）的差异：仅"进程死亡"场景改为可续传；`interrupted` 是 job 状态机的暂存态（`→ queued/preparing/stale`），其余状态转移不变。

**健康监控（活动语义）**：watchdog 是唯一的任务健康判定者——无流活动超 `idle`（默认 600s）判 stall 杀掉；沙盒执行期间 `loca_execute` 心跳（30s 续期 `activity[:exec]`）维持 executing 活性，executing 的 stall 上限抬高到 ≥600s。`timeout`（按角色 wall-clock 上限）**不杀活跃任务**：只在任务停滞时与 stall 判定同源生效；活跃但持续超过 `timeout×4` 的绝对上限才强杀（防 token 失控的病态循环，`backstop_hard` 事件留痕；软超额记 `backstop_soft`）。

## 命令与工具

| 命令                | 行为                                   |
| ------------------- | -------------------------------------- |
| `/loca 目标与标准`  | 开始工作，或将新意见作为下一轮目标澄清 |
| `/loca-status`      | 查看阶段、里程碑注册表、调用预算       |
| `/loca-cancel`      | 停止当前工作，保留证据                 |
| `/loca continue`    | 中断后继续                             |
| `/loca-accept`      | 人类明确接受交付                       |
| `/loca-assumptions` | 查看假设清单                           |

| 工具            | 权限角色                   | 作用                                                 |
| --------------- | -------------------------- | ---------------------------------------------------- |
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
