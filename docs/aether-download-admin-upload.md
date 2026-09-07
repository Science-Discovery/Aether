# Aether Download API 说明

本文档面向客户端开发者，说明 Aether 下载发布接口、下载地址约定，以及 macOS manifest 协议。

## 概览

Aether 客户端有两个产品线，各自有独立的产物集合、manifest 协议和自动更新通道：

- **Web 版**：包体以 `aether-` 开头（如 `aether-darwin-arm64.dmg`、`aether-windows-x64.zip`），manifest 为 Aether 自定义格式（`mac-arm64.yml`、`windows-x64.yml` 等），由服务端 commit 时重新计算校验并生成。
- **桌面版（Electron）**：包体以 `aether-desktop-` 开头，manifest 分两层：**L1 网站规范 manifest**（`desktop-mac-arm64.yml` 等，per-platform，schema 与 Web 版完全一致，由服务端 commit 时重算校验并生成）与 **L2 electron-builder 兼容 yml**（`latest*.yml`，随 GitHub Release 产物原样透传，仅供客户端自动更新，服务端不读不写）。

两套产物在 OSS 对象前缀、版本索引和下载路由上完全隔离。本文档前半部分（基础约定、OSS 直传、下载接口、macOS Manifest）默认描述 Web 版；桌面版的差异在 [桌面版（Electron）产物](#桌面版electron产物)、[桌面版electron-oss-直传上传](#桌面版electron-oss-直传上传)、[桌面版下载接口](#桌面版下载接口) 中集中说明。

Aether 下载服务分为两个发布渠道：

- **公开渠道** (`/download/`)：正式发布，支持版本化目录、manifest、OSS 推送
- **测试版渠道** (`/downloadbeta/`)：测试发布，结构与公开渠道一致，但版本索引和 OSS 存储与公开渠道隔离

信息站点推荐下载按钮使用独立安装器入口 `/download/installer/<filename>`，安装器对象固定放在 OSS 的 `installer/` 前缀下；补充说明中的手动安装包链接直接指向公开渠道的 `/download/latest/<filename>`，由服务端解析到当前最新公开版本。

每个渠道都有独立的管理员 OSS 直传接口。

**重要**：公开渠道和测试版渠道要求配置 `DOWNLOAD_OSS_PUBLIC_BASE_URL`，下载时通过 302 重定向到 OSS。未配置时下载接口会返回错误。

当前支持的平台：

- macOS Apple Silicon
- macOS Intel
- Windows x64
- Linux x64
- Linux ARM64

## 桌面版（Electron）产物

桌面版客户端基于 electron-builder 打包，产物随 GitHub Release 发布在 https://github.com/Science-Discovery/Aether 。桌面版的发布产物即 release 中以下三类文件，**包体与 L2 yml 原样上传，不做重命名或重新打包**：

1. **包体**：白名单内以 `aether-desktop` 开头的文件，含 mac 自动更新用的 `*.zip`、`*.blockmap`，以及 Linux x64/ARM64 的两个 `.deb` 安装包。
2. **L2 兼容 yml**：所有以 `latest` 开头、**文件名不含 `web`** 的 `.yml` 文件，供 electron-builder 客户端自动更新使用，原样透传。
3. **L1 网站 manifest**：`desktop-mac-arm64.yml` / `desktop-mac-x64.yml` / `desktop-win-x64.yml` / `desktop-win-arm64.yml` / `desktop-linux-x64.yml` / `desktop-linux-arm64.yml`，**不来自 GitHub Release**，由服务端 commit 时基于已上传的主包体重算校验并生成（schema 与 Web 版 `mac-arm64.yml` 完全一致）。

以 v0.7.1 release 为例，桌面版产物清单为：

```text
aether-desktop-mac-arm64.dmg            aether-desktop-mac-arm64.dmg.blockmap
aether-desktop-mac-arm64.zip            aether-desktop-mac-arm64.zip.blockmap
aether-desktop-mac-x64.dmg              aether-desktop-mac-x64.dmg.blockmap
aether-desktop-mac-x64.zip              aether-desktop-mac-x64.zip.blockmap
aether-desktop-win-x64.exe              aether-desktop-win-x64.exe.blockmap
aether-desktop-win-arm64.exe            aether-desktop-win-arm64.exe.blockmap
aether-desktop-linux-amd64.deb
aether-desktop-linux-arm64.deb
latest.yml                  # Windows 自动更新
latest-mac.yml              # macOS 自动更新（arm64 + x64）
latest-linux.yml            # Linux x64 自动更新
latest-linux-arm64.yml      # Linux ARM64 自动更新
```

服务端 commit 时额外生成的 L1 manifest（不在 GitHub Release 中，写入 OSS 同一版本目录）：

```text
desktop-mac-arm64.yml       desktop-mac-x64.yml
desktop-win-x64.yml         desktop-win-arm64.yml
desktop-linux-x64.yml       desktop-linux-arm64.yml
```

必须排除的文件（属于 Web 版的 electron-builder yml，**不要**作为桌面版上传）：

```text
latest-web-windows.yml
latest-web-mac.yml
latest-web-mac-x64.yml
latest-web-linux.yml
latest-web-linux-arm64.yml
```

### 上传与生成原则

- **L2 兼容 yml 原样透传**：electron-builder 的 `latest*.yml` 内 `path` / `files[].path` 字段引用的是同目录下的包体文件名（含 `.blockmap`），重命名会破坏自动更新签名校验，因此 L2 yml 与包体必须保留 GitHub Release 上的原始文件名。
- **L1 manifest 由服务端生成**：commit 阶段服务端基于各平台主包（dmg/exe/deb）的 `sha512`/`size` 生成 `desktop-<platform>.yml` 并写回 OSS 同一版本目录，schema 与 Web 版 `buildLatestWebManifest` 输出完全一致。桌面版 commit 优先使用上传端提交的 `fileMetadata`，并通过 OSS HEAD 校验 `size`；未提交 metadata 时才由服务端从 OSS 流式读取主包回算 `sha512`/`size`。
- **L1 与 L2 解耦**：L2 yml 仅供 electron-builder 客户端自动更新，服务端不读不写；L1 manifest 是网站权威元数据，供信息站点下载页与统计读取。网站不再因 release 格式而特例化。
- 同一版本目录下 L1 manifest、L2 yml 与包体必须共存。

## 基础约定

下载根路径：

```text
https://aether.aiphys.cn/download       # 公开渠道
https://aether.aiphys.cn/downloadbeta   # 测试版渠道
```

管理员 OSS 直传接口（公开渠道）：

```text
POST https://aether.aiphys.cn/api/download/admin/presign   # 获取预签名 URL
POST https://aether.aiphys.cn/api/download/admin/commit     # 提交元数据，触发服务端处理
```

管理员 OSS 直传接口（测试版渠道）：

```text
POST https://aether.aiphys.cn/api/downloadbeta/admin/presign   # 获取预签名 URL
POST https://aether.aiphys.cn/api/downloadbeta/admin/commit     # 提交元数据，触发服务端处理
```

公开渠道版本目录约定：

- 最新通道：`/download/latest/`
- 解析规则：`latest` 会按平台读取 `downloads/latest-versions.json` 中配置的版本，不扫描 OSS 或本地版本目录
- 指定版本：`/download/<version>/`

例如：

- `/download/latest/mac-arm64.yml`
- `/download/latest/aether-darwin-arm64.dmg`
- `/download/1.3.3/mac-arm64.yml`
- `/download/1.3.3/aether-darwin-arm64.dmg`

测试版渠道版本目录约定：

- 最新通道：`/downloadbeta/latest/`
- 解析规则：`latest` 会按平台读取 `downloads/beta-latest-versions.json` 中配置的版本，不影响公开渠道
- 指定版本：`/downloadbeta/<version>/`

例如：

- `/downloadbeta/latest/mac-arm64.yml`
- `/downloadbeta/latest/aether-darwin-arm64.dmg`
- `/downloadbeta/1.3.3-beta.1/mac-arm64.yml`
- `/downloadbeta/1.3.3-beta.1/aether-darwin-arm64.dmg`

桌面版版本目录约定（两个渠道一致，根路径同上文，仅在渠道根之后增加 `desktop` 段）：

- 最新通道：`/download/desktop/latest/`、`/downloadbeta/desktop/latest/`
- 解析规则：`latest` 读取桌面版版本索引（公开渠道 `downloads/desktop-latest-versions.json`，测试版 `downloads/beta-desktop-latest-versions.json`），不扫描 OSS 或本地版本目录
- 指定版本：`/download/desktop/<version>/`、`/downloadbeta/desktop/<version>/`

例如：

- `/download/desktop/latest/latest-mac.yml`
- `/download/desktop/latest/desktop-mac-arm64.yml`
- `/download/desktop/latest/aether-desktop-mac-arm64.dmg`
- `/download/desktop/0.7.1/latest.yml`
- `/download/desktop/0.7.1/desktop-win-x64.yml`
- `/downloadbeta/desktop/0.7.2-beta.1/latest-linux-arm64.yml`

## 公开渠道 OSS 直传上传

服务端配置了 `ALIYUN_OSS_*` 环境变量后，大文件从客户端直传 OSS，不经过服务器中转，速度更快、节省服务器带宽。

流程分为三步：

1. **presign** — 获取各平台文件的 OSS 预签名 PUT URL
2. **upload** — 客户端并行直传文件到 OSS
3. **commit** — 通知服务端计算校验信息、生成 manifest、更新版本记录

### Step 1: 获取预签名 URL

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/download/admin/presign`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体示例：

```json
{
  "mac": { "version": "1.3.3" },
  "macIntel": { "version": "1.3.3" },
  "windows": { "version": "1.3.3" },
  "linux": { "version": "1.3.3" },
  "linuxArm64": { "version": "1.3.3" }
}
```

响应示例：

```json
{
  "ok": true,
  "platforms": {
    "mac": {
      "archive": {
        "objectKey": "1.3.3/aether-darwin-arm64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/aether-darwin-arm64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "1.3.3/update_darwin.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/update_darwin.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "macIntel": {
      "archive": {
        "objectKey": "1.3.3/aether-darwin-x64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/aether-darwin-x64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "1.3.3/update_darwin_x64.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/update_darwin_x64.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "windows": { ... },
    "linux": { ... },
    "linuxArm64": {
      "archive": {
        "objectKey": "1.3.3/aether-linux-arm64.zip",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/aether-linux-arm64.zip?x-oss-signature-version=...",
        "contentType": "application/zip"
      },
      "installer": {
        "objectKey": "1.3.3/update_linux_arm64.sh",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/update_linux_arm64.sh?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    }
  },
  "expiresInSeconds": 1800
}
```

### Step 2: 直传文件到 OSS

使用预签名 URL 将文件 PUT 到 OSS：

```bash
# 并行上传三个平台的主包
curl -X PUT \
  -H 'Content-Type: application/x-apple-diskimage' \
  --data-binary @aether-darwin-arm64.dmg \
  '<mac archive presigned url>' &

curl -X PUT \
  -H 'Content-Type: application/zip' \
  --data-binary @aether-windows-x64.zip \
  '<windows archive presigned url>' &

curl -X PUT \
  -H 'Content-Type: application/zip' \
  --data-binary @aether-linux-x64.zip \
  '<linux archive presigned url>' &

wait
```

### Step 3: 提交元数据

所有文件上传到 OSS 后，调用 commit 接口通知服务端完成后续处理。

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/download/admin/commit`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体示例：

```json
{
  "mac": { "version": "1.3.3" },
  "macIntel": { "version": "1.3.3" },
  "windows": { "version": "1.3.3" },
  "linux": { "version": "1.3.3" },
  "linuxArm64": { "version": "1.3.3" },
  "releaseDate": "2026-04-13T00:00:00.000Z"
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `<platform>.version` | 是 | 该平台的版本号 |
| `releaseDate` | 否 | ISO 时间字符串，不传由服务端生成 |

响应格式与公开上传接口相同。

服务端处理流程：

1. 从 OSS 下载各平台的安装包（走内网，速度快）
2. 计算安装包的 `sha512` 和 `size`
3. 生成 manifest 并写入 OSS 的 `{version}/` 目录
4. 更新 `downloads/latest-versions.json`

服务端不会把安装包、版本安装脚本或 manifest 写入本地 `downloads/{version}/` 或 `downloads/latest/`。运行时唯一允许写入 `downloads/` 的文件是 `downloads/latest-versions.json`。

### 公开安装器 OSS key

下载页的安装器链接会重定向到 OSS 的固定 `installer/` 前缀，不走版本目录：

```text
installer/aether_windows_installer.bat
installer/aether_darwin_installer.command
installer/aether_darwin_x64_installer.command
installer/aether_linux_installer.sh
installer/aether_linux_arm64_installer.sh
```

如果 OSS 返回 `NoSuchKey`，要先确认上传的是上面的完整 key。尤其 Linux ARM64 安装器必须是：

```text
installer/aether_linux_arm64_installer.sh
```

`installer/aether_linux_installer_arm64.sh` 是另一个不同对象，上传这个名字不会被 `/download/installer/aether_linux_arm64_installer.sh` 命中。

## 测试版渠道 OSS 直传上传

测试版渠道用于发布可被客户端自动更新读取的 beta 产物。接口协议与公开渠道一致，但存储、版本索引和下载路径必须与公开渠道隔离。
下载成功统计也与公开渠道隔离：页面下载路由上报 `download_channel = 'download_beta'`，API 下载路由上报 `download_channel = 'api_download_beta'`。

流程分为三步：

1. **presign** — 获取各平台文件的 OSS 预签名 PUT URL
2. **upload** — 客户端并行直传文件到 OSS
3. **commit** — 通知服务端计算校验信息、生成 manifest、更新测试版版本记录

### Step 1: 获取预签名 URL

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/downloadbeta/admin/presign`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体与公开渠道相同：

```json
{
  "mac": { "version": "1.3.3-beta.1" },
  "macIntel": { "version": "1.3.3-beta.1" },
  "windows": { "version": "1.3.3-beta.1" },
  "linux": { "version": "1.3.3-beta.1" },
  "linuxArm64": { "version": "1.3.3-beta.1" }
}
```

响应格式与公开渠道相同。测试版对象必须写入独立 OSS 前缀，建议使用 `beta/<version>/...`：

```json
{
  "ok": true,
  "platforms": {
    "mac": {
      "archive": {
        "objectKey": "beta/1.3.3-beta.1/aether-darwin-arm64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/aether-darwin-arm64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "beta/1.3.3-beta.1/update_darwin.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/update_darwin.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "macIntel": {
      "archive": {
        "objectKey": "beta/1.3.3-beta.1/aether-darwin-x64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/aether-darwin-x64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "beta/1.3.3-beta.1/update_darwin_x64.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/update_darwin_x64.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "windows": { ... },
    "linux": { ... },
    "linuxArm64": {
      "archive": {
        "objectKey": "beta/1.3.3-beta.1/aether-linux-arm64.zip",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/aether-linux-arm64.zip?x-oss-signature-version=...",
        "contentType": "application/zip"
      },
      "installer": {
        "objectKey": "beta/1.3.3-beta.1/update_linux_arm64.sh",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/update_linux_arm64.sh?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    }
  },
  "expiresInSeconds": 1800
}
```

### Step 2: 直传文件到 OSS

上传方式与公开渠道相同，使用 presign 响应中的 URL 执行 PUT。

### Step 3: 提交元数据

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/downloadbeta/admin/commit`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体与公开渠道相同：

```json
{
  "mac": { "version": "1.3.3-beta.1" },
  "macIntel": { "version": "1.3.3-beta.1" },
  "windows": { "version": "1.3.3-beta.1" },
  "linux": { "version": "1.3.3-beta.1" },
  "linuxArm64": { "version": "1.3.3-beta.1" },
  "releaseDate": "2026-04-13T00:00:00.000Z"
}
```

服务端处理流程：

1. 从 OSS 的 `beta/<version>/` 前缀读取各平台安装包
2. 计算安装包的 `sha512` 和 `size`
3. 生成 manifest 并写入 OSS 的 `beta/<version>/` 目录
4. 更新测试版 latest 索引，当前实现写入 `downloads/beta-latest-versions.json`

测试版 commit 响应中的下载链接必须指向 `/downloadbeta`，例如：

```json
{
  "ok": true,
  "releaseDate": "2026-04-13T00:00:00.000Z",
  "files": [
    {
      "platform": "mac",
      "version": "1.3.3-beta.1",
      "url": "/downloadbeta/1.3.3-beta.1/aether-darwin-arm64.dmg",
      "latestUrl": "/downloadbeta/latest/aether-darwin-arm64.dmg",
      "manifestUrl": "/downloadbeta/1.3.3-beta.1/mac-arm64.yml",
      "latestManifestUrl": "/downloadbeta/latest/mac-arm64.yml",
      "sha512": "<base64-sha512>",
      "size": 93444053,
      "installerUrl": "/downloadbeta/1.3.3-beta.1/update_darwin.command",
      "latestInstallerUrl": "/downloadbeta/latest/update_darwin.command"
    }
  ]
}
```

## 桌面版（Electron）OSS 直传上传

桌面版与 Web 版共用同一组管理员直传接口（`/api/download/admin/*` 与 `/api/downloadbeta/admin/*`），区别仅在请求体新增 `desktop` 段、OSS 对象 key 前缀改为 `desktop/<version>/`（测试版为 `beta/desktop/<version>/`）。commit 阶段服务端对**主包**生成 L1 per-platform manifest（与 Web 版发布语义同构），但对 **L2 yml 与 blockmap** 原样采用上游产物、不重写。为避免桌面版大包在单个 HTTP 请求中反复下载，上传端应在 commit 请求中提供主包 `sha512`/`size`；服务端会用 OSS HEAD 校验 size，未提供时才流式回算。

发布渠道约束：

- **测试版渠道**：由自动上传脚本从 GitHub Release 拉取桌面版产物后调用 `/api/downloadbeta/admin/presign` + `commit`，把桌面版纳入测试版自动更新通道。
- **公开渠道**：保持手动上传，由管理员调用 `/api/download/admin/presign` + `commit`。

流程同样分为三步：presign → upload → commit。

### Web Console 单 ZIP upsert

管理员控制台支持选择一个 `.zip` 桌面版发布包。ZIP 仅在浏览器本地读取，应用服务器不接收、不落盘；控制台从 ZIP 中逐个提取产物，再复用下述 presign 接口直传 OSS。ZIP 内可以是完整的 18 个文件，也可以是一个待合并的子集。

ZIP 内容约束：

- 产物可以位于 ZIP 根目录或外层目录中，最终文件名必须属于 `DESKTOP_UPLOAD_FILENAMES` 白名单
- 不允许重复文件名、未知文件、路径穿越或 L1 `desktop-*.yml`
- 同一渠道和版本下，本次上传的同名对象覆盖 OSS 已有对象；ZIP 未包含的对象保持不变
- 管理员可以向已发布版本继续上传并覆盖同名 OSS 对象；ZIP 未包含的对象仍保持不变，commit 后会重新生成 L1 manifest 并更新 latest 索引
- 如果 upsert 后 18 个产物仍不完整，commit 返回 `status: "draft"` 和 `missingFiles`，不生成 L1 manifest、不更新 latest 索引
- 如果最终集合完整，commit 生成全部 6 个 L1 manifest，并返回 `status: "published"`

外层 ZIP 建议使用 store 模式，不要再次压缩已经压缩过的 dmg、zip、exe、deb 等大文件。例如：

```bash
zip -0 aether-desktop-0.8.0.zip \
  aether-desktop-* latest.yml latest-mac.yml latest-linux.yml latest-linux-arm64.yml
```

控制台仍保留逐文件上传作为高级模式；单文件与 ZIP 同时包含同名产物时，单文件优先。

### Step 1: 获取预签名 URL（桌面版）

- Method: `POST`
- URL:
  - 公开渠道：`https://aether.aiphys.cn/api/download/admin/presign`
  - 测试版渠道：`https://aether.aiphys.cn/api/downloadbeta/admin/presign`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体在 Web 版字段之外新增 `desktop` 段，`files` 为本次要上传的桌面版文件名清单（必须与 GitHub Release 原始文件名一致，顺序不限）：

```json
{
  "desktop": {
    "version": "0.7.2-beta.1",
    "files": [
      "aether-desktop-mac-arm64.dmg",
      "aether-desktop-mac-arm64.dmg.blockmap",
      "aether-desktop-mac-arm64.zip",
      "aether-desktop-mac-arm64.zip.blockmap",
      "aether-desktop-mac-x64.dmg",
      "aether-desktop-mac-x64.dmg.blockmap",
      "aether-desktop-mac-x64.zip",
      "aether-desktop-mac-x64.zip.blockmap",
      "aether-desktop-win-x64.exe",
      "aether-desktop-win-x64.exe.blockmap",
      "aether-desktop-win-arm64.exe",
      "aether-desktop-win-arm64.exe.blockmap",
      "aether-desktop-linux-amd64.deb",
      "aether-desktop-linux-arm64.deb",
      "latest.yml",
      "latest-mac.yml",
      "latest-linux.yml",
      "latest-linux-arm64.yml"
    ]
  }
}
```

服务端校验文件名必须匹配桌面版产物白名单（`aether-desktop-*` 包体及其 `.blockmap`、或非 `web` 的 `latest*.yml`），拒绝 `latest-web-*.yml` 等非桌面版文件。

响应示例（测试版渠道）：

```json
{
  "ok": true,
  "desktop": {
    "version": "0.7.2-beta.1",
    "files": [
      {
        "objectKey": "beta/desktop/0.7.2-beta.1/aether-desktop-mac-arm64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/desktop/0.7.2-beta.1/aether-desktop-mac-arm64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      {
        "objectKey": "beta/desktop/0.7.2-beta.1/latest-mac.yml",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/desktop/0.7.2-beta.1/latest-mac.yml?x-oss-signature-version=...",
        "contentType": "application/x-yaml; charset=utf-8"
      }
    ]
  },
  "expiresInSeconds": 1800
}
```

公开渠道的对象 key 不带 `beta/` 前缀，例如 `desktop/0.7.1/aether-desktop-mac-arm64.dmg`。

### Step 2: 直传文件到 OSS

使用预签名 URL 将各文件**原样** PUT 到 OSS，`Content-Type` 用响应中返回的 `contentType`。`*.blockmap`、`*.zip`、yml 均需逐一上传，缺一会导致 electron-builder 自动更新解析失败。

桌面版文件数量和体积都明显大于 Web 版，上传端建议限制 OSS PUT 并发数，当前 Web Console 桌面版上传限制为最多 3 个文件同时上传；自动上传脚本也应采用相同或更低的并发上限。

### Step 3: 提交元数据（桌面版）

- Method: `POST`
- URL:
  - 公开渠道：`https://aether.aiphys.cn/api/download/admin/commit`
  - 测试版渠道：`https://aether.aiphys.cn/api/downloadbeta/admin/commit`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体：

```json
{
  "desktop": {
    "version": "0.7.2-beta.1",
    "fileMetadata": {
      "aether-desktop-mac-arm64.dmg": {
        "sha512": "<base64-sha512>",
        "size": 93444053
      },
      "aether-desktop-mac-x64.dmg": {
        "sha512": "<base64-sha512>",
        "size": 93444053
      },
      "aether-desktop-win-x64.exe": {
        "sha512": "<base64-sha512>",
        "size": 93444053
      },
      "aether-desktop-win-arm64.exe": {
        "sha512": "<base64-sha512>",
        "size": 93444053
      },
      "aether-desktop-linux-amd64.deb": {
        "sha512": "<base64-sha512>",
        "size": 93444053
      },
      "aether-desktop-linux-arm64.deb": {
        "sha512": "<base64-sha512>",
        "size": 93444053
      }
    }
  },
  "releaseDate": "2026-07-03T00:00:00.000Z"
}
```

`mode` 与 `files` 是单 ZIP/增量上传使用的字段：

- `mode: "upsert"` 时，`files` 必须是非空且无重复的桌面产物白名单子集
- 不传 `mode` 时使用原有 `strict` 语义，要求目标版本目录已经包含完整的 18 个产物；用于兼容旧上传脚本
- `files` 表示客户端声明的本次 PUT 对象，并在响应中原样返回；未列出的已有对象不会删除
- `fileMetadata` 在 upsert 模式下只能包含本次 `files` 中的主包

增量请求示例：

```json
{
  "desktop": {
    "version": "0.8.0",
    "mode": "upsert",
    "files": [
      "aether-desktop-linux-arm64.deb",
      "latest-linux-arm64.yml"
    ],
    "fileMetadata": {
      "aether-desktop-linux-arm64.deb": {
        "sha512": "<base64-sha512>",
        "size": 93444053
      }
    }
  }
}
```

`fileMetadata` 推荐填写 6 个 L1 主包文件（macOS dmg、Windows exe、Linux deb）的 Base64 SHA-512 与字节数。当前 Web Console 会在桌面版 commit 前计算并提交这些 metadata。为兼容旧上传脚本，该字段可省略；省略时服务端会从 OSS 流式读取主包计算 `sha512`/`size`，请求耗时会明显增加。

服务端处理流程（与 Web 版 commit 同构）：

1. HEAD 检查 OSS 中 `desktop/<version>/`（或 `beta/desktop/<version>/`）下完整的 18 个 L2 yml 与包体；只把 OSS `404` 视为缺失，其他 OSS 错误直接中止
2. `upsert` 模式下如果仍有缺失，返回 draft 状态与缺失清单，不生成 L1 manifest、不更新 latest 索引
3. 对各平台主包（dmg/exe/deb）优先使用请求中的 `fileMetadata`，并用 OSS HEAD 校验 `size`；未提供 metadata 时流式读取 OSS 对象计算 `sha512` 和 `size`
4. 生成 L1 per-platform manifest 并写入 OSS 的 `desktop/<version>/desktop-<platform>.yml`（测试版 `beta/desktop/<version>/...`）
5. 所有 manifest 写入成功后才更新桌面版 latest 索引：公开渠道写入 `downloads/desktop-latest-versions.json`，测试版写入 `downloads/beta-desktop-latest-versions.json`，结构为 per-platform version map（与 Web 版 `latest-versions.json` 同构），例如 `{ "desktopMacArm64": "0.7.2-beta.1", "desktopWinX64": "0.7.2-beta.1", ... }`
6. **不**重写、不重新计算 L2 yml 与 blockmap（L2 为上游原样产物，仅供客户端自动更新）

增量包尚未补齐时返回 `200`：

```json
{
  "ok": true,
  "releaseDate": "2026-08-03T00:00:00.000Z",
  "desktop": {
    "version": "0.8.0",
    "channel": "public",
    "status": "draft",
    "uploadedFiles": ["aether-desktop-linux-arm64.deb"],
    "missingFiles": ["latest-linux-arm64.yml"]
  },
  "files": []
}
```

commit 响应示例（测试版渠道，与 Web 版 `files[]` 同构）：

```json
{
  "ok": true,
  "releaseDate": "2026-07-03T00:00:00.000Z",
  "desktop": {
    "version": "0.7.2-beta.1",
    "channel": "beta",
    "status": "published",
    "files": [
      {
        "platform": "desktopMacArm64",
        "version": "0.7.2-beta.1",
        "url": "/downloadbeta/desktop/0.7.2-beta.1/aether-desktop-mac-arm64.dmg",
        "latestUrl": "/downloadbeta/desktop/latest/aether-desktop-mac-arm64.dmg",
        "manifestUrl": "/downloadbeta/desktop/0.7.2-beta.1/desktop-mac-arm64.yml",
        "latestManifestUrl": "/downloadbeta/desktop/latest/desktop-mac-arm64.yml",
        "sha512": "<base64-sha512>",
        "size": 93444053
      }
    ]
  }
}
```

## 手动安装包下载接口

信息站点推荐下载按钮使用 `/download/installer/<filename>` 安装器入口；安装器会自动拉取最新包体。补充说明中的"手动安装"链接直接使用公开渠道最新安装包，无需维护独立 manual 对象。

下载路径：

```text
/download/latest/aether-darwin-arm64.dmg
/download/latest/aether-darwin-x64.dmg
/download/latest/aether-windows-x64.zip
/download/latest/aether-linux-x64.zip
/download/latest/aether-linux-arm64.zip
```

说明：

- `latest` 会按平台读取 `downloads/latest-versions.json` 中配置的版本
- 通过 302 重定向到 OSS 公开地址
- 下载成功后按公开渠道上报 analytics 事件

## 下载接口

### 下载模式

公开渠道和测试版渠道要求配置 `DOWNLOAD_OSS_PUBLIC_BASE_URL`，通过 302 重定向到 OSS 对象地址。未配置时返回错误。

例如：

- `/download/latest/aether-darwin-arm64.dmg` 会先解析 `latest` 到具体版本（如 `1.4.1`），再重定向到 `https://<bucket-endpoint>/1.4.1/aether-darwin-arm64.dmg`
- `/downloadbeta/latest/aether-darwin-arm64.dmg` 会先解析测试版 `latest` 到具体版本（如 `1.4.2-beta.1`），再重定向到 `https://<bucket-endpoint>/beta/1.4.2-beta.1/aether-darwin-arm64.dmg`
- `/download/1.3.3/aether-windows-x64.zip` 会重定向到 `https://<bucket-endpoint>/1.3.3/aether-windows-x64.zip`
- `/download/1.3.3/aether-linux-arm64.zip` 会重定向到 `https://<bucket-endpoint>/1.3.3/aether-linux-arm64.zip`
- `/downloadbeta/1.3.3-beta.1/aether-windows-x64.zip` 会重定向到 `https://<bucket-endpoint>/beta/1.3.3-beta.1/aether-windows-x64.zip`
- `/downloadbeta/1.3.3-beta.1/aether-linux-arm64.zip` 会重定向到 `https://<bucket-endpoint>/beta/1.3.3-beta.1/aether-linux-arm64.zip`

### 最新通道

客户端可以通过 `latest` 路由获取某个平台当前发布的最新公开版本：

- `/download/latest/mac-arm64.yml`
- `/download/latest/mac-x64.yml`
- `/download/latest/windows-x64.yml`
- `/download/latest/linux-x64.yml`
- `/download/latest/linux-arm64.yml`

对应安装包：

- `/download/latest/aether-darwin-arm64.dmg`
- `/download/latest/update_darwin.command`
- `/download/latest/aether-darwin-x64.dmg`
- `/download/latest/update_darwin_x64.command`
- `/download/latest/aether-windows-x64.zip`
- `/download/latest/update_windows.bat`
- `/download/latest/aether-linux-x64.zip`
- `/download/latest/update_linux.sh`
- `/download/latest/aether-linux-arm64.zip`
- `/download/latest/update_linux_arm64.sh`

解析规则：

- `latest` 不扫描版本目录，也不会按语义版本号自动选择最大版本
- 公开渠道读取 `downloads/latest-versions.json`，测试版渠道读取 `downloads/beta-latest-versions.json`
- 每个平台独立配置最新版本，例如 `mac`、`macIntel`、`windows`、`linux`、`linuxArm64` 可以指向不同版本
- 如果对应平台没有配置最新版本，package / 安装脚本请求会返回错误；manifest 请求会保留字面量 `latest` 作为回退路径

测试版渠道使用相同文件名和解析规则，但根路径改为 `/downloadbeta`，且只读取测试版版本索引：

- `/downloadbeta/latest/mac-arm64.yml`
- `/downloadbeta/latest/mac-x64.yml`
- `/downloadbeta/latest/windows-x64.yml`
- `/downloadbeta/latest/linux-x64.yml`
- `/downloadbeta/latest/linux-arm64.yml`
- `/downloadbeta/latest/aether-darwin-arm64.dmg`
- `/downloadbeta/latest/update_darwin.command`
- `/downloadbeta/latest/aether-darwin-x64.dmg`
- `/downloadbeta/latest/update_darwin_x64.command`
- `/downloadbeta/latest/aether-windows-x64.zip`
- `/downloadbeta/latest/update_windows.bat`
- `/downloadbeta/latest/aether-linux-x64.zip`
- `/downloadbeta/latest/update_linux.sh`
- `/downloadbeta/latest/aether-linux-arm64.zip`
- `/downloadbeta/latest/update_linux_arm64.sh`

### 指定版本

客户端也可以显式拉取某个版本：

- `/download/<version>/mac-arm64.yml`
- `/download/<version>/mac-x64.yml`
- `/download/<version>/windows-x64.yml`
- `/download/<version>/linux-x64.yml`
- `/download/<version>/linux-arm64.yml`

对应安装包：

- `/download/<version>/aether-darwin-arm64.dmg`
- `/download/<version>/update_darwin.command`
- `/download/<version>/aether-darwin-x64.dmg`
- `/download/<version>/update_darwin_x64.command`
- `/download/<version>/aether-windows-x64.zip`
- `/download/<version>/update_windows.bat`
- `/download/<version>/aether-linux-x64.zip`
- `/download/<version>/update_linux.sh`
- `/download/<version>/aether-linux-arm64.zip`
- `/download/<version>/update_linux_arm64.sh`

测试版渠道的指定版本路径同样只需把根路径替换为 `/downloadbeta`：

- `/downloadbeta/<version>/mac-arm64.yml`
- `/downloadbeta/<version>/mac-x64.yml`
- `/downloadbeta/<version>/windows-x64.yml`
- `/downloadbeta/<version>/linux-x64.yml`
- `/downloadbeta/<version>/linux-arm64.yml`
- `/downloadbeta/<version>/aether-darwin-arm64.dmg`
- `/downloadbeta/<version>/update_darwin.command`
- `/downloadbeta/<version>/aether-darwin-x64.dmg`
- `/downloadbeta/<version>/update_darwin_x64.command`
- `/downloadbeta/<version>/aether-windows-x64.zip`
- `/downloadbeta/<version>/update_windows.bat`
- `/downloadbeta/<version>/aether-linux-x64.zip`
- `/downloadbeta/<version>/update_linux.sh`
- `/downloadbeta/<version>/aether-linux-arm64.zip`
- `/downloadbeta/<version>/update_linux_arm64.sh`

- `/downloadbeta/<version>/aether-linux-arm64.zip`
- `/downloadbeta/<version>/update_linux_arm64.sh`

## 桌面版下载接口

桌面版下载路由在 Web 版路由之下增加一段 `desktop`，两个渠道一致：

- 公开：`/download/desktop/<version>/<filename>`、`/download/desktop/latest/<filename>`
- 测试版：`/downloadbeta/desktop/<version>/<filename>`、`/downloadbeta/desktop/latest/<filename>`

`<filename>` 必须在桌面版产物白名单内（`aether-desktop-*` 包体及其 `.blockmap`、非 `web` 的 `latest*.yml` L2 兼容 yml、或 `desktop-*.yml` L1 manifest），否则返回错误，避免与 Web 版文件混用。

### 最新通道（桌面版）

**L1 网站 manifest**（服务端生成，信息站点/统计读取，inline + no-store + 上报 update-check 事件，与 Web 版 manifest 路由同构）：

- `/download/desktop/latest/desktop-mac-arm64.yml`
- `/download/desktop/latest/desktop-mac-x64.yml`
- `/download/desktop/latest/desktop-win-x64.yml`
- `/download/desktop/latest/desktop-win-arm64.yml`
- `/download/desktop/latest/desktop-linux-x64.yml`
- `/download/desktop/latest/desktop-linux-arm64.yml`

**L2 兼容 yml**（electron-builder 自动更新入口，按平台自动请求对应 yml，302 到 OSS）：

- `/download/desktop/latest/latest.yml`（Windows）
- `/download/desktop/latest/latest-mac.yml`（macOS，arm64 + x64）
- `/download/desktop/latest/latest-linux.yml`（Linux x64）
- `/download/desktop/latest/latest-linux-arm64.yml`（Linux ARM64）

对应包体（节选，完整清单见 [桌面版产物](#桌面版electron产物)）：

- `/download/desktop/latest/aether-desktop-mac-arm64.dmg`
- `/download/desktop/latest/aether-desktop-win-x64.exe`
- `/download/desktop/latest/aether-desktop-linux-amd64.deb`

测试版渠道把根路径替换为 `/downloadbeta/desktop/...` 即可。

解析规则（与 Web 版 latest 通道同构）：

- `latest` 读取桌面版版本索引（公开 `downloads/desktop-latest-versions.json`、测试版 `downloads/beta-desktop-latest-versions.json`），结构为 per-platform version map，按请求文件名所属平台解析到对应版本
- 通过 302 重定向到 OSS 对象地址，OSS key 为 `desktop/<version>/<filename>`（测试版 `beta/desktop/<version>/<filename>`）
- L1 manifest 走 inline + no-store 并上报 update-check 事件；L2 yml 与包体走 302 并上报 download-success 事件（与 Web 版 manifest/包体路由行为一致）
- L2 yml 与包体必须在同一版本目录下共存，electron-builder 才能按 yml 内 `path` 字段按相对路径解析

### electron-builder 自动更新配置

桌面版客户端把更新 base URL 指向桌面版 latest 通道（注意要带 `desktop` 段，而非 Web 版的 `/downloadbeta`）：

```jsonc
{
  "updateBaseUrl": "https://aether.aiphys.cn/downloadbeta/desktop/latest"
}
```

electron-builder 会按平台自动追加 `latest.yml` / `latest-mac.yml` / `latest-linux.yml` / `latest-linux-arm64.yml`，并按 yml 内 `path` 字段拉取同目录包体。公开渠道同理使用 `https://aether.aiphys.cn/download/desktop/latest`。

## macOS Manifest 协议

> 本节描述的是 **Web 版** 的 `mac-arm64.yml` / `mac-x64.yml` 协议。桌面版 L1 manifest（`desktop-mac-arm64.yml` 等）使用**同一 schema**，由服务端 commit 时生成，详见 [桌面版下载接口](#桌面版下载接口)；桌面版 L2 兼容 yml（`latest-mac.yml`）为 electron-builder 原生格式，由上游原样透传，服务端不生成。

mac 客户端应优先读取：

```text
/download/latest/mac-arm64.yml
```

这里的 `latest` 同样表示"解析到当前最新公开版本的 manifest"，不是要求客户端访问某个固定目录。

或：

```text
/download/<version>/mac-arm64.yml
```

测试版自动更新客户端应把本机 `Global.Path.config/update-config.jsonc` 配置为测试版下载根路径：

```jsonc
{
  "updateBaseUrl": "https://aether.aiphys.cn/downloadbeta"
}
```

各系统默认配置文件位置：

- Windows: `C:\Users\<user>\.config\aether\update-config.jsonc`
- macOS: `~/.config/aether/update-config.jsonc`
- Linux: `~/.config/aether/update-config.jsonc`

manifest 示例：

```yml
version: '1.3.3'
package:
  url: aether-darwin-arm64.dmg
  sha512: <base64-sha512>
  size: 93444053
installer:
  url: update_darwin.command
  size: 4096
files:
  - url: aether-darwin-arm64.dmg
    sha512: <base64-sha512>
    size: 93444053
releaseDate: '2026-04-02T07:12:00.000Z'
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `version` | 当前发布版本 |
| `package.url` | 主安装包文件名，客户端应拼接到下载根路径或当前 manifest 所在目录 |
| `package.sha512` | 主安装包的 Base64 SHA-512 |
| `package.size` | 主安装包字节数 |
| `installer.url` | 更新脚本文件名 |
| `installer.size` | 更新脚本字节数 |
| `files[0]` | 向后兼容字段，内容与 `package` 对应 |
| `releaseDate` | 发布时间 |

接入建议：

- 新客户端优先读取 `package`
- 如果存在 `installer`，可按产品流程决定是否额外下载并执行更新脚本
- 如果 `package` 不存在，可回退读取 `files[0]`
- `package.url` 和 `installer.url` 可能是相对路径，客户端应按 manifest 所在目录解析

## 上传响应

公开渠道 commit 成功时返回 `200 OK`，响应体示例：

```json
{
  "ok": true,
  "releaseDate": "2026-04-02T07:12:00.000Z",
  "files": [
    {
      "platform": "mac",
      "version": "1.3.3",
      "url": "/download/1.3.3/aether-darwin-arm64.dmg",
      "latestUrl": "/download/latest/aether-darwin-arm64.dmg",
      "manifestUrl": "/download/1.3.3/mac-arm64.yml",
      "latestManifestUrl": "/download/latest/mac-arm64.yml",
      "sha512": "<base64-sha512>",
      "size": 93444053,
      "installerUrl": "/download/1.3.3/update_darwin.command",
      "latestInstallerUrl": "/download/latest/update_darwin.command"
    },
    {
      "platform": "macIntel",
      "version": "1.3.3",
      "url": "/download/1.3.3/aether-darwin-x64.dmg",
      "latestUrl": "/download/latest/aether-darwin-x64.dmg",
      "manifestUrl": "/download/1.3.3/mac-x64.yml",
      "latestManifestUrl": "/download/latest/mac-x64.yml",
      "sha512": "<base64-sha512>",
      "size": 93444053,
      "installerUrl": "/download/1.3.3/update_darwin_x64.command",
      "latestInstallerUrl": "/download/latest/update_darwin_x64.command"
    }
  ]
}
```

OSS 上传失败时的响应示例：

```json
{
  "ok": true,
  "releaseDate": "2026-04-02T07:12:00.000Z",
  "ossWarnings": [
    { "objectKey": "1.3.3/mac-arm64.yml", "error": "OSS upload failed: 403 ..." }
  ],
  "files": [...]
}
```

说明：

- `url` / `manifestUrl` 指向指定版本目录
- `latestUrl` / `latestManifestUrl` 指向 `latest` 别名，服务端会解析到当前最新版本
- `ossWarnings` 仅在部分文件上传失败时出现

## 错误响应

常见错误：

| HTTP 状态码 | 含义 |
| --- | --- |
| `400` | 请求格式错误、缺少版本号、版本格式非法、`releaseDate` 非法 |
| `403` | 管理员密码错误 |
| `502` | manifest 写入 OSS 失败；服务端不会更新 latest 索引 |
| `500` | 管理员上传接口缺少 `DOWNLOAD_ADMIN_PASSWORD` 或 OSS 配置；公开下载接口缺少 `DOWNLOAD_OSS_PUBLIC_BASE_URL` |

错误响应示例：

```json
{
  "error": "Invalid releaseDate"
}
```

## 版本格式

服务端接受的版本号字符范围为：

```text
[0-9A-Za-z._-]+
```

例如：

- `1.3.3`
- `1.3.3-beta.1`
- `2026.04.02`

## 相关代码

- [presign.ts](../src/pages/api/download/admin/presign.ts)（公开渠道 OSS 直传预签名）
- [commit.ts](../src/pages/api/download/admin/commit.ts)（公开渠道 OSS 直传提交）
- [presign.ts](../src/pages/api/downloadbeta/admin/presign.ts)（测试版渠道 OSS 直传预签名）
- [commit.ts](../src/pages/api/downloadbeta/admin/commit.ts)（测试版渠道 OSS 直传提交）
- [download-upload.ts](../src/lib/server/download-upload.ts)
- [downloads.ts](../src/lib/server/downloads.ts)
- [oss.ts](../src/lib/server/oss.ts)

桌面版相关（计划新增）：

- `src/pages/download/desktop/[version]/[filename].ts`、`src/pages/download/desktop/latest/[filename].ts`（公开渠道桌面版下载路由）
- `src/pages/downloadbeta/desktop/[version]/[filename].ts`（测试版渠道桌面版下载路由）
- `downloads/desktop-latest-versions.json`、`downloads/beta-desktop-latest-versions.json`（桌面版 latest 索引，per-platform version map，与 Web 版 `latest-versions.json` 同构）
- `src/lib/server/downloads.ts` 新增 `DOWNLOAD_DESKTOP_PLATFORMS`（与 `DOWNLOAD_PLATFORMS` 同构）与桌面版文件名白名单；L1 manifest 生成复用 `buildLatestWebManifest`
- `src/lib/server/download-upload.ts` 新增 `commitDesktopDownloadUploads`，复用 Web 版 commit 的重算/生成/索引流程
- `src/lib/downloads/catalog.ts`（信息站点下载平台配置，新增桌面版平台与 Web/桌面切换）
