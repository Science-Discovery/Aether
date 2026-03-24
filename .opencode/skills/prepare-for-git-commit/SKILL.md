---
name: prepare-for-git-commit
description: git commit操作的前期准备，包括代码、文档规范检查，以及commit message编写。当用户说"帮我commit"、"准备提交"、"git commit"、"提交代码"、"检查代码然后提交"时触发。
---

# Prepare for Git Commit

## 步骤

按顺序执行以下步骤，最后一并展示所有结论：

### 1. 检查暂存区变更

运行 `git diff --staged` 获取暂存区的所有改动。

### 2. Bug 与合理性检查

检查暂存区的代码和文档是否：
- 引入了 bug（空指针、边界错误、逻辑错误等）
- 存在不合理的实现
- 代码与文档不一致

### 3. 规范检查

若 `docs/coding_standards/` 目录存在，读取其中所有文件，逐一对照暂存区改动，给出是否符合规范的结论。若目录不存在，跳过此步骤并说明。

### 4. 编写 Commit Message

无论步骤 2、3 的结论如何，都根据暂存区的实际改动编写 commit message：
- 第一行：简明概括（≤72字符）
- 正文（如有必要）：说明 why，不重复 what

### 5. 展示所有内容

将以上所有分析结果一并呈现：
- Bug/合理性检查结论
- 规范检查结论（如适用）
- 建议的 commit message