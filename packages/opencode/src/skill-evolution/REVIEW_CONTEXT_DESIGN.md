# Skill 进化评审 — 强化「发给评审 AI 的上下文」设计文档

> 状态：**设计草案 v1**，待团队对齐后进入实现（实现走 TDD）。
> 读者：团队开发者 + 组会评审 + 照本实现的人（含 yolo 沙盒会话——它没有讨论上下文，本文档即唯一说明书）。
> 出处：2026-06-15 与用户复盘"评审 AI 到底收到哪些信息"（见 [`/home/zheng/code/transcribe/发给AI的信息清单.md`](../../../../../transcribe/发给AI的信息清单.md) 的实况盘点 + 真实 DB 例子）发现两处缺口：①评审 AI 看不到"已有哪些 skill"，落实不了导师 #3「优先改现成、别动不动新建」；②对话历史里工具调用**只有名字没有参数和输出**，而基础指令的 B 维度又要求 AI"指出一条成功的工具输出"，自相矛盾。
> 关联：本目录 [`review-agent.ts`](./review-agent.ts)（评审 prompt 构建）、[`constants.ts`](./constants.ts)（`SKILL_REVIEW_PROMPT_BASE` 基础指令）。本文档**只改"喂给评审 AI 的输入上下文"这一块**，gate 判定逻辑、写作规则等全部沿用，不重述。

---

## 目录

- [设计原则](#设计原则)
- [解决了什么问题](#解决了什么问题)
- [现状 → 改后](#现状--改后)
- [对旧文件的修改](#对旧文件的修改)
- [核心机制详解](#核心机制详解)
  - [1. 给评审 AI 喂"已有 skill 清单"](#1-给评审-ai-喂已有-skill-清单)
  - [2. 对话历史补"工具参数 + 输出（截断）"](#2-对话历史补工具参数--输出截断)
- [格式样例](#格式样例)
- [核心不变量](#核心不变量)
- [决策记录](#决策记录)
- [开放问题](#开放问题)
- [关键文件速查](#关键文件速查)
- [复用组件核实（实现前必读）](#复用组件核实实现前必读)
- [命题清单](#命题清单)
- [测试与红绿里程碑](#测试与红绿里程碑)
- [范围说明](#范围说明)
- [用户体验](#用户体验)

---

## 设计原则

1. **只补输入、不动判定**：本次只把"已有 skill 清单"和"工具参数+输出"加进发给评审 AI 的 prompt，**不改** gate 四维度逻辑、不改写作规则、不改创建/覆盖行为。让 AI 在"看得更全"的基础上自己判，判据本身不动。
2. **截断防爆炸**：会话里存的工具输出**已被普通会话的 `Truncate.output` 封顶到 ≤50KB**（[truncate.ts:17-18](../tool/truncate.ts#L17)，超出部分甩文件、只留预览），但 50KB/条对评审仍太松。本次在其上**再收紧一道**：评审 prompt 里每条 output 只留 ~300 字、input 只留 ~200 字（**纯字符截断**，不甩文件——评审是一次性的，不需要再去 Grep 完整文件）。补证据是为了让 B 维度可判，不是把整段历史搬进来。
3. **最小改动、贴现有结构**：只改 [`review-agent.ts`](./review-agent.ts) 一个文件——升级 `collectCategories`、改消息映射、改 `serializeHistory`；复用现有 `buildReviewPrompt` 装配顺序，不新建文件、不改存储。
4. **best-effort、永不挡评审**：拿不到某条 skill 的 frontmatter / 某条工具输出时，跳过该条，绝不让评审构建报错。

---

## 解决了什么问题

### 顾虑 A：评审 AI 看不到"已有哪些 skill"（落实导师 #3）
- 现状：[`collectCategories`](./review-agent.ts#L125) 扫了所有 skill，**只抠 `category` 字段**去重成标签（如 `GitHub`/`Research`），prompt 里只给"有哪些类别"。**没有 skill 的名字、没有 description**。
- 后果：导师 #3「优先改现成、别动不动新建」**无从落地**——AI 根本不知道现成有哪些 skill、各干嘛，自然倾向新建。
- 真实佐证：[`发给AI的信息清单.md`](../../../../../transcribe/发给AI的信息清单.md) 第八节捞的真实 prompt，末尾就只有 `Available skill categories: GitHub/Testing/Skills/Research`。

### 顾虑 B：判"已验证"却看不到证据（修自相矛盾）
- 现状：[`serializeHistory`](./review-agent.ts#L101) 渲染工具调用时**只有 `name` + `id`**；消息映射 [`review-agent.ts:221-229`](./review-agent.ts#L221) 把 part 的 `state`/`output`（工具的输入参数、返回结果）直接丢掉。
- 后果：[`constants.ts`](./constants.ts) 的基础指令 B 维度明文要求 AI "point to at least one tool-call output that SUCCEEDED" ——**指令要的证据，材料里根本不存在**。AI 只能靠猜，B 维度形同虚设。
- 真实佐证：同上第八节，4 次 `webfetch` 在 prompt 里只剩 `<tool_call name="webfetch" id="..."/>`，查询词和返回全无。

> 数据本来就有：工具输出存在源会话的 part 里（`state.output`，实测可取），构建 prompt 那一刻 `rawMessages` 手里就有，是映射那步丢了。所以"补回来"只是不丢，不是去别处捞。

### 本次【不】解决（留给后续，见[范围说明](#范围说明)）
- 创建时"别静默覆盖同名 + 相似时拦一道"的系统侧闸（`skill-manage-tool.ts` 的 `handleCreate` 不查重直接覆盖）——另一处文件、另一个主题，单独做。
- 导师 #6「创建两次才启用」——更大的功能，单独设计。
- ID（#7）/ 每 skill 套 git（#8）/ 判好坏（#10/#14）——导师明确降级或 `.versions` 已覆盖，本次不碰。

---

## 现状 → 改后

| 维度 | 现状 | 改后 |
|---|---|---|
| 评审 AI 知道的"已有 skill" | 只有分类标签（`category`） | **完整清单：每个 skill 的 name + description + category** |
| 工具调用在历史里 | 只有 `name` + `id` | **加上输入参数 + 输出（各自截断到上限）** |
| B 维度可判性 | 无证据，形同虚设 | 有（截断的）成功输出可指认 |
| 改动文件 | — | 仅 [`review-agent.ts`](./review-agent.ts) |

---

## 对旧文件的修改

> 每处标注 **侵入式**（改了旧行为，有回归风险）还是 **增量式**（只加内容、旧路径不变）。

| 旧文件:位置 | 改什么 | 性质 | 依据 |
|---|---|:---:|---|
| `review-agent.ts` **新增** `collectSkillInventory` + `serializeSkillInventory` | 只扫子项目进化区，收集每个 skill 的 `name`+`description`+`category`，渲染成"已有 skill 清单"段 | **增量式**（新函数，旧 `collectCategories` 不动） | D1/D5 |
| [`review-agent.ts :: collectCategories`](./review-agent.ts#L125) | **保留不动**（分类标签仍服务基础指令里"按列表给 skill 归类"的 `category` 字段要求，D4） | 不改 | D1 |
| [`review-agent.ts :: buildReviewPrompt`](./review-agent.ts#L152) | 在分类标签段之后**追加**一段"已有 skill 清单" | **增量式**（加一段，原段落不动） | D1 |
| [`review-agent.ts` 消息映射 `:221-229`](./review-agent.ts#L221) | 保留 part 的工具 `input`/`output`（不再只取 type/text/tool/callID） | **增量式**（多带字段） | D2 |
| [`review-agent.ts :: serializeHistory`](./review-agent.ts#L101) | 工具节点渲染出"输入参数 + 输出"，各按上限截断 | **侵入式**（XML 节点内容变） | D2/D3 |

---

## 核心机制详解

### 1. 给评审 AI 喂"已有 skill 清单"

- **新增** `collectSkillInventory(folderName)`，**只扫当前子项目进化区**一个目录：`Spawner.skillEvolutionDir(folderName)` → `~/.local/share/aether/skill-evolution/<项目ID>/skills/`。**不扫**全局、**不扫**共享区（D5）。
- 每个 skill：`name` 取目录名，`description`/`category` 用项目标准解析器 [`ConfigMarkdown.parse`](../config/markdown.ts#L71)（gray-matter）从 SKILL.md 取 `md.data`——**只读 `---` 块**，不会误抓正文里的 `key:` 行（D6）。
- `serializeSkillInventory` 把清单渲染成一段，在基础指令的分类标签段**之后追加**（不替换分类标签——后者仍服务 `category` 字段指令，D4）。格式见[下文](#格式样例)。
- best-effort：读不到/解析不了的 skill 跳过；目录不存在 → 空清单（渲染成 "(none yet)"）。

### 2. 对话历史补"工具参数 + 输出（截断）"

- 消息映射保留每个工具 part 的 `state.input`（调用参数）和 `state.output`（返回结果）。
- `serializeHistory` 渲染工具节点时带上二者，**纯字符截断**：output 留前 ~300 字、input 留前 ~200 字，超出加 `…[truncated N chars]` 标注（不甩文件，D3/Q1）。
- 仅渲染有意义的工具结果；拿不到 output 的（如还在跑、被压缩）按"无输出"渲染，不报错。

---

## 格式样例

**改后的"已有 skill 清单"段（替换原 `Available skill categories`）**：

```
Existing skills in this project (prefer EDITING one of these over creating a near-duplicate):
  - ai-qft-survey [Research]: Survey the frontier of AI + quantum field theory…
  - ai-architecture-research [Research]: Investigate AI system architecture papers…
```
（只列当前子项目进化区的 skill；全局/共享区的不列。）

**改后的工具节点（对话历史里）**：

```xml
<tool_call name="webfetch" id="call_FKR...">
  <input>{"url":"https://arxiv.org/list/hep-th/recent"}</input>
  <output>Status 200. Recent submissions in hep-th: … …[truncated 8421 chars]</output>
</tool_call>
```

---

## 核心不变量

1. **只补输入、判定不变** — gate 四维度、写作规则、创建/覆盖行为一行不动（D1/D2 只动 prompt 装配）。
2. **输出有界** — 每条工具输出/参数渲染长度 ≤ 上限；prompt 不会因单条巨型输出而爆炸（D3）。
3. **best-effort** — 任一 skill frontmatter 或工具输出取不到 → 跳过该条，构建不报错（设计原则 4）。
4. **范围不变** — skill 清单扫的还是原来那 3 个目录，不新增扫描面（机制 1）。

---

## 决策记录

> 本文档自有编号 D1…，与 IDLE/SESSION_USAGE 的 D 编号互不干扰。

- **D1：在分类标签段之外【新增】一段"完整 skill 清单（name+description+category）"，不替换分类标签。** 原因：只给 category 落实不了 #3；给名字+描述 AI 才知道"现成有啥、改哪个"。分类标签**保留**——基础指令仍要 AI"按这个列表给新 skill 归类"，二者用途不同。属增量式（加一段 + 加新函数，旧路径不动）。**实现已落地，见 `review-agent.ts` 的 `collectSkillInventory`/`serializeSkillInventory`。**
- **D2：对话历史补工具的 input+output。** 原因：B 维度要证据、材料里却没有，是自相矛盾的真 bug；数据本就在 part 里，只是映射丢了。
- **D3：工具输出/参数用「纯字符截断」，不复用 `Truncate.output` 的甩文件那套。** 现成的 `Truncate.output` 会把超长内容甩到磁盘文件、再给模型留一句"用 Grep/Read 看完整文件"——那段提示每条约 40~60 token，对一次性评审是纯浪费（评审不会去读那个文件）。纯字符截断只加一个 ~5 token 的 `…[truncated]` 标记，同样预览长度下更省 token。**已与用户对齐。**
- **D4：只改 `review-agent.ts` 一个文件，不动 `constants.ts` 的基础指令文本。** 原因：基础指令的 B 维度本身没错，错在没给它证据；补上证据即可，不必改指令。
- **D6：`collectSkillInventory` 用 `ConfigMarkdown.parse`（gray-matter）解析 frontmatter，不手搓正则。** 原因：code-review 发现手搓的 `^key:$/m` 正则会扫到正文行（frontmatter 缺该字段时把正文 `category:` 当成 skill 类别），且是项目里第 4 个 frontmatter 解析器。复用 `ConfigMarkdown.parse`（skill/index.ts 也用它）既只读 `---` 块根治该 bug，又消除重复。**已修，对应红绿测试 "does not read a `category:` line from the body"。**
- **D5：skill 清单只扫"当前子项目进化区"，不扫全局/共享区。** 原因：评审是针对这个项目、要防的是"在这个项目里又造一个雷同的"，比对对象就该是这个项目自己进化区里已有的 skill；全局区是用户手搓的、共享区是另一作用域，混进来既无关又拉长清单。**已与用户对齐。**

---

## 开放问题

- ~~**Q1：工具输出/参数各截断到多少字？**~~ **已定**：output 留 ~300 字、input 留 ~200 字，纯字符截断（放 `review-agent.ts` 模块常量，YAGNI 不进 config）。理由：评审只需判"这步成没成功"，预览越短越省 token（省 token 的主要杠杆是预览长度，不是截断方式）。
- **Q2：skill 清单是否需要总长上限？** 若某子项目 skill 很多，清单也会变长。暂定不设上限（当前每项目 skill 数很少）；若日后变多再加。**待定。**
- **Q3：要不要把"被用户关掉自进化"的 skill 也列进清单（只列、标注只读）？** 现在锁警告段已单独列了它们；清单段是否重复列、还是引用。倾向：清单段全列、锁警告段保留"禁止改"语义，二者不互斥。**待定。**
- **Q4（与系统提示的关系）**：`SystemPrompt.skills` 可能已在系统提示里列了可用 skill（[发给AI的信息清单.md 第七节](../../../../../transcribe/发给AI的信息清单.md) 的待验证项）。若已列，本次的清单段会与之**部分重复**。处理：本次仍在用户消息里显式列（确保 gate 一定看得到、且能加"prefer editing"的措辞），重复是可接受的冗余；要不要去重待那个实验结论出来再定。**待验证后定。**

---

## 关键文件速查

| 文件 | 作用 |
|---|---|
| [`review-agent.ts`](./review-agent.ts) | 评审 prompt 构建（本次唯一改动文件） |
| [`constants.ts`](./constants.ts) | `SKILL_REVIEW_PROMPT_BASE` 基础指令（本次不改，仅引用 B 维度） |
| [`review-agent.test.ts`](./review-agent.test.ts) | 现有测试（`serializeHistory`、prompt 装配已有用例，本次扩充） |

---

## 复用组件核实（实现前必读）

- **X1：工具输出确实存在 part 里，且已被 `Truncate.output` 封顶到 ≤50KB。** 实测 part 的 `data.state.output` 有内容（一次 skill 加载样本 ~20KB，未超 50KB 故整条留着）；普通会话写 part 前先过 [`Truncate.output`](../tool/truncate.ts#L141)（[prompt.ts:977](../session/prompt.ts#L977)），所以读到的就是 ≤50KB 的版本 → 我们在其上再纯字符收紧到 ~300 字（D3）。构建时 `rawMessages` 可取 → D2 可行。
- **X2：新增的 `collectSkillInventory` 只扫子项目进化区** `Spawner.skillEvolutionDir(folderName)`，取 `name`(目录名)+`description`+`category`；`collectCategories`（扫 3 个目录、只取 category）原样保留服务 category 字段（机制 1 / D5）。
- **X3：现有测试入口在 `review-agent.test.ts`。** `serializeHistory` 与"do not create 重复 skill"已有用例（约 line 80），新用例接着加。

---

## 命题清单

### PA. skill 清单
- A1. 改后 prompt 含每个已有 skill 的 name + description + category，而非仅 category。
- A2. 清单只覆盖当前子项目进化区的 skill（不含全局、不含共享区）。
- A3. 某 skill 的 frontmatter 解析失败 → 跳过该条，prompt 仍正常生成（不抛错）。

### PB. 工具参数 + 输出
- B1. 改后对话历史里的工具节点含 input 与 output。
- B2. 单条 output 超上限 → 被截断且带 `…[truncated]` 标注；长度 ≤ 上限。
- B3. 工具 part 无 output（如未完成）→ 渲染为"无输出"，不抛错。

### PH. 边界与失败用例（测试必须覆盖）
- H1. 三个目录都为空 / 无任何 skill → 清单段为"(no existing skills)"，不抛错。
- H2. output 为空字符串 / 超大字符串两个边界，截断逻辑都正确。
- H3. 一条消息里多个 tool_call，全部带上各自 input/output。

---

## 测试与红绿里程碑

> 走 TDD：每个里程碑先写红测试（证明现状缺它）、再实现到绿。先红后绿两次输出都要留。

### ⚠️ 假绿陷阱
- 测"行为不测实现"：断言 **prompt 文本里出现了 description / output 内容**，不要断言"调了某函数"。
- 必须有一条**先红**：在改 `collectCategories`/`serializeHistory` 之前跑，证明现在 prompt 里**没有** description、**没有** 工具 output（否则测试恒绿，没测到东西）。

### 红绿总览（按依赖排序）
1. **里程碑1（skill 清单）**：红——断言 `buildReviewPrompt` 输出含某已有 skill 的 description，现状失败；绿——升级 `collectCategories` 后通过。
2. **里程碑2（工具输出）**：红——构造一条带 `output` 的工具消息，断言 `serializeHistory` 输出含该 output 片段，现状失败；绿——改映射+渲染后通过。
3. **里程碑3（截断）**：红——超长 output 断言被截断到上限且带标注，现状（无截断逻辑）失败；绿——加截断后通过。
4. **里程碑4（边界）**：H1/H2/H3 各一条。

### 收尾验证
- 跑 `review-agent.test.ts` 全绿。
- 跑一次真实评审（可选），人眼看新 prompt 里清单段与工具 output 都在、且 output 被截断。

---

## 范围说明

**本次做**：只在发给评审 AI 的 prompt 里——①补"已有 skill 清单（完整 frontmatter）"②补"工具参数+输出（截断）"。仅改 `review-agent.ts`。

**本次不做**（留给后续独立工作）：
- 创建时"别静默覆盖同名 + 相似时拦"的系统侧闸（`skill-manage-tool.ts`）。
- 导师 #6「创建两次才启用」。
- ID（#7）、每 skill 套 git（#8）、判 skill 好坏 / 进会话看 transcript（#10/#14）——导师降级或 `.versions` 已覆盖。

---

## 用户体验

- 对你来说的变化：skill 自进化**少重复造**——评审 AI 现在看得见"现成有哪些 skill、各干嘛"，更可能去**改现成的**而不是又建一个雷同的；并且它判"这个方法验证过没有"时**有真凭据可看**（联网/命令的实际输出），而不是凭空猜。
- 没有界面变化；这是后台评审质量的改善。判定标准（什么该存什么不该存）不变，只是判得更有依据。
