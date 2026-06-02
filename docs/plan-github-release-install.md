# 方案：支持从 GitHub Release 产物直接安装/更新 Aether Web 版

## 一、需求背景

当前 Aether Web 版的安装和更新仅能通过 aiphys 服务器完成：
- **安装**：运行 `aether_*_installer.*` 脚本，从 `aether.aiphys.cn` 下载 archive 和 update script，再调用 update script 执行安装
- **更新**：in-app 自动更新检查指向 `aether.aiphys.cn`，下载后调用 update script 执行更新

用户无法从 GitHub Releases 下载的 DMG/ZIP 直接完成同等功能的安装。本方案旨在新增一套安装脚本，使用户从 GitHub 下载产物后，运行脚本即可完成与 aiphys 安装流程一致的全新安装或更新。

## 二、核心设计原则

1. **文件来源替换**：新脚本做与现有 installer + update 脚本几乎完全一样的事情，唯一区别是将所需文件的来源从"从 aiphys 远程下载"变为"从脚本所在目录（即 archive 解压/挂载后的目录）直接获取"
2. **不修改现有 aiphys 流程**：现有 `aether_*_installer.*` 和 `update_*` 脚本保持不变，in-app 更新仍走 aiphys
3. **安装后运行时结构一致**：GitHub 安装后产生的 `work/aether_$ver`、mirror 目录、`.aether_web_version`、桌面入口、协议注册、重启和 prune 语义必须与 aiphys 流程一致，确保 in-app 更新系统能正确发现已安装版本。GitHub 产物内的安装入口脚本差异是刻意差异：不再包含 `aether_*_installer.*`，改为 `install.*`
4. **不依赖安装来源**：程序内部行为不因安装来源不同而有差异
5. **程序内容不变**：不修改主程序、launcher、web、skills、wechat-bridge 等程序内容；`install.*` 只作为 GitHub 产物内的安装入口

## 三、现有流程分析

### 3.1 现有两阶段流程

#### 阶段一：Installer（从远程下载文件）

**macOS** (`Update/aether_darwin_installer.command`):
1. 检测架构 (`uname -m` → arm64/x64)
2. 确定工作目录 (`work = ~/.local/share/aether/update/aether`)
3. 确定安装目标目录 (`mirror = ~/Applications/aether`)
4. 从 `aether.aiphys.cn/download/latest/mac-{arch}.yml` 获取 manifest
5. 从 manifest 解析出版本号、archive URL、update script URL
6. 下载 archive (DMG) 和 update script 到 `work/downloads/`
7. 校验 SHA-512
8. 设置 `AETHER_MIRROR_ROOT` 和 `AETHER_CURRENT_DIR` 环境变量
9. 调用 update script: `bash update_darwin-{ver}.command {ver} --restart`

**Linux** (`Update/aether_linux_installer.sh`):
1. 检测架构 (`uname -m` → arm64/x64)
2. 确定工作目录 (`work = ~/.local/share/aether/update/aether`)
3. 确定安装目标目录 (`mirror = ~/.local/share/applications/aether`)
4. 从 `aether.aiphys.cn/download/latest/linux-{arch}.yml` 获取 manifest
5. 下载 archive (ZIP) 和 update script
6. 校验 SHA-512
7. 调用 update script: `bash update_linux-{ver}.sh install {ver} --restart`
8. 额外步骤：`ensure_libssl()` (libssl.so.3 兼容)

**Windows** (`Update/aether_windows_installer.bat`):
1. 确定工作目录 (`work = %USERPROFILE%\.local\share\aether\update\aether`)
2. 确定安装目标目录 (`mirror = %LOCALAPPDATA%\Programs\aether`)
3. 从 `aether.aiphys.cn/download/latest/windows-x64.yml` 获取 manifest
4. 下载 archive (ZIP) 和 update script
5. 校验 SHA-512
6. 调用 update script: `call update_windows-{ver}.bat {ver} --restart`

#### 阶段二：Update Script（执行实际安装）

**macOS** (`Update/update_darwin.command`):
1. 验证自身位于 `.../aether/downloads/` 目录
2. 在 `downloads/` 中查找 DMG 文件
3. `hdiutil attach` 挂载 DMG
4. `ditto` 从挂载卷拷贝文件到 `work/aether_{ver}/`
5. `chmod +x` 设置可执行权限
6. `xattr -cr` 清除隔离属性
7. 写 `.aether_web_version` 文件
8. `prune_versions()` 清理旧版本 (保留 1000 个)
9. Mirror: `ditto` 拷贝到 `mirror/aether_{ver}/`
10. 创建 `/Applications/Aether.app` (App Bundle):
    - `Contents/MacOS/Aether` — 探测已运行实例或启动 Aether.command 的 shell 脚本
    - `Contents/Info.plist` — 含 CFBundleIdentifier `cn.aiphys.aether.web`、URL scheme `aether://`
    - `Contents/Resources/appIcon-{ver}.icns` — 应用图标
    - `lsregister` 注册 App
11. 若 `--restart`: `stop_all_runtime()` → `boot()`

**Linux** (`Update/update_linux.sh`):
1. 验证自身位于 `.../aether/downloads/` 目录
2. 在 `downloads/` 中查找 ZIP 文件
3. 解压到临时目录
4. `pick_src()` 定位含 `aether` + `Aether.sh` 的目录
5. `cp -R` 拷贝到 `work/aether_{ver}/`
6. `chmod +x` 设置可执行权限
7. 写 `.aether_web_version` 文件
8. `fix_libssl()` — libssl.so.3 兼容修复:
   - 若系统缺少 `libssl.so.3`，查找兼容的 `libssl.so.1.x` + `libcrypto.so.1.x`
   - 用 `ldd` 验证兼容性
   - 创建 `$target/lib/` 目录及符号链接
   - 重命名 `Aether.sh` → `Aether.sh.real`，创建新的 wrapper 设置 `LD_LIBRARY_PATH`
9. `prune_versions()` 清理旧版本
10. Mirror: `cp -R` + `mv` 拷贝到 `mirror/aether_{ver}/`
11. `write_launch()`:
    - 创建 `~/.local/share/applications/aether.desktop`
    - 拷贝到 `~/Desktop/aether.desktop`
    - `update-desktop-database`
12. `register_protocol()`:
    - 创建 `~/.local/share/applications/aether-url-handler.desktop`
    - `xdg-mime default` 注册 `aether://` scheme
13. 若 `--restart`: `stop_all_runtime()` → `boot()`

**Windows** (`Update/update_windows.bat`):
1. 验证自身位于 `...\aether\downloads\` 目录
2. 在 `downloads\` 中查找 ZIP 文件
3. PowerShell `Expand-Archive` 解压
4. 递归搜索 `aether.exe` + `Aether.vbs` 所在目录
5. `robocopy /MIR` 拷贝到 `work\aether_{ver}\`
6. 写 `.aether_web_version` 文件
7. `prune_versions()` 清理旧版本
8. Mirror: `robocopy /MIR` 拷贝到 `mirror\aether_{ver}\`
9. `write_launch()`:
    - 创建桌面快捷方式 `Aether.lnk` → `Aether.vbs`
    - 创建开始菜单快捷方式
    - 设置图标 (从 `aether-icon.ico`)
10. `register_protocol()`:
    - 注册表 `HKCU:\Software\Classes\aether` 注册 `aether://` scheme
11. 若 `--restart`: `stop_runtime()` → 启动 `Aether.vbs`

### 3.2 当前 GitHub Release 产物内容

| 文件 | 平台 |
|------|------|
| `aether-darwin-arm64.dmg` | macOS ARM64 |
| `aether-darwin-x64.dmg` | macOS x64 |
| `latest-web-mac.yml` | macOS ARM64 manifest |
| `latest-web-mac-x64.yml` | macOS x64 manifest |
| `aether-linux-x64.zip` | Linux x64 |
| `aether-linux-arm64.zip` | Linux ARM64 |
| `latest-web-linux.yml` | Linux x64 manifest |
| `latest-web-linux-arm64.yml` | Linux ARM64 manifest |
| `aether-windows-x64.zip` | Windows x64 |
| `latest-web-windows.yml` | Windows x64 manifest |

#### archive 内部结构

**macOS DMG** (卷名 `Aether Web`):
```
aether-darwin-{arch}/
├── .aether_web_version
├── aether                        ← 主二进制 (+x)
├── Aether.command                ← 启动器 (+x)
├── aether_darwin_installer.command  ← 当前 GitHub 产物中的 aiphys 安装脚本 (本方案替换为 install.command)
├── aether-icon.icns
├── README_FIRST.txt
├── web/                          ← 前端 SPA
├── .opencode/skills/             ← 默认技能包
└── wechat-bridge/                ← 微信桥接 (条件包含)
```

**Linux ZIP**:
```
aether-linux-{arch}/
├── .aether_web_version
├── aether                        ← 主二进制 (+x)
├── Aether.sh                     ← 启动器 (+x)
├── aether-protocol-handler.sh    ← 协议处理器 (+x)
├── aether_linux_installer.sh     ← 当前 GitHub 产物中的 aiphys 安装脚本 (本方案替换为 install.sh)
├── aether-icon.png
├── aether-icon.svg
├── README_FIRST.txt
├── web/
├── .opencode/skills/
└── wechat-bridge/
```

**Windows ZIP**:
```
aether-windows-x64\
├── .aether_web_version
├── aether.exe                    ← 主二进制
├── Aether.vbs                    ← 启动器
├── aether-protocol-handler.vbs   ← 协议处理器
├── aether_windows_installer.bat  ← 当前 GitHub 产物中的 aiphys 安装脚本 (本方案替换为 install.bat)
├── aether-icon.ico
├── README_FIRST.txt
├── web\
├── .opencode\skills\
└── wechat-bridge\
```

## 四、实施方案

### 4.1 新建 3 个安装脚本

| 平台 | 源文件路径 | 产物中位置 |
|------|-----------|-----------|
| macOS | `Update/install.command` | `aether-darwin-{arch}/install.command` |
| Linux | `Update/install.sh` | `aether-linux-{arch}/install.sh` |
| Windows | `Update/install.bat` | `aether-windows-x64/install.bat` |

这 3 个脚本是新增源文件。现有 `Update/aether_*_installer.*` 和 `Update/update_*` 源文件不修改、不删除；但 GitHub web 打包产物中不再放入 `aether_*_installer.*`，改为放入对应的 `install.*`。

### 4.2 各脚本执行流程

#### macOS `install.command`

```
1.  架构检测:
    - `uname -m=arm64` → `arch=arm64`
    - `uname -m=x86_64` → `arch=x64`
    - 其他架构直接失败
2.  Debug logging 设置 (与 update_darwin.command 一致)
3.  Session re-exec (与 update_darwin.command 一致，防父进程组被杀)
4.  信号捕获 (SIGTERM/SIGINT/SIGHUP/SIGQUIT/SIGPIPE)
5.  参数解析:
    - [--path <dir>]  — 指定安装目录 (默认 ~/Applications/aether)
    - [--no-restart]  — 安装后不重启
    - [help]          — 显示帮助
6.  确定 SRC = 脚本自身所在目录 (已解析为绝对路径)
    - 先检查 SRC 是否直接包含 aether 和 Aether.command
    - 若不包含，再检查 SRC/aether-darwin-$arch/
    - 若当前目录或子目录架构与当前机器不一致，直接失败
7.  校验 SRC 中存在 aether 和 Aether.command
8.  从 SRC/.aether_web_version 读取版本号
9.  确定 work = ~/.local/share/aether/update/aether
10. 确定 mirror_root = --path 值 或 ~/Applications/aether (normalize: basename 非 aether 则追加)，并在脚本内部等价设置:
    - `AETHER_MIRROR_ROOT=mirror_root`
    - `AETHER_CURRENT_DIR=mirror_root/aether_$ver`
11. 创建 work 和 mirror_root 目录
12. 检测当前已安装版本 (只扫描 mirror_root/aether_* 目录，不用 work/aether_* 作为同版本短路依据)
13. 若 mirror_root 下已安装同版本 → 提示 "already up to date" 并退出；若仅 work/aether_$ver 存在，则不得退出，必须继续执行 mirror、桌面入口、协议注册和 restart 相关 post-install 步骤
14. target = work/aether_$ver
15. next = work/.aether_$ver.next (临时暂存目录)
16. rm -rf next, mkdir -p next
17. 将 SRC 内容拷贝到 next，保留 macOS 元数据：先 `ditto "$SRC" "$next"`（`ditto` 不支持排除参数），随后 `rm -f "$next/install.command"`，避免把安装入口脚本作为程序内容复制进最终版本目录
18. rm -rf target, mv next target (原子重命名)
19. chflags nohidden target 及其兄弟版本目录
20. chmod +x target/aether, target/Aether.command
21. 查找并 chmod +x wechat-bridge/runtime/uv/ 下的 uv 二进制
22. xattr -cr target/aether target/Aether.command (清除隔离属性)
23. 写 target/.aether_web_version
24. 删除 work/.aether_web_version (旧版遗留清理)
25. 删除 work/current (旧版遗留清理)
26. prune_versions(work, 1000, target)
27. Mirror 逻辑:
    - 使用第 10 步确定的 mirror_root/current_dir 语义
    - 若 current_dir 在 work 内 → 跳过 mirror
    - 否则: mirror_root 固定为第 10 步的安装目标目录
    - ditto target → mirror_root/aether_$ver
    - prune_versions(mirror_root, 1000, copy_target)
28. build_app (创建 /Applications/Aether.app 或 ~/Applications/Aether.app):
    - Contents/MacOS/Aether — shell 脚本: 探测已运行实例端口或启动 Aether.command
    - Contents/Info.plist — CFBundleIdentifier cn.aiphys.aether.web, URL scheme aether://
    - Contents/Resources/appIcon-{ver}.icns — 从 target/aether-icon.icns 拷贝
    - xattr -cr, lsregister
29. 若非 --no-restart:
    - stop_all_runtime (SIGTERM → 5s wait → SIGKILL)
    - boot (nohup Aether.command, AETHER_WEB_OPEN_FALLBACK_MS=3000)
30. 写结果文件 (web-update-result.env)
31. 打印安装摘要
```

与 `update_darwin.command` 的差异：
- **删除**：DMG 查找/挂载/卸载逻辑 (hdiutil attach/detach)、`downloads/` 目录验证、mount point 管理
- **替换**：文件来源从"挂载 DMG 后 ditto 挂载卷内容"变为"ditto 脚本所在目录内容"
- **新增**：`--path` 参数、`--no-restart` 参数、work/mirror 目录的创建，以及 installer 阶段原本传给 update script 的 mirror_root/current_dir 语义内置到本地脚本中
- **保留**：全部桌面集成 (App Bundle)、进程管理、prune、mirror、debug logging、session re-exec

#### Linux `install.sh`

```
1.  架构检测:
    - `uname -m=aarch64|arm64` → `arch=arm64`
    - `uname -m=x86_64|amd64` → `arch=x64`
    - 其他架构直接失败
2.  Debug logging 设置
3.  信号捕获
4.  参数解析:
    - [--path <dir>]  — 指定安装目录 (默认 ~/.local/share/applications/aether)
    - [--no-restart]  — 安装后不重启
    - [help]          — 显示帮助
5.  确定 SRC = 脚本自身所在目录 (已解析为绝对路径)
    - 先检查 SRC 是否直接包含 aether 和 Aether.sh
    - 若不包含，再检查 SRC/aether-linux-$arch/
    - 若当前目录或子目录架构与当前机器不一致，直接失败
6.  校验 SRC 中存在 aether 和 Aether.sh
7.  从 SRC/.aether_web_version 读取版本号
8.  确定 work = ~/.local/share/aether/update/aether
9.  确定 mirror_root = --path 值 或 ~/.local/share/applications/aether (normalize)，并在脚本内部等价设置:
    - `AETHER_MIRROR_ROOT=mirror_root`
    - `AETHER_CURRENT_DIR=mirror_root/aether_$ver`
10. 创建 work 和 mirror_root 目录
11. 检测当前已安装版本 (只扫描 mirror_root/aether_* 目录，不用 work/aether_* 作为同版本短路依据)
12. 若 mirror_root 下已安装同版本 → 提示并退出；若仅 work/aether_$ver 存在，则不得退出，必须继续执行 mirror、桌面入口、协议注册和 restart 相关 post-install 步骤
13. target = work/aether_$ver
14. next = work/.aether_$ver.next
15. rm -rf next, mkdir -p next
16. 将 SRC 内容拷贝到 next：先 `cp -R "$SRC"/. "$next"/`（`cp -R` 不支持排除参数），随后 `rm -f "$next/install.sh"`，避免把安装入口脚本作为程序内容复制进最终版本目录
17. rm -rf target, mv next target
18. 权限修复:
    - chmod +x target/aether
    - chmod +x target/Aether.sh
    - chmod +x target/aether-protocol-handler.sh (若存在)
    - chmod +x target/wechat-bridge/runtime/uv/uv-*linux*/uv (若存在)
19. 写 target/.aether_web_version
20. 删除 work/.aether_web_version, work/current
21. fix_libssl(target):
    - 若系统有 libssl.so.3 → 跳过
    - 否则: pick_pair() 用 ldd 验证兼容性
    - 创建 target/lib/ 及符号链接
    - 重命名 Aether.sh → Aether.sh.real，创建 wrapper 设置 LD_LIBRARY_PATH
22. prune_versions(work, 1000, target)
23. Mirror:
    - 使用第 9 步确定的 mirror_root/current_dir 语义
    - 若 current_dir 在 work 内 → 跳过
    - 否则: cp -R + mv 到 mirror_root/aether_$ver
    - prune_versions(mirror_root, 1000, copy_target)
24. ensure_libssl(start_target):
    - mirror 完成后，对最终启动目录执行与现有 Linux installer 阶段一致的 libssl 兼容保险
    - 若系统已有 libssl.so.3 → 跳过
    - 否则在最终启动目录创建兼容 symlink/wrapper；该步骤用于保持 aiphys init 安装流程一致
25. write_launch:
    - 创建 ~/.local/share/applications/aether.desktop
    - 拷贝到 ~/Desktop/aether.desktop
    - update-desktop-database
26. register_protocol:
    - 创建 ~/.local/share/applications/aether-url-handler.desktop
    - xdg-mime default 注册 aether:// scheme
27. 若非 --no-restart:
    - stop_all_runtime (SIGTERM → 5s → SIGKILL)
    - boot (setsid Aether.sh)
28. 写结果文件
29. 打印安装摘要
```

与 `update_linux.sh` 的差异：
- **删除**：ZIP 查找/解压逻辑 (unzip/tar)、`downloads/` 目录验证、临时解压目录管理
- **替换**：文件来源从"解压 ZIP 后 cp -R"变为"cp -R 脚本所在目录"
- **新增**：`--path` 参数、`--no-restart` 参数、work/mirror 目录的创建，以及 installer 阶段原本传给 update script 的 mirror_root/current_dir 语义内置到本地脚本中
- **保留**：全部 libssl 修复 (包含 update 阶段 target 修复和 installer 阶段 mirror 后兼容保险)、.desktop 创建、协议注册、进程管理、prune、mirror、debug logging

#### Windows `install.bat`

```
1.  平台限制: 仅支持 Windows x64 GitHub web 产物 `aether-windows-x64`
2.  参数解析:
    - [--path <dir>]      — 指定安装目录 (默认 %LOCALAPPDATA%\Programs\aether)
    - [--no-restart]      — 安装后不重启
    - [--no-pause]        — 结束后不等待用户关闭窗口
    - [help]              — 显示帮助
3.  若非 --no-pause，则默认启用 hold，成功或失败后提示 `Press Esc to close...`，与现有 Windows installer 一致；非交互环境不阻塞
4.  确定 SRC = 脚本自身所在目录
    - 先检查 SRC 是否直接包含 aether.exe 和 Aether.vbs
    - 若不包含，再检查 SRC\aether-windows-x64\
    - 若目录名或内容不匹配 Windows x64 产物，直接失败
5.  校验 SRC 中存在 aether.exe 和 Aether.vbs
6.  从 SRC\.aether_web_version 读取版本号
7.  确定 work = %USERPROFILE%\.local\share\aether\update\aether
8.  确定 mirror_root = --path 值 或 %LOCALAPPDATA%\Programs\aether，并在脚本内部等价设置:
    - `AETHER_MIRROR_ROOT=mirror_root`
    - `AETHER_CURRENT_DIR=mirror_root\aether_%VER%`
9.  创建 work 和 mirror_root 目录
10. 检测当前已安装版本 (只扫描 mirror_root\aether_* 目录，不用 work\aether_* 作为同版本短路依据)
11. 若 mirror_root 下已安装同版本 → 提示并退出；若仅 work\aether_%VER% 存在，则不得退出，必须继续执行 mirror、快捷方式、协议注册和 restart 相关 post-install 步骤
12. target = work\aether_%VER%
13. next = work\.aether_%VER%.next
14. robocopy SRC next /MIR /NFL /NDL /NJH /NJS /NP /XF install.bat，避免把安装入口脚本作为程序内容复制进最终版本目录
15. 若 robocopy exit >= 8 → 失败
16. 删除旧 target (rmdir /s /q)
17. move next target
18. 写 target\.aether_web_version
19. 删除 work\.aether_web_version, work\current
20. prune_versions(work, 1000, target)
21. Mirror:
    - 使用第 8 步确定的 mirror_root/current_dir 语义
    - 若 current_dir 不在 work 内:
      - robocopy target → mirror_root\aether_%VER%
      - prune_versions(mirror_root, 1000, mirror)
    - 若 current_dir 在 work 内 → 跳过 mirror
22. write_launch:
    - 创建桌面 Aether.lnk → Aether.vbs (含图标)
    - 创建开始菜单 Aether.lnk
23. register_protocol:
    - 注册表 HKCU:\Software\Classes\aether 注册 aether:// scheme
24. 若非 --no-restart:
    - stop_runtime (PowerShell WMI 查询 aether.exe 等进程)
    - 启动 Aether.vbs (AETHER_WEB_OPEN_FALLBACK_MS=3000)
25. 写结果文件
26. 打印安装摘要
27. 若 hold 已启用，等待 Esc 关闭窗口
```

与 `update_windows.bat` 的差异：
- **删除**：ZIP 查找/解压逻辑 (Expand-Archive)、`downloads\` 目录验证、临时解压目录
- **替换**：文件来源从"解压 ZIP 后 robocopy"变为"robocopy 脚本所在目录"
- **新增**：`--path` 参数、`--no-restart` 参数、`--no-pause` 参数、work/mirror 目录的创建，以及 installer 阶段原本传给 update script 的 mirror_root/current_dir 语义内置到本地脚本中
- **保留**：全部快捷方式创建、协议注册、进程管理、prune、mirror、debug logging

### 4.3 SRC 目录的自动检测

新脚本需要处理两种用户场景：

**场景 A — macOS**: 用户双击 DMG 挂载后，在 DMG 卷内运行脚本。此时脚本所在目录是 `aether-darwin-{arch}/`，里面直接有 `aether`、`Aether.command` 等文件。

**场景 B — 通用**: 用户先将文件夹从 DMG/ZIP 拷贝到本地，再运行脚本。此时脚本可能在 `aether-darwin-{arch}/` 目录内。

**场景 C — Linux/Windows ZIP**: ZIP 解压后有 `aether-linux-{arch}/` 或 `aether-windows-x64\` 子目录，脚本在该子目录内。

唯一检测逻辑：
1. 初始 `SRC = 脚本所在目录`
2. 先检查 `SRC` 是否直接包含当前平台必需文件：
   - macOS: `aether` + `Aether.command`
   - Linux: `aether` + `Aether.sh`
   - Windows: `aether.exe` + `Aether.vbs`
3. 若当前目录不满足，再检查当前目录下匹配当前平台和当前架构的子目录：
   - macOS: `SRC/aether-darwin-$arch`
   - Linux: `SRC/aether-linux-$arch`
   - Windows: `SRC\aether-windows-x64`
4. 找到后将 `SRC` 设为该子目录
5. 找不到、找到多个候选、或候选架构与当前机器不匹配，都报错退出

### 4.4 版本比较约束

新脚本必须完全沿用现有 installer/update 脚本的版本比较语义，不引入新的 semver 规则：

- bash 侧 `cmp()`：去掉前导 `v`，忽略 `-` 及其后的 prerelease 部分，最多比较 4 段数字
- Windows 侧 `cmp` / 排序：去掉前导 `v`，忽略 `-` 及其后的 prerelease 部分，再按 PowerShell `[version]` 比较
- `installed()`、`dir_version()`、`latest_dir()`、`prune_versions()` 中对版本目录的识别和排序也必须沿用现有脚本逻辑
- 这样可避免 GitHub 安装脚本与 aiphys 更新脚本对同一版本得出不同判断

### 4.5 修改 packing scripts

| 文件 | 修改内容 |
|------|---------|
| `packing_scripts/release-mac-web.sh` | 将 `cp "$root/Update/aether_darwin_installer.command"` 替换为 `cp "$root/Update/install.command"`；chmod +x；更新 README_FIRST.txt |
| `packing_scripts/release-linux-web.sh` | 将 `cp "$root/Update/aether_linux_installer.sh"` 替换为 `cp "$root/Update/install.sh"`；chmod +x；更新 README_FIRST.txt |
| `packing_scripts/release-windows-web.bat` | 将 `copy "%ROOT%\Update\aether_windows_installer.bat"` 替换为 `copy "%ROOT%\Update\install.bat"`；更新 README_FIRST.txt |

上述修改只改变 GitHub web 产物内的安装入口，不修改 `Update/aether_*_installer.*` 源文件。

### 4.6 README_FIRST.txt 更新

**macOS** (新内容):
```
Aether Web (macOS {ARCH})

Quick start
1) Open this DMG
2) In Finder, open the aether-darwin-{arch} folder
3) Right click install.command and choose Open
4) If macOS asks again, click Open in the security prompt

Troubleshooting
- If you see "cannot be opened" or "unidentified developer":
  Right click install.command -> Open, then confirm Open
- If execution permission is missing:
    chmod +x ./install.command

Updates
- Use Aether's in-app update flow to download and install newer versions.
```

**Linux** (新内容):
```
Aether Web (Linux {ARCH})

Quick start
1) Extract this ZIP
2) Open Terminal in the aether-linux-{arch} folder
3) Run: chmod +x install.sh && ./install.sh

Updates
- Use Aether's in-app update flow to download and install newer versions.
```

**Windows** (新内容):
```
Aether Web (Windows x64)

Quick start
1) Extract this ZIP
2) Open the aether-windows-x64 folder
3) Double click install.bat

Updates
- Use Aether's in-app update flow to download and install newer versions.
```

### 4.7 安装后运行时结构 (与 aiphys 流程一致)

```
# macOS
~/.local/share/aether/update/aether/     ← work 目录
  aether_1.2.3/                           ← 版本化安装目录
~/Applications/aether/                    ← mirror 目录
  aether_1.2.3/                           ← 镜像副本 (实际运行位置)
/Applications/Aether.app/                 ← App Bundle

# Linux
~/.local/share/aether/update/aether/     ← work 目录
  aether_1.2.3/
~/.local/share/applications/aether/      ← mirror 目录
  aether_1.2.3/
~/.local/share/applications/aether.desktop
~/.local/share/applications/aether-url-handler.desktop

# Windows
%USERPROFILE%\.local\share\aether\update\aether\   ← work 目录
  aether_1.2.3\
%LOCALAPPDATA%\Programs\aether\                     ← mirror 目录
  aether_1.2.3\
<Desktop>\Aether.lnk
<Start Menu>\Aether.lnk
HKCU:\Software\Classes\aether                       ← 协议注册
```

注：GitHub release 包内安装入口从 `aether_*_installer.*` 改为 `install.*` 是刻意差异。安装后的运行时目录不应依赖这些安装入口脚本；主程序、launcher、web、skills、wechat-bridge、版本 marker、桌面入口和协议注册保持与 aiphys 流程一致。

### 4.8 不修改的部分

- `packages/opencode/src/server/web-update.ts` — in-app 更新仍走 aiphys
- `packages/app/src/` — 前端更新逻辑不变
- `packages/opencode/launcher/Aether.{sh,command,vbs}` — 启动器不变
- `Update/update_darwin.command` / `update_linux.sh` / `update_windows.bat` — aiphys 流程的 update scripts 不变
- `Update/aether_*_installer.*` — aiphys 流程的 installers 不变
- `latest-web-*.yml` 格式 — 暂不增强
- `.github/workflows/publish.yml` — workflow 本身不修改，仅因 packing scripts 变更而间接影响产物内容
- `packages/opencode/script/build.ts` — 构建脚本不变 (launcher 脚本不变)

### 4.9 --path 默认值 (与现有 installer 一致)

| 平台 | 默认 mirror 目录 |
|------|----------------|
| macOS | `~/Applications/aether` |
| Linux | `~/.local/share/applications/aether` |
| Windows | `%LOCALAPPDATA%\Programs\aether` |

## 五、用户使用流程

### 全新安装

1. 用户在 GitHub Releases 页面下载对应平台的 DMG/ZIP
2. macOS: 双击 DMG 挂载 → 打开文件夹 → 右键 `install.command` → Open
3. Linux: 解压 ZIP → `chmod +x install.sh && ./install.sh`
4. Windows: 解压 ZIP → 双击 `install.bat`，或在普通命令提示符中运行 `install.bat`
5. 脚本自动完成：版本化安装、权限修复、桌面集成、启动应用

### 更新 (已安装旧版本)

1. 下载新版本的 DMG/ZIP
2. 运行 `install.*` 脚本
3. 脚本自动完成：停止旧进程、安装新版本到新版本化目录、更新桌面集成、清理旧版本、启动新版本

### 后续 in-app 更新

安装后，in-app 自动更新检查仍通过 aiphys 进行，不受安装来源影响。
