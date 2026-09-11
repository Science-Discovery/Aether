# Windows Shell 输出编码

Aether 的 Shell 工具会收集子进程的 stdout 和 stderr。Windows PowerShell 和传统 Windows 程序可能使用系统本地码页输出，直接把每个数据块当成 UTF-8 会破坏中文。即使原始输出是 UTF-8，逐块解码也可能破坏跨块的多字节字符。

## 解码方式

- stdout 和 stderr 分别维护解码状态，避免两个流的字节拼接成错误字符。
- 非 Windows 平台及无需本地码页回退的情况使用 UTF-8 流式解码，保留跨块的未完成字符。
- Windows 启用本地码页回退时，ASCII 前缀即时交付；从首个非 ASCII 字节起，缓冲到 CR 或 LF，再判断这一段的编码。没有换行的尾部在流结束时解码。
- 优先验证 UTF-8；验证失败时使用选定的系统码页。注册表查询以 OEMCP 优先，OEMCP 不受支持时使用 ACP；查询失败或均不支持时使用 UTF-8。系统码页信息在进程内缓存。
- 映射的码页包括 932、936（GBK）、949、950、874、866、1250–1258 和 65001，实际支持以运行时 `TextDecoder` 为准；65001 使用标准 UTF-8 流式路径。
- 解码后的文本再进入既有的元数据、截断和完整输出保存流程。

不会通过全局 `chcp` 改变系统或其他终端的编码，也不会为了输出编码自动改写用户命令。

## PowerShell 命令构造

系统环境和 Shell 工具描述都会显示实际选择的 Shell。Windows 上可能使用 Git Bash，因此不能仅凭平台名称假定当前语法是 PowerShell。

从 Bash 调用 `powershell.exe -Command "..."` 时，双引号内的 `$变量`、`$(...)` 和反引号会先被 Bash 解释。变量被移除后可能出现 `EmptyPipeElement`，这属于命令转义错误，不能靠输出解码修复。

对包含变量、管道或嵌套引号的脚本，提示模型先用 Write 保存 `.ps1`，再执行：

```text
pwsh -NoProfile -File "script.ps1"
```

没有 PowerShell 7 时使用 `powershell.exe -NoProfile -File "script.ps1"`。包含非 ASCII 字符的 UTF-8 脚本交给 Windows PowerShell 5.1 执行时，应保存为 UTF-8 BOM；PowerShell 7 支持无 BOM 的 UTF-8。脚本文件编码与控制台输出编码是两个独立问题。

## 边界

- Windows 启用本地码页回退时，非 ASCII 输出在行结束前可能延迟显示；持续输出且没有 CR/LF 的内容会缓冲到流结束。
- 仅凭字节无法无歧义识别所有编码。优先接受合法 UTF-8，因此某些恰好符合 UTF-8 的本地编码字节仍有歧义。
- 同一行混用多种编码、程序自行切换到非系统码页、或系统使用未支持的码页，不保证能正确恢复。
- 已经由上游替换成 `�` 的内容无法还原；输出解码也不修正真实的 PowerShell 语法错误。
- 命令构造通过提示引导模型使用安全的传参方式；执行层不自动重写任意命令，也不更改默认 Shell。

## 验证

测试从 `packages/opencode` 目录运行。覆盖中文本地编码、UTF-8 多字节跨块、stdout/stderr 独立解码、实际 Shell 提示，以及带空格路径的 `.ps1 -File` 对变量、管道、引号和中文 BOM 脚本的保留。

编码行为依据：[PowerShell 字符编码说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding)、[Bash 双引号规则](https://www.gnu.org/software/bash/manual/html_node/Double-Quotes.html)。
