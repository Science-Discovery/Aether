# OpenResearch 分发指南

---

## 一、构建打包（开发者操作）

> 只有需要打包发布的人才需要这一步，**普通用户直接看第二节**。

**第 1 步：克隆仓库并安装依赖**

```bash
git clone <仓库地址>
cd opencode
bun install
```

**第 2 步：构建二进制**

```bash
cd packages/opencode
bun run build -- --single
```

构建完成后产物在 `packages/opencode/dist/openresearch-linux-x64/bin/`，包含：
- `openresearch` — 可执行二进制
- `web/` — Web UI 资源（`openresearch web` 命令依赖此目录）

**第 3 步：打包成压缩包**

```bash
cd /home/你的用户名/opencode/packages/opencode/dist/openresearch-linux-x64/bin
tar -czf ~/openresearch-linux-x64.tar.gz openresearch web/
```

压缩包保存在家目录 `~/openresearch-linux-x64.tar.gz`，发给他人即可。

---

## 二、安装（使用者操作）

> 收到 `.tar.gz` 压缩包后，在自己的机器上执行以下步骤。**不需要克隆仓库。**

```bash
# 解压
tar -xzf openresearch-linux-x64.tar.gz

# 安装（删除旧版本后复制新文件）
sudo rm -f /usr/local/bin/openresearch
sudo rm -rf /usr/local/bin/web
sudo cp openresearch /usr/local/bin/
sudo chmod +x /usr/local/bin/openresearch
sudo cp -r web /usr/local/bin/

# 验证
openresearch --version
```

---

## 三、首次配置 API Key

安装完成后需要配置 AI 提供商的 API Key：

```bash
openresearch providers
```

按提示选择提供商（如 Anthropic、OpenAI 等）并输入 API Key。

---

## 四、使用

### 命令行交互（TUI）

```bash
cd 你的项目目录
openresearch
```

### Web 界面

```bash
cd 你的项目目录
openresearch web
```

终端会显示访问地址（默认 `http://127.0.0.1:4096`），在浏览器中打开即可。

> WSL 用户：需手动在 Windows 浏览器输入地址，自动打开浏览器在 WSL 下不生效。

### 直接执行指令（非交互式）

```bash
openresearch run "帮我分析这个项目的代码结构"
```

---

## 五、卸载

```bash
sudo rm -f /usr/local/bin/openresearch
sudo rm -rf /usr/local/bin/web
```

---

## 常见问题

**Q：`openresearch web` 打开后页面空白**
确认 `/usr/local/bin/web/index.html` 存在。若不存在，重新安装时补上 `sudo cp -r web /usr/local/bin/`。

**Q：安装时提示 `Text file busy`**
旧版本还在运行，先执行 `pkill -9 openresearch` 再重新安装。

**Q：提示 `command not found`**
确认 `/usr/local/bin` 在 PATH 中：`echo $PATH | grep -o '/usr/local/bin'`
