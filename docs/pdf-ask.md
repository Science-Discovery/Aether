# PDF 与对话选区提问

PDF 的“问 AI”和对话正文的 Ask 共用一套待提问列表。选中文字或框选 PDF 截图后，在选区附近填写问题，点击“加入问题”；继续选择其他内容，最后从主输入框一次发送。加入引用不会调用模型，也不会写入 PDF 永久批注。

## 使用方式

- 每处问题可以留空，用主输入框填写总问题；也可以只填写逐项问题而不填总问题。发送时至少需要一个问题。
- 引用按加入顺序编号，混合显示 PDF 文件、页码和对话来源，可以展开原文、编辑问题、删除。再次选择同一位置会编辑原条目；不同位置的相同文字分别保留。
- 选区卡片的取消、关闭及 Escape 不新增引用，取消编辑保留原问题。Ctrl/Cmd+Enter 确认加入；输入法正在组合文字时不会提交。
- 文件预览、快速阅读和阅读模式均支持。截图与其引用编号一起发送；普通文件引用仍可同时使用。

## 草稿、队列与来源

`Prompt.references` 保存选区快照、来源位置、问题、稳定 ID 和版本，数组位置决定顺序。发送和排队都使用 `FollowupDraft` 快照；成功后只移除 ID 与版本仍匹配的条目，失败保留草稿。发送期间增加或修改的引用不会被成功响应清除。

新建会话首次发送失败时，若自动打开的新会话还没有新编辑，会返回原草稿；已切换会话或开始新编辑时不抢回导航。切换服务器后，旧请求也不能改写新服务器的草稿。

文字引用随工作区、会话草稿保存。输入历史按服务器隔离，只有工作区与会话也匹配时才恢复引用。截图沿用附件规则，不把 base64 写入草稿或输入历史：重新加载后保留来源及问题，提示重新选择区域，补齐或移除前不能发送。

阅读模式保存加入时的提示词、上下文页数和 PDF 来源。同一来源的相邻或重叠页范围合并，抓取的文本和 PDF 附件随队列快照保存。来源会话不再绑定原文件时会报错，不会改用当前打开的 PDF。编辑队列后重新发送会重新检查来源。

请求仍使用现有消息、附件和阅读模式接口。模型收到编号、来源、原文及对应问题，总问题单列。发送记录通过现有引用 metadata 的可选字段展示原文和逐项问题，旧记录仍可读取。

发送后的引用集中在一个限高、纵向滚动的引用框中，按顺序显示编号、来源和原文摘要。点击单项可以查看完整原文、截图及对应问题；简略卡片不重复展开问题。主消息保留总问题；未填写总问题时显示各处问题的编号列表。

## 定向验证

从 `packages/app` 运行相关测试，不从仓库根目录运行测试：

```powershell
bun test --preload ./happydom.ts ./src/utils/ask-reference.test.ts ./src/context/prompt.test.ts ./src/components/prompt-input/history.test.ts ./src/utils/comment-note.test.ts ./src/pages/session/conversation-selection.test.ts
bun test --preload ./happydom.ts ./src/components/prompt-input/ask-request.test.ts ./src/components/prompt-input/submit.test.ts ./src/components/prompt-input/build-request-parts.test.ts
bun run ./script/vitest.ts run --config ./vitest.config.ts src/components/ask-editor.vitest.tsx src/components/pdf-viewer-shell-official.vitest.tsx src/pages/session/composer/session-composer-region.vitest.tsx src/pages/session/message-references.vitest.tsx
bun typecheck
```

对话选区使用真实 AI 消息的文本位置；单条消息内可以跨文本部分选择，不跨不同消息。`packages/ui` 的 `message-part.vitest.tsx` 验证渲染出的消息、文本部分标识，并运行该包 `bun typecheck`。

手动检查连续选择、跨页与跨 PDF、PDF/对话/文件混合、截图编号、重复位置、取消编辑及逐项删除；再检查排队编辑、失败重试、发送中修改、切会话和草稿重载。布局检查覆盖明暗主题、三语、窄面板、页面边缘、缩放、长问题和中文输入法。无需调用真实模型即可验证请求内容、草稿清理和队列快照。
