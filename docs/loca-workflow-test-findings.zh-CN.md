# LOCA 工作流测试问题与后续方向（2026-09）

本文归档子阶段化 solve 改造（explore → attack×N → assemble）前后真实任务测试中发现的问题、已实施的修复与未决事项。测试任务：NRQCD 三线函数红外发散方向无关命题的任意圈证明（GLM-5.3，zhipuai-coding-plan）。

## 一、背景：为什么拆分 solve

单体 solve 在实测中暴露三个结构性缺陷，均在数据中得到验证：

1. **上下文单调膨胀**：单会话累计 input 达 351K token，attempt 重启后大量重读同一批证据
2. **阶段内零可见性**：solve 一跑数小时，用户只能看到工具计数缓慢增长
3. **长流式停滞损失**：provider 约 5-7 分钟静默掐断长流，单次 attempt 的全部生成成果蒸发（实测 433s 零 token 撞墙、115K output 报废）

拆分为 explore（勘察规划）→ attack×N（串行攻坚，粗粒度子问题）→ assemble（汇编）后，三者分别得到解决：上下文按子问题有界、subresults 提供子问题级可见性、停滞损失限定在单子问题尝试内。

## 二、已发现并修复的问题

### A. 架构/引擎层（子阶段改造引入，均已修复并有实战验证）

| 问题                       | 现象                                                                                                        | 修复                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 工具角色门遗漏             | `loca_artifact`/`loca_execute` 内部仍硬编码 solve-only；attack 写出通道全关，模型被迫在 reason 字段内嵌全文 | 角色门更新为 attack/assemble；修复后 S1 立即一次通过                                                                          |
| 引用校验漏网               | `artifacts`/`artifact` 字段未纳入 references() 校验，文件名毒化 packet 构建导致整轮崩溃                     | 校验扩展至三类字段，报错附"did you mean"候选与注册清单                                                                        |
| attack 耗尽崩溃整轮        | 一个子问题三次尝试失败 = 全轮报废                                                                           | catch 后记录 failed 状态继续后续子问题；plan 复用时 failed 项自动重试                                                         |
| 跨周期重规划重置进度       | 基础设施失败（packet 崩溃/停滞耗尽）恢复后已完成的子问题被重做                                              | plan 以 round+planInvalid 判定复用；仅质量反馈（assemble working）或新输入才重规划。实测：C1 汇编耗尽后 C2 复用原计划直攻汇编 |
| `artifacts` 缺字段高频报废 | 模型省略字段整次尝试作废                                                                                    | schema 默认空数组（产物要求由 claims↔artifact 绑定校验兜底）                                                                 |

### B. 运行时/平台层（均已修复）

| 问题                     | 现象                                                                                           | 修复                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| SDK 静默丢弃 AbortSignal | 超时中止后 HTTP 请求永不结算，await 永久挂起（曾卡死 65 分钟）                                 | runner 客户端 Promise.race 兜底                                  |
| 无头子会话权限挂起       | read/glob 的 external_directory 询问无人应答（evaluate 的 findLast 语义使默认 ask 压过 allow） | 子会话规则末尾显式放行；实测读取秒级                             |
| webfetch 询问 60s 超时   | loca_source 抓 URL 全部失败                                                                    | 子会话预授权 webfetch                                            |
| 流停滞无检测             | provider 掐断后静默等待                                                                        | 看门狗：5 分钟零增量中止重试；沙箱执行中放宽至 10 分钟           |
| 沙箱执行挂死烧预算       | 汇编验证代码死循环，执行豁免 30 分钟白烧                                                       | 豁免上限降至 10 分钟；被杀报错附带改写指引（分阶段、加循环上界） |
| packet 超限              | 字符计数 vs 字节校验 3 倍差；90+ 资产的胖存根叠加越限                                          | 字节计量 + 60% 余量 + 最新优先内联 + 瘦存根                      |
| 纠错信息不可行动         | "expected object" 类报错模型无从改正                                                           | StructuredOutput 缺失/问题保留/执行被杀均改为带具体要求的反馈    |
| 报错措辞逃出重试分类器   | 新报错不含"timeout"字样直接 error 不重试                                                       | 措辞对齐分类器                                                   |

## 三、未决问题（模型能力层，非架构缺陷）

1. **assemble 验证代码挂死（主要瓶颈）**：五轮 assemble 尝试中约 2/3 死于模型自写验证代码死循环/无界计算，10 分钟被杀后重试仍写类似代码。纠错反馈已附改写指引，收效有限
2. **幻影 artifact ID 固执**：模型反复引用一个从未存在的 ID（`artifact:f826e7a4...`），纠错清单给出正确候选后仍在后续尝试复用旧错——错误信息在 correction 链中自我强化
3. **标识符纪律**：自造 `inline:`、文件名+锚点等引用形式，自纠清单已把代价降到一次重试，未根除
4. **provider 长流稳定性**：zhipuai-coding-plan 约 5-7 分钟静默掐断是外部约束，工作流只能检测止损

## 四、后续工作方向（按优先级）

1. **assemble 减负（结构微调）**：验证计算下放回 attack 阶段——assemble 只做组合与覆盖检查，不执行代码。消除主要瓶颈（**已实施** 2026-09-16：engine.compute 角色门、插件工具白名单、assemble/attack 角色定义同步收紧；attack 定义明确承接全部计算验证职责并要求分阶段有界代码。实战验证：C7 assemble 两试即过、零执行调用，旧瓶颈消除）
2. **幻影 ID 防御**：packet 中资产清单按名称建索引；报错时按"名称最近匹配"给出唯一候选并要求逐字复制；correction 链截断旧的自身错误引用（**已实施** 2026-09-16：`schema.js` references() 重写——40 个 ID 的清单墙改为唯一候选 + 逐字复制指令；实测 C8 两个 assemble 死因即此）
3. **assemble 分包**：若仍重，把汇编拆为 per-criterion 覆盖检查（并行小会话）+ 最终汇总两步
4. **攻击前代码审查**：attack/assemble 的 loca_execute 前置静态检查（循环上界、预估规模），沙箱内分阶段执行
5. **父会话 relay 停滞看门狗**：命令层 provider 停滞仍无覆盖（GUI 表现为永久转圈），需插件层父会话活动检测
6. **心跳显示遗留 bug**：角色内 tool/turn 事件驱动的气泡更新曾验证部署但未落地（title 停留在 job 初值），待插桩定位
7. **文档同步**：README/设计文档尚未反映子阶段架构

| continue 烧 cycle 编号 | 意外中断（infra 错误/限额/abort）后 continue 也 +1 cycle：C8→C9→C10 编号无语义且白白消耗 cycles 修复预算（耗尽即终局失败） | act() 入口判定：unfinished/cancelled 且无新人工输入 = infra 恢复，回滚 cycle-- 从中断编号续跑（发 `resume` 事件）；质量修复轮（有 pending 输入或 assemble working）仍正常 +1 |
| 跨会话恢复缺失 | run 与创建它的会话绑定（runs.session UNIQUE）：新会话发 /loca continue 只得到"请输入目标与验收标准"，还会残留一个空 run 行（9.16 auto-run 空行即此）；状态机被会话历史绑架 | 状态机改为项目为准：act() 对 work/status 均回退 `current()` 解析项目当前 run 并 `adopt()`（run 行 re-key 到驾驶会话，清空残留孤儿行，active/lease 一并迁移，发 `adopted` 事件）；capture() 对裸 continue 不再创建空 run 行 |

## 四A、二轮修复（2026-09-16 晚，实测反馈驱动）

| 问题                 | 现象                                                                                                                           | 修复                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| planInvalid 永不清除 | 一次 assemble "working" 后，每次 continue/新 cycle 都强制重跑 explore，已完成的阶段结果被规划作废（C9/C10 全部重头"勘探规划"） | 重规划消费后立即 `run.planInvalid = false`（engine.js）；持久状态同步清理                                                                                                                          |
| 增量修复语义缺失     | assemble 发现缺口后，下一轮攻击重做整个子问题而非补缺口                                                                        | 新增 `engine.refine()`：working 子结果作为 prior 基线注入 attack packet（`prior` + `feedback` 字段，明示"禁止重做已完成内容"）；attack 角色定义同步更新                                            |
| UI 阶段清单失真      | run 终止（unfinished/cancelled）后 UI 仍按最后心跳 phase 打勾到"待人工验收"                                                    | 插件在 act() 结束后补发终态 metadata 帧；UI 检测 terminal phase 修正打勾与标题                                                                                                                     |
| 状态文本不可读       | 原因串嵌套全部纠错链 + 40 个 ID 清单，无换行                                                                                   | `Engine.explain()`：取第一条具体原因（跳过"Role X exhausted"包装），ID 折叠、240 字截断、剩余计数；status() 改行数组渲染，含最近 8 条阶段纪要                                                      |
| 过程零可见性         | 用户只能看到阶段名，不知道每阶段干了什么                                                                                       | 引擎在合约/规划/每个子问题攻击/汇编完成点发 `stage` 事件（一行人话纪要）；插件实时推入工具 metadata（`stages` 数组 + title 计数）；UI 在阶段清单下方渲染"阶段纪要"列表；最终工具输出 = 纪要 + 状态 |
| 父会话 provider 混用 | /loca 命令走 parent 会话模型（zhipuai 配额耗尽 429），子角色会话却是 alibaba —— 前端显示"provider 达到限额"但 run.model 正确   | continue 时显式传 `model: "alibaba-cn/glm-5.3"`（CommandInput.model 支持）；根因是 lastModel 回退，长期需 command 定义固定模型                                                                     |

## 四C、四轮修复（2026-09-17 晚，长跑 C1 实测反馈驱动）

| 问题                               | 现象                                                                                                                                             | 修复                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只读查询会"认领" run               | /loca-status 的 GUI 会话触发 adopt() 把 run 重键到自己名下，真正驾驶会话随后查不到 run → 桥接模型同轮连调 loca 约 25 次，UI 渲染一串 R0C0 空态卡 | 根本性改造：**项目状态优先**——run 身份 = 项目 state.sqlite 里的 run 行本身，`act()/capture()` 一律经 `current()` 解析同一个 run；run.session 降级为"最近驾驶者"（仅记录、不作为身份/查找键）；删除 adopt() 全部所有权语义；lease/abort 仍按驾驶会话做在途控制 |
| UI 全打勾空态卡                    | meta.phase 为 undefined 时 indexOf(undefined)=-1 被解释为"已到终态之后" → 全部 ✓                                                                 | UI：phase 未知 → 全部待办                                                                                                                                                                                                                                     |
| 幻影 ID 残留                       | 与自动纠正完全无关的 id（如 05daf2a0…）无法自动猜                                                                                                | 保持拒绝+唯一候选反馈（正确行为：无法确定指向时拒绝比误改安全）                                                                                                                                                                                               |
| 退化候选                           | att2 提交 0 工件候选                                                                                                                             | solved() 工件保留守卫拦截（正常防护）                                                                                                                                                                                                                         |
| completed 带 open 矛盾             | att3 声称 completed 但 4 个 open 缺口                                                                                                            | solved() 质量门拒绝（正常防护）                                                                                                                                                                                                                               |
| assemble 冗余（实测 token 经济学） | att1-3 各 43-83 轮：bash 37/24/80 次（每次从零重拼物理文件）、loca_source 22 次（重抓已冻结网页）、输入上下文每次 128K-176K 全量重读             | assemble packet 新增 `deliverables`（已存在物理产物清单），角色定义禁止重拼/重跑/重抓已满足项                                                                                                                                                                 |

## 五轮修复（2026-09-17 深夜，用户复盘讨论驱动）

| 问题                             | 现象                                                                                                                                                                     | 修复                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 每次尝试换新会话丢上下文         | 协议拒绝（幻影 ID/schema/质量门）后重试开全新子会话：失败尝试的上下文全部丢失，模型重复同类错误                                                                          | `runner` 会话内纠错环：协议错误以 correction 消息**重发同一子会话**（历史完整保留，只携带错误文本，成本低）；infra 错误（超时/停滞/中止）仍换新会话                                                                                  |
| 十六进制 id 强迫模型当抄写员     | 64 位 id 逐字抄写是幻影 ID 的根源                                                                                                                                        | **名称为主引用**：evidence/claims 优先写自然名称（如 `code/verify_one_loop.py (rev 3)`），验证器经名称索引解析为 id；名称歧义才要求 id；runner heal() 与 references() 均支持名称解析；五个角色定义同步告知"名称优先，勿拼造十六进制" |
| "completed 带 open 矛盾"语义厘清 | att3 唯一 open 项是"环境性登记"（loca_execute 白名单拒收 9 件批量输入的备案，实际工作已用替代通道完成），模型视为非判定缺口提交 completed，引擎按"全部 closed"硬规则拒绝 | 保持质量门（正确），但已确认这是语义错位：环境性事项不应记为 problems（属 notes/assumptions），后续在角色定义中引导                                                                                                                  |
| 工件丢弃守卫过度限制             | 模型判定前轮工件无效时应有充分自由度，硬性"丢失过半即拒"反而阻塞合理重构                                                                                                 | 移除 drop 守卫；改为**候选账本**：每次 assemble 接受时把前一候选按轮次归档（`run.candidates`：cycle/status/artifacts/problems/superseded_by），任何"被退役"工件可随时恢复查阅，绝不原地覆盖                                          |
| loca_execute 输入白名单错位      | 输入校验用"本会话 packet 资产"作边界，早期会话的冻结资产被整单拒收（9 件批量输入报"undeclared inputs"），迫使模型用 loca_source 同 hash 重冻结绕路                       | 校验边界改为**run 资产库**（冻结即合法），报错附未注册清单与注册指引；同原则连带修复 loca_evidence（跨会话读取合法）与 StructuredOutput 引用校验宇宙（并上 run.assets）                                                              |

## 六轮修复（2026-09-17 夜，"限制权限类守卫"系统性审查）

用户原则：**不该属于限制 agent 权限的问题，不得用限制权限粗暴实现**——模型的判断是职权，引擎的职责是保全与兜底。全量审查 79 个 throw 点后的改造：

| 原守卫                                    | 问题                                                           | 改造                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "attack claims 必须只指向自己的 criteria" | 修复轮常顺带建立属于其他子问题标准的断言——这是真实进展不是违规 | **断言改道**：接受外指断言，记 claim_reroute 事件并注入 feedback（负责该标准的子问题下轮吸收）          |
| "子问题只能依赖更早的子问题（串行序）"    | 前向依赖是规划者的架构选择                                     | 只拒绝未知依赖；前向依赖记录为排序建议，串行执行器按依赖可得性供证据                                    |
| "只有 attack/assemble 可注册 artifact"    | explore 的图谱笔记、validate 的脚本同样是合法不可变产出        | 任何控制器创建的角色都可注册 artifact；**候选归属权**仍归 assemble 的 StructuredOutput（注册≠入选候选） |
| "问题每轮最多 8 个"                       | 对话澄清的硬上限过紧                                           | 提至 16（唯一 ID 仍强制——身份完整性）                                                                   |

保留的 throw（有正当理由）：防伪造类（claims-artifact 绑定、criterion 出处引文、execution 证据要求、引用完整性）、账本不可变（loca/.runtime）、用户显式设计（assemble 无执行权限=减负决策）、基础设施保护（packet 上限、资产大小、输入数 64）。另修复 heal() 漫游 bug：名称解析只作用于 evidence/artifacts/artifact 引用字段（曾把 review 检查项语义 id "fidelity" 改写成同名 prompt 资产 id）。

## 七轮修复（2026-09-17 深夜，完备性审查）

全量审查发现**会话内纠错环从未真正生效**（用户要求的核心语义）：`store.job` 状态机没有 `checking → correcting` 边——correction() 内部的状态写入抛 `Illegal supervisor transition`，异常逃逸到外层 attempt 循环换新会话，纠错降级为普通重试。测试桩毒化验证暴露后修复：

| 问题                            | 根因                                                             | 修复                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话内纠错静默失效              | job 状态机缺 `correcting` 边，correction 内 store.job 抛异常逃逸 | 状态机加 `checking→correcting`、`correcting→{checking,accepted,rejected,error,stale,cancelled,exhausted}` 边；外层 catch 把 `correcting` 与 `checking` 同类处理（协议类可重试） |
| 验证游离在纠错环外              | schema/references/check 校验在 turn 循环之外，协议错误直接换会话 | 校验全部移入 turn 循环内（zod 报错、幻影 ID、质量门拒绝都走会话内 correction）                                                                                                  |
| `?? 0 > 0` 优先级 bug           | `(a ?? 0) > 0` 被写成 `a ?? 0 > 0`，executing 语义错误           | 加括号恢复                                                                                                                                                                      |
| guard/epoch 按会话查 run        | run.session 重键后 guard 读错行                                  | `store.byId(run.id)`；guard、外层 catch、current() 全部改按 run id                                                                                                              |
| active 控制器按会话键控         | 会话重键后原驾驶会话的 abort 手柄失联                            | active 以 **run id** 为键（附 session 记录），abort/cancel/double-drive 检查全部经 run id                                                                                       |
| id_repair 事件被误并为 job 事件 | 重构时事件 kind 被改写                                           | 恢复独立 `id_repair` kind                                                                                                                                                       |

新增回归测试：毒化首次 attack 提交（幻影 artifact 引用）→ 断言纠错与原提交命中**同一子会话**、job 唯一且最终 accepted。

## 八轮修复（2026-09-17 夜，二轮完备性审查）

| 问题                       | 根因                                                                                             | 修复                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| capture() CAS 竞态炸 hook  | 并发输入抢 epoch：save() 抛 "STALE" 逃逸到 chat.message 钩子，用户消息整体丢失                   | 包裹 try：被超越的输入记 `human_input_superseded` 事件让位（新 epoch 胜出本就是设计语义） |
| 会话重键只改列不改 JSON    | `UPDATE runs SET session` 只动列，data 列内嵌的 session 字段漂移（store.run 解析结果与列不一致） | 重键统一走 `store.save()`（列与 JSON 同步）；capture/act 双入口补 `driver` 事件           |
| packet() 资产过滤不容错    | 任一资产行缺失（手工恢复手术后会）→ 整个 packet 构建崩溃                                         | flatMap + try：不可读 id 静默剔除                                                         |
| deliver() 用 'wx' 独占写   | 崩溃恢复后同 cycle 目录重投递 → EEXIST 崩溃                                                      | 'w' 覆盖写（目录名含报告哈希，不同投递天然隔离；同投递内容确定性相同）                    |
| 会话内纠错静默失效（补记） | job 状态机缺 correcting 边                                                                       | 上轮已修，本轮补齐外层 catch 的 correcting 分类                                           |

审查同时确认的无问题项：abort 监听器泄漏有界（每 attempt ≤3 个一次性监听）、mergeProblems 必然收敛（每轮合并严格减长）、名称索引歧义组不解析（正确保守）、closest 阈值设计合理。

## 九轮修复（2026-09-18 凌晨，三轮完备性审查）

| 问题                               | 根因                                                                                                                                                                                           | 修复                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **纠错环在生产管道必炸**（最严重） | `chat.messages.transform` 强制子会话只能有一条 user 消息：纠错第二轮起历史里就有 2+ 条 → "Unexpected input injected" 抛出。mock 测试绕过了真实会话管道所以没暴露——纠错语义在生产中从未真正可用 | transform 改为只重写**最后一条** user 轮（packet 轮原样保留，纠错叠加式追加）；新增对应回归测试  |
| 中断恢复漏掉 correcting 态 job     | work() 恢复过滤器只认 preparing/running/checking——纠错中被打断的 job 永远卡在 correcting（子会话可能还在裸跑）                                                                                 | 过滤器加入 correcting（状态机已有 correcting→stale 边）                                          |
| 落败 worker 的收尾路径崩坏         | 被超越（epoch STALE）的 worker 在 catch 里 store.move→save 再次 CAS 失败 → 异常穿透错误处理 → 用户看到钩子错误而非状态                                                                         | move() 容忍 CAS 失败：记 `superseded_transition` 事件退出（新 epoch 的 worker 才是状态机所有者） |
| 双 run 行风险                      | current() 在租约瞬态过期时可能漏检既有 run，新目标输入会再建 run 行（旧测试曾出现双行）                                                                                                        | create 前先查 latest() 兜底，任何 run 存在即复用                                                 |
| 报告资产与 run 行问题清单暂态分歧  | merge 在 acceptance 之后执行：报告资产存合并前清单，run 行存合并后清单                                                                                                                         | 确认为可接受设计（报告=append-only 历史，run 行=活状态），记录在案                               |

## 十轮修复（2026-09-18 凌晨，四轮完备性审查）

| 问题                             | 根因                                                                                                                                            | 修复                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 父会话工具过度门控               | `store.run(session) → 非 loca 工具全禁`：任何成为驾驶者的普通会话（如 GUI 里 /loca continue 的 build 会话）被剥夺全部常规工具——驾驶不是角色变更 | 引入 `orchestrates` 集合：只有 loca-agent 桥接会话才被限制为仅编排；驾驶会话保留完整工具箱       |
| feedback 永不清除                | assemble working 的反馈只在下次 working 时被覆盖：陈旧 findings 持续触发 refine 重攻、claim_reroute 追加无界增长                                | 子阶段 3（assemble）入口清空 feedback——本周期攻击已消费（packet 已携带），下一判定自会安装新反馈 |
| deliver 证据清单不容错           | run.assets 全量 asset() 读取，任一行缺失（恢复手术后）→ 整个交付崩溃                                                                            | flatMap + try 剔除不可读 id                                                                      |
| put() 每 asset 全量重写 run JSON | O(n²) 但语义正确；asset() 每次读 blob+哈希（400 资产 × 每轮校验）性能可接受                                                                     | 记录为已知性能特征，暂不改                                                                       |
| 跨进程双开                       | lease 90s TTL 不续约，active 是进程内的：同一项目两个服务器实例可同时驱动                                                                       | 单实例假设记录在案（lease.owner 字段已具备互斥扩展点）                                           |

| 问题                     | 现象                                                                                                                                                    | 修复                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completed 子问题缺口死锁 | S2 部分达标被标 completed，其缺口（P-G1）在 assemble 侧永久悬挂：attack 跳过 completed 子问题，无人修复，循环永不收敛                                   | assemble working 判定后按三重归属（问题 id 命名 P-<sub>-…、缺口证据 id ∈ 子问题 artifacts/claims、plan criteria 责任）重开 owner 为 working（artifacts 保留为增量基线）     |
| 问题清单膨胀惯性         | 模型每轮为同一缺口克隆新 id（P-G7b→-c7→…→-c12），防静默删除继承又把所有克隆塞回：open 12→23 只增不减；"（已关闭，历史确认维持）status=open"自相矛盾条目 | `graph.mergeProblems()`：id 前缀链或 detail 显式引用原 id 即合并到最短原 id（迭代至不动点）；关闭需 evidence 二次确认（closed 且无 evidence → open）；不做阈值强制收敛      |
| 角色无 bash 权限         | 物理文件拼接（PART 段落→完整文件）与端到端重放七轮无人执行：角色被设计禁止 bash，协议把物理交付推给"持执行权限角色"但该角色从未有效执行                 | attack/assemble 授予 bash；防改文件改用保护而非禁止：loca/.runtime 直接拒绝写入（不可变账本），其余现存文件被 bash 写前自动备份（file_backup 事件留痕）                     |
| 物理交付协议过严         | "干净目录冷启动+逐字比对"形式协议阻塞收尾                                                                                                               | 角色定义改为自行判断执行结果（exit code、通过数、与冻结登记一致性），判断依据写入 evidence                                                                                  |
| 汇报过于简洁             | 用户只看到阶段名                                                                                                                                        | 分层汇报：每阶段完成即写 `loca/.runtime/reports/R{n}C{m}-<stage>.md`（完成了什么/产出/详细阅读入口/下阶段计划）；GUI metadata 增加 summary+report 路径并在阶段清单下方渲染  |
| 步骤预算耗尽             | 重型子问题（S5 代码族）80 步内做 40+ 次工具调用后死掉，StructuredOutput 永远调不到                                                                      | attack/assemble steps 80→120 + 步骤纪律指令（剩 25 步停探索、剩 10 步必须提交）                                                                                             |
| packet 超限（长跑）      | 429 资产的存根字节未被内联预算扣除；assemble packet 的 subresults 全量+存根 197KB > 180KB 上限                                                          | packet() 预算扣除存根字节；cap 提至 256KB；assemble 保留完整 subresults（压缩曾致 0 工件退化候选，改用 solved() 的 artifact 保留守卫：新候选丢失过半前轮 artifacts 即拒绝） |

实测效果：C13 起死锁/膨胀/退化类失败全部消失，S5 在 120 步预算下首次完整交付（39 工件）。剩余失败模式：服务器重启打断在途会话（部署修复的代价，部署完毕后消失）。

## 五、测试基建（可复用）

- 自动化 harness：`/tmp/loca-repro/`（fire-and-forget continue + sqlite 状态轮询，永不自动中止）
- 检查点语义：infra 失败保全 plan/subresults；`/loca continue` 恢复
- 观测：watchdog 事件（idle/executing）、子问题状态、token 经济学分析脚本

## 六、自动化测试与监控方法（当前实操）

### 6.1 核心原则

1. **continue 必须 fire-and-forget**：`/loca` 命令的 HTTP 响应同步等待**整个工作流步骤**（solve 一步可达 30+ 分钟）。任何"超时即中止重试"的 harness 都会误杀进行中的合法工作（实测曾连杀三轮）。正确姿势：发出请求后立即返回，只靠数据库轮询判断状态
2. **永不自动中止**：中止判断只依据明确信号（终态 phase、看门狗事件、零事件超时），不依赖 HTTP 超时
3. **一切状态以 state.sqlite 为准**：`<项目>/loca/.runtime/state.sqlite` 是唯一事实源（runs/jobs/events/assets 四表），与 GUI/HTTP 层解耦

### 6.2 环境

```sh
# 后端（开发版，工作目录必须是仓库根）
env -u OPENCODE_SERVER_PASSWORD -u OPENCODE_SERVER_USERNAME \
  nohup bun run --cwd packages/opencode --conditions=browser \
  ./src/index.ts serve --port 4096 > server.log 2>&1 &

# 同步最新工作流代码到目标项目
./install_loca.sh /Users/lx/Desktop/code/AI/AI4research/NRQCDproof/
```

注意：调试 shell 若继承 `OPENCODE_SERVER_PASSWORD` 环境变量，启动的服务器会要求认证，GUI 将无法访问——必须 `-u` 清除。

### 6.3 启动测试

```sh
DIR=/Users/lx/Desktop/code/AI/AI4research/NRQCDproof
SID=$(curl -s -X POST "http://localhost:4096/session?directory=$DIR" \
  -H 'content-type: application/json' -d '{"title":"auto-run"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "$SID" > auto.sid
curl -s --max-time 10 -X POST "http://localhost:4096/session/$SID/message?directory=$DIR" \
  -H 'content-type: application/json' -d @newrun-req.json -o /dev/null
# 000 返回码是正常的（请求已受理，工作在后台执行）
```

输入文件 `newrun-req.json` 结构：`{"agent":"loca","model":{"providerID":"zhipuai-coding-plan","modelID":"glm-5.3"},"parts":[{file 附件},{text 目标与验收标准}]}`。

### 6.4 轮询与断点续传

每 5-10 分钟执行一次状态查询（纯 sqlite 只读，无副作用）：

```python
import sqlite3, json
db = sqlite3.connect("file:<项目>/loca/.runtime/state.sqlite?mode=ro", uri=True)
sid = open("auto.sid").read().strip()
run = json.loads(db.execute(
    "SELECT data FROM runs WHERE json_extract(data,'$.session')=?", (sid,)).fetchone()[0])
# 关键字段：phase（阶段）、cycle、calls、candidate（claims/artifacts 数）、
#          plan.subproblems、subresults（各子问题状态）、error
# jobs 表：role/attempt/status/error —— 看重试与耗尽
# events 表（按 seq 递增）：phase/job/watchdog/tool_started/turn/assumption
```

**里程碑信号**：phase 变化（explore→solve→assemble→split→…）、subresults 新增、candidate 落盘、error 出现。

**断点续传**（run 进入 unfinished/cancelled 后）：

```sh
curl -s --max-time 8 -X POST \
  "http://localhost:4096/session/$(cat auto.sid)/command?directory=$DIR" \
  -H 'content-type: application/json' \
  -d '{"command":"loca","arguments":"continue","agent":"loca"}' -o /dev/null
# fire-and-forget；infra 失败会复用 plan/subresults 检查点
```

### 6.5 深度诊断（排障时）

1. **角色子会话定位**：job 行的 `directory` 字段即上下文目录；其项目库路径为 `~/.local/share/aether/local/aether-$(shasum -a1 <<< 目录路径).db`，内含 message/part 表（每轮 token、每个工具调用的输入/输出/耗时/状态）
2. **停滞判定**：events 表最新 watchdog 事件的 `idle` 值（0-30s=健康流式；300s=普通停滞；600s=沙箱执行豁免中）
3. **工具失败现场**：子会话 part 表中 `state.status=error` 的工具及其 error 文本
4. **服务器健康**：`curl localhost:4096/` 无响应=进程崩溃（曾发生无日志 OOM），重启后 continue 即可（检查点保全）
5. **token 经济学**：子会话 message 表累计 input/output/reasoning，用于识别上下文膨胀与重读浪费

### 6.6 清理与归档

```sh
P=<项目根>; B=<项目根>-backup
chmod -R u+w "$P/loca/.runtime/contexts" 2>/dev/null   # 解除只读上下文目录
mv "$P/loca" "$B/loca-$(date +%Y%m%d-%H%M%S)"           # 整体归档到项目外
# 全新状态在下次 /loca 输入时自动重建；旧 GUI 会话只是聊天记录，无影响
```

单 run 清理（保留其他 run）：按 session 删 runs/jobs/events/assets 行 + 删除 contexts 下无 job 引用的目录。

### 6.7 监控节奏建议

- 常规：10 分钟间隔轮询，phase 变化或 error 时向用户汇报
- attack 阶段：关注 subresults 增量（每个子问题 15-40 分钟属正常）
- assemble 阶段：警惕连续三次同型失败（执行被杀/幻影 ID）——这是介入信号而非继续等待
- 每轮终态（unfinished/awaiting_human）必报：错误全文 + 检查点状态 + 建议动作

相关文档：[loca-workflow-design.zh-CN.md](./loca-workflow-design.zh-CN.md) · [loca-workflow-usage.zh-CN.md](./loca-workflow-usage.zh-CN.md)

## 十一轮修复（2026-09-18，五轮收敛确认审查）

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 普通会话闲聊被当作用户输入 | chat.message 的捕获条件含 `store.run(session)`：任何成为过驾驶者的会话，其日常对话全部被 capture 成 human_input（round++ 重开轮次） | 捕获条件收紧为**仅 loca-agent 桥接会话**：驾驶（任何会话可经 /loca）不改变会话角色，闲聊不是目标反馈；非桥接会话用 /loca 命令驱动 |

修正前轮误记：lease 存在 20s 心跳续约（acquire/heartbeat/release 生命周期完整）。交叉审查确认：accepted-run continue 返回状态不崩、cycle 回滚边界安全、solved 继承与 merge 顺序一致、纠错环与 transform 管道语义闭环、命令路由与捕获顺序正确。**判定：代码基本收敛**，剩余风险集中在未被实测覆盖的 split 后审核流水线，留待下次 continue 实测验证。