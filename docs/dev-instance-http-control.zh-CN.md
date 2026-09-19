# 如何使用正在运行的开发版 Aether 实例工作

记录日期：2026-09-19。目的：agent（或未来的会话）需要驱动/观察**用户 GUI 正在使用的开发版实例**时，按本文操作，不要另起进程。本方法在 LOCA v3 NRQCD 实测中验证通过。

## 1. 实例拓扑与识别

本机应有的常驻实例（用户维护）：

| 实例            | 启动方式                           | 地址                                                                                                        | 用途                                     |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 正式版桌面      | `/Applications/Aether Desktop.app` | `localhost:19527`（opencode-cli serve）                                                                     | 日常会话（agent 通常跑在这里）           |
| 开发版 dev 实例 | 用户执行仓库根 `./open_dev.sh`     | `localhost:4096`（`bun run --cwd packages/opencode --conditions=browser ./src/index.ts serve --port 4096`） | 开发测试，**GUI 会话要看的输出必须走它** |

识别命令：

```sh
ps aux | grep "serve --port 4096" | grep -v grep        # 应恰有 1 个 bun 进程
ps -p <pid> -o ppid,command                              # ppid 指向 bash ./open_dev.sh 的即用户 dev 实例
lsof -iTCP -sTCP:LISTEN -P | grep bun                    # 端口占用
lsof <项目 state.sqlite 或 aether-*.db>                  # 谁持有该 DB 即谁加载了该项目
```

**关键陷阱：4096 上出现第二个 serve 进程时（历史残留、误启动），bun 的 SO_REUSEPORT 会让 curl 请求随机路由到任一进程**——表现为：会话列表时有时无、注入消息 204 后毫无反应、单会话查询 404。处置：杀掉非 open_dev.sh 子进程的那个（`kill -TERM <pid>`，不退再 `kill -9`），只保留用户的 dev 实例。

## 2. HTTP API（驱动 GUI 会话的正确方式）

所有项目级路由用 `?directory=<项目绝对路径>`（或 `x-opencode-directory` 头）选择项目实例。

```sh
D=/path/to/project

# 列会话（可选 roots=true 只看根会话、search= 按标题搜）
curl -s "http://localhost:4096/session?directory=$D"

# 新建会话
curl -s -X POST "http://localhost:4096/session?directory=$D" \
  -H 'content-type: application/json' -d '{"title":"..."}'

# 读消息（路由是 /message 不是 /messages；会话 id 必须带 ses_ 前缀，否则 zod 校验 404）
curl -s "http://localhost:4096/session/ses_xxx/message?directory=$D"
```

**向 GUI 会话发命令（工作流驱动的标准入口）**——`POST /session/<ses_xxx>/command`，body 为 `CommandInput`：

```sh
nohup curl -s --max-time 14400 -X POST \
  "http://localhost:4096/session/ses_xxx/command?directory=$D" \
  -H 'content-type: application/json' \
  -d '{"command":"loca","arguments":"continue","agent":"loca","model":"alibaba-cn/glm-5.3"}' \
  > /tmp/cmd.log 2>&1 &
```

要点：

- `model` 是**字符串** `"provider/model"`（不是对象）。父桥接会话必须显式传，否则落到默认 provider（可能配额耗尽，v2 实测踩过 429）。
- 命令处理 = 桥接 agent 一次完整模型轮 + 工具执行（工作流命令可达数十分钟）→ **nohup 后台 + 长 max-time**。客户端提前断开可能中止服务端工作（实测 `--max-time 8` → HTTP 000、零消息落库）。
- 普通 `POST /session/<id>/message`（同步流式，忙时 409）与 `/prompt_async`（204 异步）用于非命令消息；但斜杠命令必须走 `/command`——消息文本里的 `/loca` 不会被当作命令解析。

## 3. 工作流测试的标准流程（LOCA）

1. 确认 4096 单实例（§1）。
2. 在目标项目找/建桥接会话（agent=`loca`）。
3. `/command` 发 `loca` 命令（continue 或 `arguments` 传目标与验收标准），显式带 model。
4. **监控走只读 SQLite**（WAL 允许与运行实例并发读写）：

```sh
sqlite3 "file:$D/loca/.runtime/state.sqlite?mode=ro" "SELECT json_extract(data,'$.phase'), json_extract(data,'$.calls') FROM runs"
```

四表：`runs`（run 行内含契约/计划/里程碑/账本/子结果）、`jobs`、`events`（stage/rollback/propagation 等审计流）、`assets`。GUI 会话里同时能看到阶段元数据流（`loca` 工具的 metadata 标题行）。

**反模式（禁止）**：用 `Instance.provide` 自起独立 Aether 进程做测试——会话虽落同一项目 DB，但 GUI 看不到任何实时流，且与 GUI 驱动形成双写风险（lease 只在单进程内互斥可感知）。仅当用户明确接受无 GUI 观察时才可后台脚本驱动，且须 nohup + 日志文件。

## 4. 存储布局（取证用）

- 项目会话库：`~/.local/share/aether/<channel>/aether-<projectId>.db`（channel ∈ prod/local；projectId = 项目路径哈希）。表：`session(id, directory, title, …)`、`message(id, session_id, data JSON)`、`part(message_id, data JSON)`。
- 跨库找会话：遍历 `~/.local/share/aether/*/aether-*.db` 查 `session.title`。
- LOCA 运行数据：`<项目>/loca/.runtime/state.sqlite` + `blobs/` + `contexts/<job>/`（隔离子会话，各自是独立 project）。
- 全局 provider：`~/.config/aether/aether.jsonc`（自定义 provider）+ `~/.local/share/opencode/auth.json`（OAuth 型 provider，如 alibaba-cn）。

## 5. 重启与恢复

- 代码更新后 dev 实例需重启加载：杀掉 serve 进程后由用户重新执行 `open_dev.sh`（或 agent 提示用户操作）。
- 工作流 run 中断（进程被杀/暂停）后：run 落 `cancelled`，jobs 标 `stale/cancelled`；GUI 或 `/command` 再发 `continue` 即从持久化状态重建 frontier（infra 恢复不烧 cycle）。
- 杀工作流驱动进程：SIGTERM → 等 dispose（可能挂起，数秒后 kill -9 无害——状态已 WAL 落盘）。
