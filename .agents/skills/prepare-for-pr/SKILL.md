---
name: prepare-for-pr
description: github pr操作的前期准备，包括通过git rebase引入dev的commit，以及代码、文档规范检查
---

把当前分支合入 dev 分支的前期准备，需要分析当前分支和 dev 分支的差异，对于当前分支相对于dev分支的修改：
1. 使用命令 `git merge-tree --write-tree dev HEAD > /dev/null 2>&1 && echo "无冲突" || echo "有冲突"` 判断当前分支是否和dev分支有冲突；如果有冲突则提示用户进行rebase dev操作，并中止任务；如果无冲突则继续分析
2. 对当前分支相对 dev 的差异执行代码与文档静态检查，并给出结论
3. 无论是否引入了bug/是否合理/是否符合规范，都为pr编写description
4. 展示上述所有内容
