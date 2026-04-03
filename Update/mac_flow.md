**Mac Flow**

- `packing_scripts/release-mac-web.sh`
  - 构建 web 二进制并裁剪 `wechat-bridge/runtime/uv` 仅保留 mac arm64 目标。
  - 组装产物目录，包含运行文件、`update_darwin_web.command`、`aether_darwin_installer.command`、`.aether_web_version`、`README_FIRST.txt`。
  - 修正执行权限（`aether`、`Aether.command`、`update_darwin_web.command`、installer）。
  - 打出 `dist/aether-darwin-arm64-web.dmg`，生成 `dist/latest-web-mac.yml`。
  - 额外在 `dist/` 放一份 `update_darwin_web.command` 方便你上传远端。

- `Update/aether_darwin_installer.command`（入口脚本）
  - 支持 `init | auto <current-version> | manual <target-version>`，支持 `--path`、`--no-pause`。
  - `init` 默认无交互安装到 `~/Applications/Aether`（或 `--path <dir>/Aether`）。
  - 拉取远端 manifest，下载包和对应版本 update 脚本到 `Aether/downloads`。
  - 本地文件名统一版本化并与远端命名解耦：
    - `aether-darwin-arm64-web-<ver>.dmg`
    - `update_darwin_web-<ver>.command`
  - 已有同版本文件会复用，不重复下载；并清理旧缓存（默认保留最近 3 个版本）。
  - `init` 下载后会自动执行版本化 update 脚本完成安装。
  - 仅 `init` 会创建 `~/Aether_Database`。
  - `auto/manual` 只下载并写 `downloads/last-result.yml` 供 Aether 后台流程使用。

- `Update/update_darwin_web.command`（本地安装脚本）
  - 只接受固定目录规范：`.../Aether/downloads` 执行，且 `.../Aether` 下需有 installer。
  - 从 `downloads` 选择对应版本 DMG，安装到 `Aether/aether_<ver>`。
  - 权限处理：
    - `chmod +x` / `xattr -cr`：`aether`、`Aether.command`、`wechat-bridge/.../uv`
  - 版本切换：
    - 写入 `aether_<ver>/.aether_web_version` 与 `Aether/.aether_web_version`
    - `current -> aether_<ver>`
    - 小版本替换旧目录；大版本并存保留旧目录
  - 启动入口：
    - 生成 `Aether.app`（优先 `/Applications`，失败回退 `~/Applications`）
    - App 内部启动 `.../Aether/current/Aether.command`
  - `--restart` 模式（由安装接口触发）：
    - 先按旧版本目录和 current 目录关闭旧 `Aether.command`/`aether web`/`aether serve`
    - 再拉起最新 `current/Aether.command`。

- Aether 内自动更新联动（你现在实测使用的链路）
  - 启动/定时检查：后台静默触发 installer `auto` 下载。
  - 下载完成：立即弹“更新并重启”。
  - 点击更新：后端执行 `update_darwin_web-<ver>.command --restart`。
  - 防降级：即使远端误把旧版本标为 latest，也不会提示从新版本降到旧版本。