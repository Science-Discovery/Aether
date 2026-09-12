# LOCA 工作流使用指南（新项目接入）

本文说明如何把 LOCA 工作流安装到一个新项目，并在 Aether 图形界面（GUI）中开始第一次运行。设计细节见 [loca-workflow-design.zh-CN.md](./loca-workflow-design.zh-CN.md)。

## 前置条件

- 本分支（或已合并 LOCA 插件支持）的 Aether 开发版：插件依赖目录级配置、插件 hooks 和 `session.prompt` JSON Schema 输出。
- [Bun](https://bun.sh) 运行时（安装插件依赖与执行工作流代码）。
- 目标项目路径（下文以 `/path/to/project` 为例）。

## 1. 安装

### 方法一：安装脚本（推荐）

在 Aether 源码仓库根目录执行：

```sh
./install_loca.sh /path/to/project
```

脚本会完成：

| 安装项           | 位置                            | 作用                                                    |
| ---------------- | ------------------------------- | ------------------------------------------------------- |
| 15 个 agent 定义 | `.aether/agent/loca*.md`        | 主入口 `loca` + 14 个独立角色（solve、split、审核等）   |
| 4 个命令         | `.aether/command/loca*.md`      | `/loca`、`/loca-status`、`/loca-cancel`、`/loca-accept` |
| 插件入口         | `.aether/plugins/loca.js`       | 消息捕获、工具边界、workflow 调度                       |
| 使用技能         | `.aether/skills/loca-workflow/` | agent 侧使用说明                                        |
| 工作流核心       | `.aether/workflow/loca/`        | engine/runner/schema 等实现与 `workflow.json` 配置      |
| 依赖             | `workflow/loca/node_modules/`   | 自动 `bun install`（zod）                               |

脚本可重复执行（幂等覆盖）；`.runtime/`、`results/` 等运行时数据不会被删除。

### 方法二：手动复制

复制以下内容到目标项目，然后安装依赖：

```sh
mkdir -p /path/to/project/.aether
cp -R .aether/agent/loca*.md /path/to/project/.aether/agent/
cp -R .aether/command/loca*.md /path/to/project/.aether/command/
cp -R .aether/plugins/loca.js /path/to/project/.aether/plugins/
cp -R .aether/skills/loca-workflow /path/to/project/.aether/skills/
cp -R .aether/workflow/loca /path/to/project/.aether/workflow/
cd /path/to/project/.aether/workflow/loca && bun install
```

### 安装后重启

Aether 按**项目目录**加载插件、agent 和命令。安装完成后必须（重新）打开该项目：

- 若项目已在 GUI 中打开，重启该项目实例（修改 `workflow.json` 或 agent 定义后同样需要重启）。
- 若之前从未打开过，在 GUI 中添加并打开该目录。

## 2. 切换到 loca 主 agent

`loca` 是 `mode: primary` 的主 agent，有两种使用方式：

### 方式一：选择 loca agent 后直接输入

1. 在 GUI 左侧确认当前项目是**安装了 LOCA 的那个目录**（目录即项目，agent 列表随目录变化）。
2. 新建会话，在输入框的 **agent/模型选择器**（composer 底部下拉）中选择 `loca`。
3. 直接输入目标与验收标准（见下节），无需任何前缀。

> 注意：`loca` 不会出现在输入框的 `@` 提及列表中——`@` 列表只显示 subagent 类型的 agent；主 agent 只能通过 agent 选择器切换。

### 方式二：直接使用 `/loca` 命令（无需切换 agent）

命令自带 `agent: loca`，在任意会话中输入即可：

```text
/loca <目标与验收标准>
```

如果 `/loca` 命令或 `loca` agent 没有出现，几乎总是目录问题：当前打开的项目目录不是安装目录（或其父级），也可能误开了同名/子目录项目。核对 GUI 地址栏或侧边栏中的项目路径后重开。

## 3. 设定目标与验收标准

每次 `/loca` 输入（或 loca agent 会话中的消息）由三部分构成：

```text
/loca
目标：<一句话说明要完成什么>
验收标准：
1. <可独立检查的标准一>
2. <可独立检查的标准二>
3. <交付物要求>
```

### 好的验收标准

验收标准是工作流的硬约束，会在三处被强制使用：solve 逐项自检、DAG 为每项标准建立独立验收节点、integrate 对照实际成果再检查。因此每条标准应当：

- **可验证**：能被独立执行/独立检查证实，而不是"写得清楚""质量好"这类主观描述。
- **可判定边界**：明确输入范围、边界样例和非法输入的处理。
- **指定交付物**：说明期望的产物形式（代码、文档、验证记录）与验证方式（独立方法复核、测试、可重放记录）。

### 示例

```text
/loca
目标：给出一个精确计算二项式系数的 Python 实现，并说明算法。
验收标准：
1. 对整数 0 <= k <= n 返回精确整数；非法输入明确报错。
2. 给出边界样例，并用独立方法验证 n <= 12 的所有合法输入。
3. 交付代码、说明和可重放的验证记录。
```

需要引用外部资料时，先提供可信提取的 UTF-8 文件及出处（solve 通过 `loca_source` 冻结为证据），不要只给链接。

### 后续输入

- **运行中的补充意见**：旧任务失效并停止旧会话；当前版本需再输入 `/loca continue` 启动新轮次。
- **正常交付后的新意见**：直接作为新轮次的目标澄清，未被明确撤销的旧标准继续有效。

## 4. 过程控制

| 命令             | 作用                                                         |
| ---------------- | ------------------------------------------------------------ |
| `/loca-status`   | 查看当前阶段、调用预算和执行验收状态                         |
| `/loca-cancel`   | 停止当前工作，保留已有证据和审核记录                         |
| `/loca continue` | 重启、中断或基础设施错误后继续；保留已用预算，重新求解与审核 |
| `/loca-accept`   | 人类**明确**接受已通过内部审核的交付                         |

两条重要规则：

- 沉默、取消或预算耗尽都**不代表接受**；只有 `/loca-accept` 是验收动作。
- solve 存在已知问题就会继续返工；无法完成只会停在 `unfinished/needs_human`，不会作为成功候选交付。

## 5. 产物位置

```text
.aether/workflow/loca/
  results/<run>/round-*/cycle-*/   # 交付物、summary.md、audit.json、evidence/
  .runtime/                        # 运行时私有数据（会话上下文、租约）
```

`summary.md` 按验收标准列出检查入口；`audit.json` 将证据 ID 映射到 `evidence/` 原始内容。运行记录默认不进入 Git。

## 常见问题

- **看不到 loca agent 或 `/loca` 命令**：确认 GUI 打开的项目目录就是安装目录；确认安装后重启过实例。
- **修改了 `workflow.json` / agent 定义不生效**：需要重启项目实例。
- **想在别的项目也用**：再跑一次 `./install_loca.sh <另一个项目路径>`。
