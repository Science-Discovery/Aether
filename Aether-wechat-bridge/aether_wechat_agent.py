"""
Aether WeChat Bridge - 将 Aether AI 接入微信
使用 wechat-agent-sdk 通过 HTTP API 调用 Aether 服务

环境变量:
- AETHER_URL: Aether 服务地址 (默认: http://127.0.0.1:4096)
- AETHER_WORK_DIR: 工作目录
- AETHER_MODEL: 默认模型 (格式: provider/model)
- AETHER_AGENT: 默认 Agent (默认: build)
- AETHER_WECHAT_QRCODE_FILE: 二维码输出文件路径
- AETHER_WECHAT_SESSION_FILE: 会话存储文件路径
"""

import asyncio
import os
import sys
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
import json
import base64
import logging
from pathlib import Path
from typing import Optional
from datetime import datetime
from io import BytesIO

import sqlite3
import glob
import httpx

# 设置日志
logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# SDK imports
from wechat_agent_sdk import Agent, ChatRequest, ChatResponse, WeChatBot
from wechat_agent_sdk.api.client import ILinkBotClient, DEFAULT_API_BASE
from wechat_agent_sdk.api.auth import login_with_qrcode
from wechat_agent_sdk.account.storage import JsonFileStorage

# 环境变量
QRCODE_FILE = os.getenv("AETHER_WECHAT_QRCODE_FILE", "")
SESSION_FILE = os.getenv("AETHER_WECHAT_SESSION_FILE", "")


def output_qrcode_base64(qrcode_url: str) -> str:
    """将二维码 URL 转换为 base64 图片并输出"""
    try:
        import qrcode as qr_lib
        from PIL import Image

        qr = qr_lib.QRCode(border=2, box_size=10)
        qr.add_data(qrcode_url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")

        buffer = BytesIO()
        img.save(buffer, "PNG")
        b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
        data_url = f"data:image/png;base64,{b64}"

        # 终端直接渲染二维码
        qr.print_ascii(invert=True)
        sys.stdout.flush()

        # 输出特殊标记（供 Aether 网页解析）
        print(f"[QR] {data_url}")
        sys.stdout.flush()

        # 同时写入文件
        if QRCODE_FILE:
            try:
                Path(QRCODE_FILE).parent.mkdir(parents=True, exist_ok=True)
                Path(QRCODE_FILE).write_text(data_url)
            except Exception as e:
                logger.warning(f"写入二维码文件失败: {e}")

        return data_url
    except ImportError:
        # 没有 qrcode/PIL 库，输出 URL
        logger.warning("未安装 qrcode/PIL，无法生成图片二维码")
        print(f"[QR_URL] {qrcode_url}")
        sys.stdout.flush()
        return qrcode_url



HELP_TEXT = (
    """📋 可用命令：

/new          开启新对话（清除当前会话上下文）
/model        查看可用模型列表及当前模型
/model <id>   切换模型，例如：/model anthropic/claude-sonnet-4-5
/project      查看当前工作项目
/help         显示此帮助信息"""
)


def _read_projects_from_db() -> list[dict]:
    """从 opencode SQLite 数据库读取所有项目（跨全部 channel db）"""
    import platform
    home = Path.home()
    # XDG data dir (opencode 使用 xdg-basedir，Windows 上也落在 ~/.local/share)
    candidates = [
        home / ".local" / "share" / "opencode",
        home / "Library" / "Application Support" / "opencode",  # macOS
    ]
    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        candidates.append(Path(local_app) / "opencode")
    # 允许环境变量覆盖
    override = os.environ.get("AETHER_OPENCODE_DATA_DIR", "")
    if override:
        candidates = [Path(override)]

    seen: dict[str, dict] = {}
    for data_dir in candidates:
        if not data_dir.exists():
            continue
        for db_path in sorted(data_dir.glob("opencode*.db")):
            try:
                uri = db_path.as_uri() + "?mode=ro&immutable=1"
                con = sqlite3.connect(uri, uri=True)
                cur = con.cursor()
                cur.execute("SELECT id, worktree, name FROM project")
                for pid, worktree, name in cur.fetchall():
                    if worktree and worktree != "/" and worktree not in seen:
                        seen[worktree] = {"id": pid, "worktree": worktree, "name": name}
                con.close()
            except Exception:
                pass
        break  # 找到第一个存在的目录就停止
    return list(seen.values())

class AetherAgent(Agent):
    """Aether 微信 Agent"""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:4096",
        directory: Optional[str] = None,
        default_model: Optional[str] = None,
        default_agent: str = "build",
    ):
        self.base_url = base_url.rstrip("/")
        self.directory = directory or str(Path.cwd())
        self.default_model = default_model
        self.default_agent = default_agent
        self._client: httpx.AsyncClient = None  # type: ignore
        self._sessions: dict[str, str] = {}
        self._conv_models: dict[str, str] = {}
        self._conv_dirs: dict[str, str] = {}
        self._user_info: Optional[dict] = None
        self._username = os.getenv("AETHER_USERNAME", "")
        self._password = os.getenv("AETHER_PASSWORD", "")

    async def on_start(self) -> None:
        """初始化 HTTP 客户端"""
        auth = None
        if self._username and self._password:
            auth = httpx.BasicAuth(self._username, self._password)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(300.0, connect=30.0),
            headers={"Content-Type": "application/json"},
            auth=auth,
        )
        logger.info(f"已连接到 Aether: {self.base_url}")
        logger.info(f"工作目录: {self.directory}")
        if self.default_model:
            logger.info(f"默认模型: {self.default_model}")

    async def on_stop(self) -> None:
        """清理资源"""
        if self._client:
            await self._client.aclose()
        logger.info("已断开 Aether 连接")


    async def _handle_slash_command(self, conv_id: str, text: str):
        stripped = text.strip()
        if not stripped.startswith('/'):
            return None
        parts = stripped.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ''
        if cmd == '/help':
            return HELP_TEXT
        if cmd == '/new':
            old = self._sessions.pop(conv_id, None)
            self._conv_models.pop(conv_id, None)
            if old:
                logger.info(f'[/new] 清除会话 {old[:8]}... for {conv_id}')
            return '✅ 已开启新对话，上下文已清空。'
        if cmd == '/model':
            if not arg:
                return await self._cmd_list_models(conv_id)
            return self._cmd_set_model(conv_id, arg)
        if cmd == '/project':
            return await self._cmd_project(conv_id, arg)
        return f'❓ 未知命令：{cmd}，发送 /help 查看可用命令。'

    async def _cmd_list_models(self, conv_id: str) -> str:
        try:
            resp = await self._client.get(f'{self.base_url}/provider')
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.error(f'获取模型列表失败: {e}')
            return '❌ 无法获取模型列表，请检查 Aether 服务是否正常。'
        current = self._conv_models.get(conv_id) or self.default_model or '（全局默认）'
        lines = [f'🤖 当前：{current}', '', '📦 可用模型：']
        providers = data.get('all', [])
        connected = set(data.get('connected', []))
        defaults = data.get('default', {})
        # 只显示已连接的 provider
        for provider in providers:
            pid = provider.get('id', '')
            if pid not in connected:
                continue
            pname = provider.get('name', pid)
            models = provider.get('models', {})
            if not models:
                continue
            lines.append(f'')
            lines.append(f'【{pname}】')
            default_mid = defaults.get(pid, '')
            # 默认模型排在最前
            sorted_ids = sorted(models.keys(), key=lambda m: (m != default_mid, m))
            for model_id in sorted_ids[:5]:
                tag = ' ★' if model_id == default_mid else ''
                lines.append(f'  {pid}/{model_id}{tag}')
            if len(models) > 5:
                lines.append(f'  ...（共 {len(models)} 个）')
        if len(lines) <= 3:
            lines.append('（暂无已配置的模型，请先在 Aether 中连接 provider）')
        lines.append('')
        lines.append('💡 /model anthropic/claude-sonnet-4-5')
        return chr(10).join(lines)

    async def _cmd_project(self, conv_id: str, arg: str) -> str:
        # 优先从 SQLite 读取（覆盖所有 channel），降级到 HTTP API
        projects = _read_projects_from_db()
        if not projects:
            try:
                resp = await self._client.get(f'{self.base_url}/project')
                resp.raise_for_status()
                projects = resp.json()
            except Exception as e:
                logger.error(f'获取项目列表失败: {e}')
                return '❌ 无法获取项目列表，请检查 Aether 服务是否正常。'

        if not projects:
            return '❌ 未找到任何项目。'

        current_dir = self._conv_dirs.get(conv_id) or self.directory

        if arg:
            try:
                idx = int(arg) - 1
            except ValueError:
                return '❌ 请输入项目编号，例如：/project 2'
            if idx < 0 or idx >= len(projects):
                return f'❌ 请输入 1~{len(projects)} 之间的数字。'
            chosen = projects[idx]
            new_dir = chosen.get('worktree', '')
            self._conv_dirs[conv_id] = new_dir
            self._sessions.pop(conv_id, None)
            self._conv_models.pop(conv_id, None)
            name = chosen.get('name') or new_dir.replace(chr(92), '/').rstrip('/').split('/')[-1]
            logger.info(f'[/project] {conv_id} -> {new_dir}')
            return f'✅ 已切换到：{name}\n   {new_dir}\n（已开启新会话）'

        lines = ['📂 项目列表：', '']
        for i, p in enumerate(projects, 1):
            worktree = p.get('worktree', '')
            name = p.get('name') or worktree.replace(chr(92), '/').rstrip('/').split('/')[-1]
            tag = ' ◀' if worktree == current_dir else ''
            lines.append(f'{i}. {name}{tag}')
            lines.append(f'   {worktree}')
        lines.append('')
        lines.append('💡 /project <n> 切换项目')
        return chr(10).join(lines)

    def _cmd_set_model(self, conv_id: str, model_str: str) -> str:
        if '/' not in model_str:
            return '❌ 格式错误，请使用 provider/model 格式。\n例如：/model anthropic/claude-sonnet-4-5'
        self._conv_models[conv_id] = model_str
        logger.info(f'[/model] {conv_id} -> {model_str}')
        return f'✅ 已切换模型：{model_str}\n（仅对当前对话生效，/new 后将重置）'

    async def chat(self, request: ChatRequest) -> ChatResponse:
        """处理微信消息"""
        if not self._client:
            return ChatResponse(text="错误: 客户端未初始化")

        conv_id = request.conversation_id
        user_text = request.text

        if request.group_id and request.is_at_bot:
            logger.info(f"[群聊] {request.sender_name}: {user_text}")
        else:
            logger.info(f"[私聊] {conv_id}: {user_text}")

        slash_reply = await self._handle_slash_command(conv_id, user_text)
        if slash_reply is not None:
            return ChatResponse(text=slash_reply)

        try:
            directory = self._conv_dirs.get(conv_id) or self.directory
            session_id = self._sessions.get(conv_id)
            if not session_id:
                session_id = await self._create_session(directory=directory)
                self._sessions[conv_id] = session_id
                logger.info(f"创建新会话: {session_id[:8]}... dir={directory}")

            model = self._conv_models.get(conv_id) or self.default_model
            response = await self._send_message(session_id, user_text, model=model, directory=directory)
            return ChatResponse(text=response.get("formatted", "操作已完成"))

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP 错误: {e.response.status_code}")
            return ChatResponse(text="服务暂时不可用，请稍后重试")
        except httpx.RequestError as e:
            logger.error(f"连接错误: {e}")
            return ChatResponse(text="无法连接到 Aether 服务")
        except Exception as e:
            logger.error(f"处理错误: {e}")
            return ChatResponse(text=f"处理消息时出错: {e}")

    async def _create_session(self, directory: str = "") -> str:
        headers = {"x-opencode-directory": directory} if directory else {}
        resp = await self._client.post(f"{self.base_url}/session", json={}, headers=headers)
        resp.raise_for_status()
        return resp.json()["id"]

    async def _send_message(self, session_id: str, text: str, model=None, directory="") -> dict:
        payload = {
            "parts": [{"type": "text", "text": text}],
            "agent": self.default_agent,
        }
        effective_model = model or self.default_model
        if effective_model:
            if "/" in effective_model:
                provider, mdl = effective_model.split("/", 1)
                payload["model"] = {"providerID": provider, "modelID": mdl}
            else:
                payload["model"] = effective_model

        resp = await self._client.post(
            f"{self.base_url}/session/{session_id}/message",
            json=payload,
            headers={"x-opencode-directory": directory} if directory else {},
        )
        resp.raise_for_status()
        body = resp.text.strip()
        if not body:
            # 服务端错误（如模型不存在）导致流式响应为空
            model_hint = f"（当前模型：{effective_model}）" if effective_model else ""
            return {"formatted": f"❌ 服务端返回空响应，请检查模型是否有效 {model_hint}"}
        try:
            return self._extract_response(resp.json())
        except Exception:
            logger.error(f"响应解析失败，body={body[:200]}")
            return {"formatted": f"❌ 响应解析失败: {body[:200]}"}

    def _extract_response(self, result: dict) -> dict:
        parts = result.get("parts", [])
        info = result.get("info", {})

        # Check for API error in info
        error = info.get("error")
        if error:
            err_msg = error.get("data", {}).get("message") or error.get("name", "未知错误")
            logger.error(f"LLM API错误: {err_msg}")
            return {"reasoning": "", "text": "", "formatted": f"AI 服务错误: {err_msg}"}

        reasoning_parts, text_parts, tool_parts = [], [], []

        for part in parts:
            ptype = part.get("type")
            if ptype == "reasoning" and part.get("text"):
                reasoning_parts.append(part["text"])
            elif ptype == "text" and part.get("text"):
                text_parts.append(part["text"])
            elif ptype == "tool":
                name = part.get("tool", "unknown")
                state = part.get("state", {})
                status = state.get("status", "")
                if status == "completed" and state.get("output"):
                    out = state["output"]
                    if len(out) < 500:
                        tool_parts.append(f"[{name}] {out}")
                elif status == "error":
                    tool_parts.append(f"[{name} 错误] {state.get('error', '未知')}")

        reasoning = "\n".join(reasoning_parts)
        text = "\n\n".join(text_parts + tool_parts)

        formatted_parts = []
        if reasoning:
            formatted_parts.append(f"💭 思考：\n{reasoning}")
        if text:
            formatted_parts.append(f"📝 回复：\n{text}")

        return {
            "reasoning": reasoning,
            "text": text,
            "formatted": "\n\n─────────\n\n".join(formatted_parts)
            if formatted_parts
            else "操作已完成",
        }


async def custom_login(client: ILinkBotClient, log=print) -> str:
    """自定义登录流程，输出 base64 二维码"""
    qr_info = await client.request_qrcode()
    qrcode_url = qr_info["qrcode_url"]
    qr_uuid = qr_info["uuid"]

    # 输出 base64 二维码
    output_qrcode_base64(qrcode_url)
    log("等待微信扫码...")

    import time

    start = time.time()
    while time.time() - start < 120:
        await asyncio.sleep(2.0)
        result = await client.check_login_status(qr_uuid)
        status = result["status"]

        if status == "confirmed":
            token = result["token"]
            client.token = token
            user_info = result.get("user_info", {})
            user_id = user_info.get("id", "unknown")
            user_name = user_info.get("name", "Unknown")
            print(f"[登录成功] user: {user_id} ({user_name})")
            sys.stdout.flush()

            # 保存会话到文件
            if SESSION_FILE:
                try:
                    session_data = {
                        "connected": True,
                        "user": {"id": user_id, "name": user_name},
                        "createdAt": datetime.now().isoformat(),
                    }
                    Path(SESSION_FILE).parent.mkdir(parents=True, exist_ok=True)
                    Path(SESSION_FILE).write_text(
                        json.dumps(session_data, ensure_ascii=False)
                    )
                except Exception as e:
                    logger.warning(f"保存会话失败: {e}")

            log("微信连接成功！")
            return token
        elif status == "scanned":
            log("已扫码，请在手机确认...")
        elif status == "expired":
            raise RuntimeError("二维码已过期")
        elif status == "error":
            raise RuntimeError(f"登录失败: {result.get('message')}")

    raise RuntimeError("登录超时")


class CustomWeChatBot(WeChatBot):
    """自定义 Bot，覆盖登录方法"""

    async def login(self, log=print) -> str:
        stored_token = await self._storage.load_token(self._account_id)
        if stored_token:
            self._client.token = stored_token
            log(f"[weixin] 使用已保存的 token")
            # 通知 Aether 已连接
            print(f"[登录成功] user: unknown (已保存的账号)")
            sys.stdout.flush()
            # 保存会话到文件
            if SESSION_FILE:
                try:
                    session_data = {
                        "connected": True,
                        "user": {"id": "unknown", "name": "已保存的账号"},
                        "createdAt": datetime.now().isoformat(),
                    }
                    Path(SESSION_FILE).parent.mkdir(parents=True, exist_ok=True)
                    Path(SESSION_FILE).write_text(
                        json.dumps(session_data, ensure_ascii=False)
                    )
                except Exception as e:
                    logger.warning(f"保存会话失败: {e}")
            return stored_token

        token = await custom_login(self._client, log=log)
        await self._storage.save_token(self._account_id, token)
        return token


async def main():
    base_url = os.getenv("AETHER_URL", "http://127.0.0.1:4096")
    directory = os.getenv("AETHER_WORK_DIR")
    default_model = os.getenv("AETHER_MODEL")
    default_agent = os.getenv("AETHER_AGENT", "build")

    if not directory:
        directory = str(Path.cwd())

    print("=" * 50)
    print("Aether WeChat Bridge")
    print("=" * 50)
    print()

    agent = AetherAgent(
        base_url=base_url,
        directory=directory,
        default_model=default_model,
        default_agent=default_agent,
    )

    # 使用自定义 Bot
    bot = CustomWeChatBot(
        agent=agent,
        account_id="aether",
        storage=(
            JsonFileStorage(Path(SESSION_FILE).parent)
            if SESSION_FILE
            else JsonFileStorage()
        ),
    )

    try:
        await bot.run(log=print)
    except KeyboardInterrupt:
        print("\n[Aether] 正在关闭...")


if __name__ == "__main__":
    asyncio.run(main())
