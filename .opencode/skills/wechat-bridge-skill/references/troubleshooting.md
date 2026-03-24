# 故障排除指南

## 目录

1. [Python 环境问题](#python-环境问题)
2. [Aether 服务启动失败](#aether-服务启动失败)
3. [微信登录问题](#微信登录问题)
4. [权限配置问题](#权限配置问题)
5. [网络连接问题](#网络连接问题)

---

## Python 环境问题

### 问题: 找不到 python 命令

**macOS:**
```bash
brew install python@3.11
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install python3 python3-venv python3-pip
```

**Windows:**
从 https://www.python.org/downloads/ 下载安装，安装时勾选 "Add Python to PATH"

### 问题: Python 版本过低

要求 Python 3.11+

**检查版本:**
```bash
python3 --version
```

**使用 pyenv 安装特定版本:**
```bash
pyenv install 3.11.0
pyenv local 3.11.0
```

### 问题: 虚拟环境创建失败

**macOS/Linux:**
```bash
# 确保安装了 venv 模块
sudo apt install python3-venv  # Ubuntu/Debian
```

**Windows:**
```powershell
# 以管理员身份运行
python -m pip install --upgrade pip
python -m pip install virtualenv
```

---

## Aether 服务启动失败

### 问题: 端口被占用

**检查端口占用:**
```bash
# macOS/Linux
lsof -i :4096

# Windows
netstat -ano | findstr :4096
```

**解决方案:**
1. 终止占用进程
2. 或使用其他端口:
```bash
export AETHER_PORT=4097
./start-darwin.sh
```

### 问题: 权限不足

**macOS:**
```bash
chmod +x bin/aether
chmod +x scripts/start-darwin.sh
```

**Linux:**
```bash
chmod +x bin/aether
chmod +x scripts/start-linux.sh
```

**Windows:**
右键脚本 -> 属性 -> 解除锁定

### 问题: 二进制文件不存在

检查目录结构:
```
aether-<platform>/
├── bin/
│   └── aether (或 aether.exe)
└── wechat-bridge/
    ├── aether_wechat_agent.py
    └── requirements.txt
```

---

## 微信登录问题

### 问题: 二维码不显示

**解决方案:**
1. 确保终端支持 UTF-8 编码
2. 确保安装了 QR 码依赖:
```bash
pip install wechat-agent-sdk[qr]
```

### 问题: 扫码后无响应

**检查日志:**
终端会显示登录状态

**可能原因:**
1. 网络问题
2. 微信账号限制
3. iLink Bot API 服务问题

### 问题: 登录频繁掉线

**解决方案:**
1. 保持终端窗口开启
2. 避免频繁切换网络
3. 检查是否有其他客户端登录同一微信

---

## 权限配置问题

### 问题: 请求卡住无响应

**原因:** Aether 在等待权限确认，但微信无法交互确认

**解决方案:**

编辑 `~/.config/opencode/opencode.jsonc`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "external_directory": "allow",
    "edit": "allow",
    "bash": "allow",
    "read": "allow",
    "write": "allow",
    "glob": "allow",
    "grep": "allow"
  }
}
```

### 问题: 配置文件不存在

**创建配置目录和文件:**
```bash
mkdir -p ~/.config/opencode
touch ~/.config/opencode/opencode.jsonc
```

然后添加上述权限配置内容。

---

## 网络连接问题

### 问题: 无法连接到 Aether 服务

**检查 Aether 是否运行:**
```bash
curl http://127.0.0.1:4096/path
```

**检查防火墙:**
- macOS: 系统偏好设置 -> 安全性与隐私 -> 防火墙
- Windows: Windows Defender 防火墙

### 问题: 代理设置冲突

如果使用代理，确保设置正确的排除:
```bash
export NO_PROXY=127.0.0.1,localhost
```

---

## 依赖安装问题

### 问题: pip 安装超时

**使用国内镜像:**
```bash
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 问题: wechat-agent-sdk 安装失败

**手动安装:**
```bash
pip install wechat-agent-sdk[qr] --upgrade
pip install httpx --upgrade
```

---

## Windows 特有问题

### 问题: PowerShell 脚本执行策略

**错误信息:**
```
无法加载文件，因为在此系统上禁止运行脚本
```

**解决方案:**
```powershell
# 以管理员身份运行
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 问题: 批处理脚本中文乱码

**解决方案:**
确保终端编码设置为 UTF-8 (脚本已包含 `chcp 65001`)

### 问题: venv\Scripts\activate 找不到

**使用正确的激活脚本:**
- PowerShell: `.\venv\Scripts\Activate.ps1`
- CMD: `.\venv\Scripts\activate.bat`

---

## 获取帮助

如问题未解决:

1. 查看 [Aether GitHub](https://github.com/Science-Discovery/Aether) Issues
2. 提交新 Issue，包含:
   - 操作系统版本
   - Python 版本
   - 完整错误日志