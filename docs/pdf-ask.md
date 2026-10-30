# PDF 与对话选区提问

PDF 的“问 AI”和对话正文的 Ask 共用一套待提问列表。选中文字或框选 PDF 截图后，在选区附近的输入条填写问题，点击勾号确认；继续选择其他内容，最后从主输入框一次发送。加入引用不会调用模型，也不会写入 PDF 永久批注。

## 使用方式

- 每处问题可以留空，用主输入框填写总问题；也可以只填写逐项问题而不填总问题。发送时至少需要一个问题。
- 引用按加入顺序编号，混合显示 PDF 文件、页码和对话来源，可以展开原文、编辑问题、删除。再次选择同一位置会编辑原条目；不同位置的相同文字分别保留。
- 输入条默认一行，随内容增高至四行，之后内部滚动。Enter 换行，Ctrl/Cmd+Enter 确认；输入法正在组合文字时不会提交。关闭或 Escape 不新增引用，取消编辑保留原问题。切换编辑入口会取消尚未确认的编辑，同时只打开一条输入条。
- 文件预览、快速阅读和阅读模式均支持。截图与其引用编号一起发送；普通文件引用仍可同时使用。

## 临时提问标记

打开输入条时保留选区高亮。确认加入后，原文附近显示蓝色编号，与混合引用列表顺序一致；平时只显示编号，悬停或键盘聚焦时高亮对应选区，点击编号可重新编辑问题。跨页 PDF 引用在各页显示相同编号，相邻标记错开显示。原文和截图仍可在待提问列表及发送后的引用详情中查看。

标记直接由当前会话的 `Prompt.references` 派生。删除引用会移除标记并重新编号，成功发送或加入队列会清除对应标记；失败保留，编辑队列消息时恢复。发送期间已经修改或新加入的引用及标记不会被旧请求清除。标记不属于 PDF 永久批注，不参与批注保存或导出。

PDF 引用保存页面坐标和可选的原始文档指纹。滚动、缩放、旋转后根据当前页面重新定位；文档指纹不符或旧引用缺少可靠定位时，只保留列表，不在页面上绘制可能错误的标记。重新选择可补齐旧引用定位。对话引用通过消息 ID 和文本偏移定位，并核对原文；折叠、尚未渲染或原文改变时隐藏标记，重新展示且准确匹配后恢复。

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
bun run ./script/vitest.ts run --config ./vitest.config.ts src/components/ask-editor.vitest.tsx src/components/pdf-viewer-shell-official.vitest.tsx src/pages/session/composer/session-composer-region.vitest.tsx src/pages/session/conversation-marks.vitest.tsx src/pages/session/message-references.vitest.tsx
bun typecheck
```

对话选区使用真实 AI 消息的文本位置；单条消息内可以跨文本部分选择，不跨不同消息。`packages/ui` 的 `message-part.vitest.tsx` 验证渲染出的消息、文本部分标识，并运行该包 `bun typecheck`。

手动检查连续选择、跨页与跨 PDF、PDF/对话/文件混合、截图编号、重复位置、取消编辑及逐项删除；再检查排队编辑、失败重试、发送中修改、切会话和草稿重载。布局检查覆盖明暗主题、三语、窄面板、页面边缘、缩放、旋转、长问题和中文输入法。编号检查还包括悬停与键盘聚焦高亮、点击编辑、相邻选区避让、滚动时焦点保留、折叠重开、PDF 指纹不匹配，以及临时标记不会产生批注保存事件。无需调用真实模型即可验证请求内容、草稿清理和队列快照。
