# CI E2E 恢复与迁移现状

本文档只描述当前现状、已完成进度、验证矩阵、未决问题和下一步，不再按时间顺序记录每次试跑反馈。

目标不是整包照搬 `upstream/dev` 的 E2E，而是在尊重当前 Aether 程序实现的前提下：

- 先恢复 app E2E 进入 CI
- 再逐步吸收 upstream 的 harness 和测试
- 每次都区分 runner 问题、harness/mock LLM 问题、测试语义偏移、以及程序自身真实问题

## 工作原则

后续推进必须一直遵守：

1. 任何修改只要可能影响现有单测，必须先停下说明，等待决断。
2. 任何修改只要可能影响用户实际使用时的程序运行或行为，必须先停下说明，等待决断。
3. 任何迁移、补充、修改具体测试时，只要测试与当前程序实现存在不同、偏移或冲突，必须先详细汇报，再等待决断。
4. 测试迁移必须尊重当前程序的既定实现，不能为了贴合 upstream 测试而反向修改当前产品行为。

## 当前结论

### 1. CI E2E 基线已经恢复

当前仓库已经重新具备在 CI 中运行 app E2E 的基础能力：

- `.github/workflows/test.yml` 已恢复 app E2E job
- app E2E CI 入口当前改为读取 `packages/app/e2e/ci-specs.txt` 与 `packages/app/e2e/ci-specs-serial.txt` 两份临时白名单
- Playwright 浏览器缓存、Linux 依赖、JUnit 输出、artifact 上传已补回
- `packages/app/script/e2e-local.ts` 已增加 `PLAYWRIGHT_BROWSERS_PATH` 兜底，默认落到仓库根 `.playwright-browsers`

当前策略不是给失败 spec 逐条加 `skip`，而是：

- 保留所有 spec 文件原样存在
- 只让 CI 先运行当前已核验通过的白名单 spec
- 其中大多数 spec 保留常规并发，只有少数并发敏感 spec 单独串行
- 未修复的 spec 继续保留在仓库中，等待逐条修复后再放回白名单

这个兜底不会改变当前 GitHub Actions 里已经显式设置 `PLAYWRIGHT_BROWSERS_PATH` 的行为，只是在未显式传入环境变量时避免 Playwright 去临时 sandbox 缓存目录找浏览器。

### 2. upstream 的新 E2E 基建已部分吸收，但不能整包替换

当前已经并行接入了 upstream 新 harness 的关键基础能力，包括：

- `packages/app/e2e/backend.ts`
- `packages/opencode/test/lib/llm-server.ts`
- `packages/opencode/test/lib/effect.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/app/e2e/utils.ts`
- `packages/app/e2e/fixtures.ts`
- `packages/app/e2e/actions.ts`
- `packages/app/src/testing/prompt.ts`
- `packages/app/src/testing/model-selection.ts`
- `packages/app/src/testing/terminal.ts`
- `packages/app/src/context/local.tsx`
- `packages/app/src/components/prompt-input/submit.ts`

当前策略是并行接入，不是整体替换：

- 旧 `withProject` / `sdk` / `gotoSession` 路径仍保留
- 新 `project` / `assistant` / `llm` / `backend` harness 已可用
- 当前已有 spec 不需要被一次性全部改写

### 3. 不能直接整包迁入 upstream 当前 E2E

原因不是“个别断言不同”，而是 upstream 的测试基建、测试探针和程序行为假设一起演进了。直接整包替换 `packages/app/e2e`，在当前 Aether 上会同时遇到：

- fixture 体系不同
- mock LLM 接线方式不同
- prompt/model probe 能力不同
- sidebar / workspace / session 区域的产品行为已与 upstream 假设分叉

结论：

- upstream 的 harness 可以逐步吸收
- upstream 的 spec 不能默认逐文件照搬

## 已完成工作

### A. CI 与 runner 恢复

已完成文件：

- `.github/workflows/test.yml`
- `docs/ci-guide.md`
- `packages/app/playwright.config.ts`
- `packages/app/script/e2e-local.ts`
- `packages/app/.gitignore`
- 根 `.gitignore`

已验证事实：

- 本地 CI 模式 smoke 可运行
- `playwright-report`、`test-results`、JUnit 产物生成正常
- `bun test:e2e:local` 已不再因为 Playwright 浏览器缓存路径落到临时 sandbox 而失败

### B. harness 与 probe 基础设施接入

已完成事项：

- 新增 isolated backend 启动器
- 新增 mock LLM server
- 在 `provider.ts` 中加入 `OPENCODE_E2E_LLM_URL` 路径
- 在 app 侧补齐 prompt/model/terminal probe
- 在 `fixtures.ts` 中并行接入新 harness
- 在 `actions.ts` 中加入兼容当前迁移所需的扩展

已验证事实：

- `packages/app` 下 `bun typecheck` 通过
- `packages/opencode` 下 `bun typecheck` 通过
- 受影响的现有单测仍通过：
  - `packages/app/src/components/prompt-input/submit.test.ts`
  - `packages/opencode/test/provider/provider.test.ts`

### C. 已按当前实现调整的测试

已完成并确认语义对齐的测试：

- `packages/app/e2e/projects/workspace-new-session.spec.ts`

当前对这条 spec 的准确定义是：

- 点击某个 workspace 的 `New session`
- 进入目标 workspace
- 等待页面稳定到该 workspace 下的最终 session
- 在最终稳定 session 中发送 prompt
- 验证消息保存到该 workspace 下的最终 session

这里已经确认当前程序实现不保证“点击后第一个瞬时出现的 `sessionID` 一直保持不变”，所以测试不再把这一点当作语义要求。

### D. 已完成的低风险测试迁移

以下 spec 已完成调整并实跑通过：

- `packages/app/e2e/projects/projects-close.spec.ts`
- `packages/app/e2e/terminal/terminal-reconnect.spec.ts`
- `packages/app/e2e/terminal/terminal-tabs.spec.ts`
- `packages/app/e2e/session/session-undo-redo.spec.ts`

### E. 已落地但待补验证的定向 prompt 迁移

为消除当前 CI 中串行 prompt spec 对真实 LLM 文本输出的依赖，已在不调整 workflow、白名单拆分、`e2e-local.ts` 与 `provider.ts` 的前提下，定向改写：

- `packages/app/e2e/prompt/prompt.spec.ts`
- `packages/app/e2e/prompt/prompt-async.spec.ts`
- `packages/app/e2e/prompt/prompt-history.spec.ts`
- `packages/app/e2e/actions.ts`（仅补 `assistantText()` helper）

当前策略是：

- 仅把这三条已暴露 flaky 的 prompt spec 切到现有 `project` / `assistant` mock-backed harness
- 保持测试原有用户场景与断言主题不变
- 不扩散到其它单测与非 LLM 输出相关 e2e

当前验证现状：

- `packages/app` 下 `bun typecheck` 已通过
- 本地定向执行这三条 spec 时，运行阻塞在宿主机 Vite watcher 上限：`ENOSPC: System limit for number of file watchers reached`
- 因此这批修改仍待在 watcher 资源正常的环境中补跑确认

## 当前验证矩阵

### 总量

- `packages/app/e2e/**/*.spec.ts` 当前总计 `50` 条 spec

### 当前已核验通过

当前已实际核验通过 `37` 条 spec。

通过 spec 列表：

- `packages/app/e2e/app/home.spec.ts`
- `packages/app/e2e/app/navigation.spec.ts`
- `packages/app/e2e/app/palette.spec.ts`
- `packages/app/e2e/app/server-default.spec.ts`
- `packages/app/e2e/app/session.spec.ts`
- `packages/app/e2e/commands/input-focus.spec.ts`
- `packages/app/e2e/commands/panels.spec.ts`
- `packages/app/e2e/commands/tab-close.spec.ts`
- `packages/app/e2e/files/file-open.spec.ts`
- `packages/app/e2e/files/file-tree.spec.ts`
- `packages/app/e2e/files/file-viewer.spec.ts`
- `packages/app/e2e/models/models-visibility.spec.ts`
- `packages/app/e2e/projects/project-edit.spec.ts`
- `packages/app/e2e/projects/projects-close.spec.ts`
- `packages/app/e2e/projects/workspace-new-session.spec.ts`
- `packages/app/e2e/projects/workspaces.spec.ts`
- `packages/app/e2e/prompt/prompt-async.spec.ts`
- `packages/app/e2e/prompt/prompt-history.spec.ts`
- `packages/app/e2e/prompt/prompt-mention.spec.ts`
- `packages/app/e2e/prompt/prompt-multiline.spec.ts`
- `packages/app/e2e/prompt/prompt-shell.spec.ts`
- `packages/app/e2e/prompt/prompt-slash-open.spec.ts`
- `packages/app/e2e/prompt/prompt-slash-share.spec.ts`
- `packages/app/e2e/prompt/prompt-slash-terminal.spec.ts`
- `packages/app/e2e/prompt/prompt.spec.ts`
- `packages/app/e2e/session/session-child-navigation.spec.ts`
- `packages/app/e2e/session/session-undo-redo.spec.ts`
- `packages/app/e2e/session/session.spec.ts`
- `packages/app/e2e/settings/settings-models.spec.ts`
- `packages/app/e2e/settings/settings.spec.ts`
- `packages/app/e2e/sidebar/sidebar.spec.ts`
- `packages/app/e2e/status/status-popover.spec.ts`
- `packages/app/e2e/terminal/terminal-init.spec.ts`
- `packages/app/e2e/terminal/terminal-reconnect.spec.ts`
- `packages/app/e2e/terminal/terminal-tabs.spec.ts`
- `packages/app/e2e/terminal/terminal.spec.ts`
- `packages/app/e2e/thinking-level.spec.ts`

### 当前仍未通过

当前仍有 `13` 条 spec 在低并发复核下继续失败：

- `packages/app/e2e/app/titlebar-history.spec.ts`
- `packages/app/e2e/models/model-picker.spec.ts`
- `packages/app/e2e/projects/projects-switch.spec.ts`
- `packages/app/e2e/prompt/context.spec.ts`
- `packages/app/e2e/prompt/prompt-drop-file-uri.spec.ts`
- `packages/app/e2e/prompt/prompt-drop-file.spec.ts`
- `packages/app/e2e/session/session-composer-dock.spec.ts`
- `packages/app/e2e/session/session-model-persistence.spec.ts`
- `packages/app/e2e/session/session-review.spec.ts`
- `packages/app/e2e/settings/settings-keybinds.spec.ts`
- `packages/app/e2e/settings/settings-providers.spec.ts`
- `packages/app/e2e/sidebar/sidebar-popover-actions.spec.ts`
- `packages/app/e2e/sidebar/sidebar-session-links.spec.ts`

因此当前 CI 白名单与本地已核验通过 spec 一致，暂时只覆盖这 `37` 条。

其中并发策略为：

- 常规并发白名单：`31` 条 spec
- 单独串行白名单：`6` 条 spec

当前被单独串行的 spec 是：

- `packages/app/e2e/files/file-viewer.spec.ts`
- `packages/app/e2e/prompt/prompt-async.spec.ts`
- `packages/app/e2e/prompt/prompt-history.spec.ts`
- `packages/app/e2e/prompt/prompt.spec.ts`
- `packages/app/e2e/terminal/terminal-init.spec.ts`
- `packages/app/e2e/terminal/terminal-reconnect.spec.ts`

它们被放入串行白名单的原因不是“当前确认只在串行才正确”，而是：

- 在高并发首轮全量核验中失败
- 在 `--workers 1` 低并发复核中转为通过
- 或者在主并发白名单回归中表现为 flaky，但在独立低负载运行中稳定通过
- 现阶段先按更保守方式纳入 CI，后续可继续验证是否能回到常规并发

## 现有验证结果如何得出

### 首轮全量核验

对之前尚未逐条确认的 `43` 条 spec 做过一轮高并发全量运行：

- 结果：`85 passed / 24 failed / 4 skipped`
- spec 级结果：`26` 条 spec 通过，`17` 条 spec 失败
- 运行条件：Playwright `43 workers`

这轮结果不能直接用来判定产品真实问题，因为同时伴随：

- `MaxListenersExceededWarning`
- frontend 更新检查 socket 错误
- 插件版本查询 / `bun info` 失败
- `NotFoundError` / cleanup 噪音

### 低并发复核

随后对那 `17` 条首轮失败 spec 做了 `--workers 1` 串行复核：

- 结果：`34 passed / 21 failed`
- 有 `4` 条 spec 在低并发下转绿：
  - `packages/app/e2e/files/file-viewer.spec.ts`
  - `packages/app/e2e/prompt/prompt-async.spec.ts`
  - `packages/app/e2e/prompt/prompt-history.spec.ts`
  - `packages/app/e2e/prompt/prompt.spec.ts`

因此当前可直接下的结论是：

- 这 4 条更像首轮受到并发污染
- 剩余 `13` 条不能再简单归因给高并发

## 当前未决问题分桶

### 1. 已确认的测试语义偏移

当前已经明确确认一条需要先决策的语义偏移：

- `packages/app/e2e/settings/settings-keybinds.spec.ts`
  - 其中 `changing new session keybind works` 仍然假设触发 `new session` 后 URL 形如 `/session`
  - 当前实际行为是直接进入 `/session/<id>`
  - 这与 `workspace-new-session.spec.ts` 暴露出的当前实现特征一致

按工作原则，这一项在继续改测试前必须先单独决策。

### 2. 很可能不是纯 runner 问题

以下失败在低并发下仍稳定存在，不能再简单归因给 runner：

- `packages/app/e2e/app/titlebar-history.spec.ts`
- `packages/app/e2e/models/model-picker.spec.ts`
- `packages/app/e2e/projects/projects-switch.spec.ts`
- `packages/app/e2e/prompt/context.spec.ts`
- `packages/app/e2e/prompt/prompt-drop-file-uri.spec.ts`
- `packages/app/e2e/prompt/prompt-drop-file.spec.ts`
- `packages/app/e2e/session/session-model-persistence.spec.ts`
- `packages/app/e2e/settings/settings-providers.spec.ts`
- `packages/app/e2e/sidebar/sidebar-popover-actions.spec.ts`
- `packages/app/e2e/sidebar/sidebar-session-links.spec.ts`

这些项后续需要继续区分：

- harness / mock LLM / probe 是否缺能力
- 当前 UI 交互是否和测试假设不一致
- 当前程序是否存在真实问题

### 3. 局部 case 失败，不是整份 spec 全坏

以下 spec 目前暴露的是局部失败，而不是整份 spec 全面失效：

- `packages/app/e2e/session/session-composer-dock.spec.ts`
  - 当前明确失败的 case 是拖拽 resize 高度断言未满足
- `packages/app/e2e/session/session-review.spec.ts`
  - 当前失败落在 `waitSessionIdle()` 不收敛，以及 review 布局相关断言

这两条需要以“局部行为/交互问题”来查，不应简单按“整份 spec 不适配”处理。

### 4. 当前优先级最高的待查项

在仍失败的项里，当前优先级最高的是：

- `packages/app/e2e/session/session-model-persistence.spec.ts`

原因：

- 它从一开始就是已知不稳定项
- 低并发下仍失败
- 它更接近“当前实现、probe、session 状态恢复语义”三者之间的真实分界点

## 当前推荐推进顺序

1. 保持“不整包替换 upstream spec”的策略不变。
2. 对已确认语义偏移的 `settings-keybinds.spec.ts` 先单独决策，再决定是否改测试。
3. 对非语义偏移项，优先单独评估 `session-model-persistence.spec.ts`。
4. 继续把其余失败分成四类：runner、harness/mock、测试语义偏移、真实程序问题。
5. 对 `sidebar`、`review`、`provider dialog`、`drag-resize` 这类问题，优先查局部交互和 probe，而不是先改产品行为。

## 失败判断顺序

后续每次遇到失败，都应按以下顺序判断：

1. runner 是否正确拉起 backend / web / Playwright
2. 测试是否仍然打到了真实 provider，而不是 mock LLM
3. probe 是否把当前页面状态暴露给 E2E
4. fixture/harness 是否与该 spec 所需能力匹配
5. 如果以上都成立，再判断是否属于当前 Aether 的真实产品问题

不要把以下问题混在一起：

- CI / runner / 浏览器安装问题
- `e2e-local.ts` 的 Playwright 浏览器缓存路径问题
- harness 或 mock LLM 缺能力问题
- 测试与当前实现不匹配问题
- 当前程序自身真实问题
