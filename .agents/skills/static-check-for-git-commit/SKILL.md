---
name: static-check-for-git-commit
description: git commit操作前的静态检查，包括代码、文档规范检查，以及commit message编写
---

步骤：
1. 检查git暂存区的代码、文档是否引入了bug，是否合理，文档和代码是否一致，是否符合良好的项目开发维护规范
2. 扫描 `docs/` 下所有已暂存文档，确认是否和git暂存区的代码不一致
3. 无论是否引入了bug/是否合理，都根据git暂存区的代码修改编写commit message
4. 展示上述所有内容
