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
import re
import sys

# 确保 stdout/stderr 使用 UTF-8（作为 Electron 子进程运行时管道可能默认 ASCII）
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
import json
import base64
import logging
from pathlib import Path
from typing import Optional
from datetime import datetime
from io import BytesIO
from urllib.parse import quote

import httpx

# 设置日志
logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)
# 确保日志 handler 的输出流也使用 UTF-8（basicConfig 可能绑定了旧的 stderr 引用）
for _h in logging.root.handlers:
    if hasattr(_h, "stream") and hasattr(_h.stream, "reconfigure"):
        try:
            _h.stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

# SDK imports
from wechat_agent_sdk import Agent, ChatRequest, ChatResponse, WeChatBot
from wechat_agent_sdk.api.client import ILinkBotClient, DEFAULT_API_BASE
from wechat_agent_sdk.api.auth import login_with_qrcode
from wechat_agent_sdk.account.storage import JsonFileStorage


def make_httpx(**kwargs) -> httpx.AsyncClient:
    try:
        return httpx.AsyncClient(**kwargs)
    except ImportError as err:
        if "socksio" not in str(err):
            raise
        logger.warning("[weixin] 检测到 SOCKS 代理但未安装 socksio，已绕过系统代理")
        cfg = dict(kwargs)
        cfg["trust_env"] = False
        return httpx.AsyncClient(**cfg)


# Patch ILinkBotClient: fall back to trust_env=False if system proxy/network causes connection errors
async def _make_ilinkbot_client(trust_env: bool) -> httpx.AsyncClient:
    from wechat_agent_sdk.api.client import POLL_TIMEOUT, _make_wechat_uin

    async def _inject_uin(request):
        request.headers["X-WECHAT-UIN"] = _make_wechat_uin()

    return make_httpx(
        timeout=httpx.Timeout(
            connect=10.0, read=POLL_TIMEOUT + 10, write=10.0, pool=10.0
        ),
        headers={
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
        },
        event_hooks={"request": [_inject_uin]},
        trust_env=trust_env,
    )


async def _request_qrcode_with_fallback(self) -> dict:
    """Try request_qrcode; on ConnectTimeout, retry without system proxy."""
    if not self._client:
        self._client = await _make_ilinkbot_client(trust_env=True)
        if self._token:
            self._client.headers["Authorization"] = f"Bearer {self._token}"
    try:
        return await _orig_request_qrcode(self)
    except httpx.ConnectTimeout:
        logger.warning("[weixin] 连接超时，尝试绕过系统代理重连...")
        await self._client.aclose()
        self._client = await _make_ilinkbot_client(trust_env=False)
        if self._token:
            self._client.headers["Authorization"] = f"Bearer {self._token}"
        return await _orig_request_qrcode(self)


_orig_request_qrcode = ILinkBotClient.request_qrcode
ILinkBotClient.request_qrcode = _request_qrcode_with_fallback

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


HELP_TEXT = """📋 可用命令：

/new          开启新对话（清除当前会话上下文）
/stop         停止当前会话中的执行
/model        查看可用模型列表及当前模型
/model n      切换到编号 n 的模型（由 /model 列表确定）
/mode         查看当前会话模式
/mode plan    切换到计划模式
/mode build   切换到构建模式
/approval     查看当前审批模式
/approval auto 自动批准权限请求
/approval ask 每次权限请求需手动审批
/project      查看当前工作项目
/project list 查看全部项目
/project n    切换到编号 n 的项目
/project hide n  隐藏项目（在桌面端或微信端重新使用后自动恢复）
/session      查看当前项目下的会话列表
/session list 查看当前项目下全部会话
/session n    切换到当前项目下编号 n 的会话
/help         显示此帮助信息"""

_HIDDEN_FILE: Path = (
    Path(SESSION_FILE).parent / "hidden_projects.json"
    if SESSION_FILE
    else Path.home() / ".config" / "aether-wechat" / "hidden_projects.json"
)


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
        self._session_list: dict[str, list[dict]] = {}
        self._conv_models: dict[str, str] = {}
        self._conv_dirs: dict[str, str] = {}
        self._fresh: set[str] = set()
        self._pending_questions: dict[str, dict] = {}
        self._pending_permissions: dict[str, dict] = {}
        self._tasks: dict[str, object] = {}
        self._sse_tasks: dict[str, object] = {}
        self._accumulated_text: dict[str, str] = {}
        self._question_queues: dict[str, object] = {}
        self._wechat_client = None  # ILinkBotClient, set by CustomWeChatBot
        self._wechat_ctx: dict[str, str] = {}  # conv_id -> context_token
        self._model_list: list[str] = []  # 上次 /model 获取的有序模型列表
        self._user_info: Optional[dict] = None
        self._username = os.getenv("AETHER_USERNAME", "")
        self._password = os.getenv("AETHER_PASSWORD", "")
        self._hidden_dirs: dict[str, int] = {}  # worktree → 隐藏时的时间戳(ms)
        self._project_names: dict[str, str] = {}
        self._session_info: dict[str, dict] = {}

    async def on_start(self) -> None:
        """初始化 HTTP 客户端"""
        auth = None
        if self._username and self._password:
            auth = httpx.BasicAuth(self._username, self._password)
        self._client = make_httpx(
            timeout=httpx.Timeout(300.0, connect=30.0),
            headers={"Content-Type": "application/json"},
            auth=auth,
        )
        logger.info(f"已连接到 Aether: {self.base_url}")
        logger.info(f"工作目录: {self.directory}")
        if self.default_model:
            logger.info(f"默认模型: {self.default_model}")
        try:
            if _HIDDEN_FILE.exists():
                raw = json.loads(_HIDDEN_FILE.read_text(encoding="utf-8"))
                self._hidden_dirs = (
                    {k: int(v) for k, v in raw.items()} if isinstance(raw, dict) else {}
                )
                if self._hidden_dirs:
                    logger.info(f"已加载 {len(self._hidden_dirs)} 个隐藏项目")
        except Exception as e:
            logger.warning(f"加载隐藏项目失败: {e}")
        try:
            session_id, created = await self._ensure_session(self.directory)
            logger.info(
                f"默认会话: {session_id[:8]}... dir={self.directory} created={created}"
            )
        except Exception as e:
            logger.warning(f"初始化默认会话失败: {e}")

    async def on_stop(self) -> None:
        """清理资源"""
        if self._client:
            await self._client.aclose()
        logger.info("已断开 Aether 连接")

    def _save_hidden_dirs(self) -> None:
        try:
            _HIDDEN_FILE.parent.mkdir(parents=True, exist_ok=True)
            _HIDDEN_FILE.write_text(json.dumps(self._hidden_dirs), encoding="utf-8")
        except Exception as e:
            logger.warning(f"保存隐藏项目失败: {e}")

    def _project_dir(self, item: dict) -> str:
        return self._norm_dir(item.get("directory") or item.get("worktree", ""))

    def _norm_dir(self, directory: str) -> str:
        text = (directory or "").replace(chr(92), "/")
        if not text:
            return ""
        if re.fullmatch(r"/+", text):
            return "/"
        if re.fullmatch(r"[A-Za-z]:/?", text):
            return f"{text[0].lower()}:/"
        if re.fullmatch(r"[A-Za-z]:/+", text):
            return f"{text[0].lower()}:/"
        return text.rstrip("/")

    def _project_name(self, item: dict) -> str:
        directory = self._project_dir(item)
        return (
            item.get("name")
            or directory.replace(chr(92), "/").rstrip("/").split("/")[-1]
        )

    def _base(self, directory: str) -> str:
        text = (directory or "").replace(chr(92), "/").rstrip("/")
        return text.split("/")[-1] if text else "unknown"

    def _clip(self, text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        return text[: limit - 3].rstrip() + "..."

    async def _get_project_name(self, directory: str) -> str:
        if not directory:
            return "unknown"
        cached = self._project_names.get(directory)
        if cached:
            return cached
        try:
            item = next(
                (
                    item
                    for item in await self._get_projects()
                    if self._project_dir(item) == directory
                ),
                None,
            )
            if item:
                name = self._project_name(item)
                if name:
                    self._project_names[directory] = name
                    return name
        except Exception:
            pass
        self._project_names[directory] = self._base(directory)
        return self._project_names[directory]

    async def _get_session_info(self, session_id: str, directory: str) -> dict:
        info = self._session_info.get(session_id)
        if info:
            return info
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        try:
            resp = await self._client.get(
                f"{self.base_url}/session/{session_id}", headers=headers
            )
            resp.raise_for_status()
            info = resp.json()
            if isinstance(info, dict):
                self._session_info[session_id] = info
                return info
        except Exception as e:
            logger.warning(f"获取会话信息失败: {e}")
        return {}

    async def _get_preference(self, session_id: str, directory: str) -> dict:
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        try:
            resp = await self._client.get(
                f"{self.base_url}/session/{session_id}/preference", headers=headers
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.warning(f"获取会话偏好失败: {e}")
            return {}

    async def _patch_preference(
        self,
        session_id: str,
        directory: str,
        *,
        agent=None,
        model=None,
        autoAccept=None,
    ) -> dict:
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        payload = {}
        if agent is not None:
            payload["agent"] = agent
        if model is not None:
            payload["model"] = model
        if autoAccept is not None:
            payload["autoAccept"] = autoAccept
        try:
            resp = await self._client.patch(
                f"{self.base_url}/session/{session_id}/preference",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.warning(f"更新会话偏好失败: {e}")
            return {}

    def _pick(
        self, items: list[dict], size: int, hide: Optional[set[str]] = None
    ) -> list[tuple[int, dict]]:
        rows = []
        for idx, item in enumerate(items, 1):
            if hide and self._project_dir(item) in hide:
                continue
            rows.append((idx, item))
            if len(rows) >= size:
                break
        return rows

    async def _format_header(
        self, session_id: str, directory: str, conv_id: str = ""
    ) -> str:
        project = self._clip(await self._get_project_name(directory), 24)
        label = session_id[:8] if session_id else "—"
        pref = {}
        if session_id:
            info = await self._get_session_info(session_id, directory)
            title = info.get("title") if isinstance(info, dict) else ""
            if isinstance(title, str) and title.strip():
                label = self._clip(title.strip(), 24)
            pref = await self._get_preference(session_id, directory)
        mode = pref.get("agent") or self.default_agent or "—"
        pref_model = pref.get("model")
        if pref_model:
            model = (
                f"{pref_model.get('providerID', '')}/{pref_model.get('modelID', '')}"
            )
        else:
            model = self._conv_models.get(conv_id, "") or self.default_model or "—"
        return f"{project}  ·  {label}  ·  {mode}  ·  {model}\n————————"

    async def _wrap_message(
        self, text: str, session_id: str, directory: str, conv_id: str = ""
    ) -> str:
        body = text.strip()
        if not body:
            return text
        return f"{await self._format_header(session_id, directory, conv_id)}\n{body}"

    async def _get_projects(self) -> list[dict]:
        try:
            resp = await self._client.get(f"{self.base_url}/project/recent")
            resp.raise_for_status()
            return [item for item in resp.json() if self._project_dir(item)]
        except Exception as e:
            logger.warning(f"获取项目列表失败: {e}")
            return []

    async def _list_sessions(self, directory: str) -> list[dict]:
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        resp = await self._client.get(
            f"{self.base_url}/session",
            params={"directory": directory} if directory else None,
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else []

    async def _ensure_session(
        self, directory: str, fresh: bool = False
    ) -> tuple[str, bool]:
        if fresh:
            return await self._create_session(directory=directory), True
        items = await self._list_sessions(directory)
        if items:
            return items[0]["id"], False
        return await self._create_session(directory=directory), True

    def _format_session_time(self, val: object) -> str:
        if not isinstance(val, int):
            return "未知时间"
        return datetime.fromtimestamp(val / 1000).strftime("%Y-%m-%d %H:%M")

    async def _cmd_session(self, conv_id: str, arg: str) -> str:
        directory = self._conv_dirs.get(conv_id) or self.directory
        items = await self._list_sessions(directory)
        self._session_list[conv_id] = items

        if arg == "list":
            current = self._sessions.get(conv_id)
            lines = ["🗂 会话列表：", ""]
            for i, item in enumerate(items, 1):
                title = item.get("title") or item["id"][:8]
                updated = self._format_session_time(item.get("time", {}).get("updated"))
                tag = " ◀" if item["id"] == current else ""
                lines.append(f"{i}. {title}{tag}")
                lines.append(f"   {updated}")
            if not items:
                lines.append("（当前项目下还没有任何会话）")
            return chr(10).join(lines)

        if arg:
            try:
                idx = int(arg) - 1
            except ValueError:
                return "❌ 请输入会话编号，例如：/session 2"
            if idx < 0 or idx >= len(items):
                return (
                    f"❌ 请输入 1~{len(items)} 之间的数字。"
                    if items
                    else "❌ 当前项目下还没有任何会话。"
                )
            chosen = items[idx]
            self._sessions[conv_id] = chosen["id"]
            self._fresh.discard(conv_id)
            title = chosen.get("title") or chosen["id"][:8]
            logger.info(f"[/session] {conv_id} -> {chosen['id']}")
            return f"✅ 已切换到会话：{title}\n   更新时间：{self._format_session_time(chosen.get('time', {}).get('updated'))}"

        if not items:
            session_id = await self._create_session(directory=directory)
            self._sessions[conv_id] = session_id
            self._fresh.discard(conv_id)
            logger.info(f"[/session] 为 {conv_id} 创建新会话 {session_id[:8]}...")
            return "📂 当前项目下还没有任何会话，已自动创建一个新会话并切换。"

        current = self._sessions.get(conv_id)
        lines = ["🗂 会话列表：", ""]
        for i, item in enumerate(items[:10], 1):
            title = item.get("title") or item["id"][:8]
            updated = self._format_session_time(item.get("time", {}).get("updated"))
            tag = " ◀" if item["id"] == current else ""
            lines.append(f"{i}. {title}{tag}")
            lines.append(f"   {updated}")
        lines.append("")
        lines.append("💡 /session n 切换会话 | /session list 查看全部")
        return chr(10).join(lines)

    async def _handle_slash_command(self, conv_id: str, text: str):
        stripped = text.strip()
        if not stripped.startswith("/"):
            return None
        parts = stripped.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""
        if cmd == "/help":
            return HELP_TEXT
        if cmd == "/stop":
            return await self._cmd_stop(conv_id)
        if cmd == "/new":
            old = self._sessions.pop(conv_id, None)
            self._session_list.pop(conv_id, None)
            self._conv_models.pop(conv_id, None)
            self._fresh.add(conv_id)
            self._clear_runtime(conv_id)
            if old:
                logger.info(f"[/new] 清除会话 {old[:8]}... for {conv_id}")
            return "✅ 已开启新对话，上下文已清空。"
        if cmd == "/model":
            if not arg:
                return await self._cmd_list_models(conv_id)
            # 数字编号切换
            if arg.isdigit():
                return await self._cmd_set_model_by_index(conv_id, int(arg))
            return await self._cmd_set_model(conv_id, arg)
        if cmd == "/project":
            return await self._cmd_project(conv_id, arg)
        if cmd == "/session":
            return await self._cmd_session(conv_id, arg)
        if cmd == "/mode":
            return await self._cmd_mode(conv_id, arg)
        if cmd == "/approval":
            return await self._cmd_approval(conv_id, arg)
        return f"❓ 未知命令：{cmd}，发送 /help 查看可用命令。"

    async def _cmd_list_models(self, conv_id: str) -> str:
        try:
            directory = self._conv_dirs.get(conv_id) or self.directory
            headers = (
                {"x-opencode-directory": quote(directory, safe="")} if directory else {}
            )
            resp = await self._client.get(f"{self.base_url}/provider", headers=headers)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.error(f"获取模型列表失败: {e}")
            return "❌ 无法获取模型列表，请检查 Aether 服务是否正常。"
        session_id = self._sessions.get(conv_id)
        pref = await self._get_preference(session_id, directory) if session_id else {}
        pref_model = pref.get("model")
        if pref_model:
            current = (
                f"{pref_model.get('providerID', '')}/{pref_model.get('modelID', '')}"
            )
        else:
            current = (
                self._conv_models.get(conv_id) or self.default_model or "（全局默认）"
            )
        lines = ["📦 可用模型："]
        providers = data.get("all", [])
        connected = set(data.get("connected", []))
        defaults = data.get("default", {})
        model_list: list[str] = []
        for provider in providers:
            pid = provider.get("id", "")
            if pid not in connected:
                continue
            pname = provider.get("name", pid)
            models = provider.get("models", {})
            if not models:
                continue
            lines.append(f"")
            lines.append(f"【{pname}】")
            default_mid = defaults.get(pid, "")
            sorted_ids = sorted(models.keys(), key=lambda m: (m != default_mid, m))
            for model_id in sorted_ids:
                model_list.append(f"{pid}/{model_id}")
                num = len(model_list)
                tag = " ★" if model_id == default_mid else ""
                lines.append(f"  {num}. {pid}/{model_id}{tag}")
        self._model_list = model_list
        if len(lines) <= 3:
            lines.append("（暂无已配置的模型，请先在 Aether 中连接 provider）")
        lines.append("")
        lines.append("💡 /model n 切换模型")
        return chr(10).join(lines)

    async def _cmd_set_model_by_index(self, conv_id: str, n: int) -> str:
        if not self._model_list:
            return "❌ 请先发送 /model 获取模型列表，再用编号切换。"
        if n < 1 or n > len(self._model_list):
            return f"❌ 请输入 1~{len(self._model_list)} 之间的编号。"
        model_str = self._model_list[n - 1]
        return await self._cmd_set_model(conv_id, model_str)

    async def _cmd_project(self, conv_id: str, arg: str) -> str:
        all_projects = await self._get_projects()
        if not all_projects:
            return "❌ 无法获取项目列表，请检查 Aether 服务是否正常。"

        # 自动取消隐藏：检查哪些隐藏项目在隐藏后有新 session 活动
        if self._hidden_dirs:
            changed = False
            for directory, hide_time in list(self._hidden_dirs.items()):
                item = next(
                    (p for p in all_projects if self._project_dir(p) == directory),
                    None,
                )
                activity = (((item or {}).get("time") or {}).get("activity")) or 0
                if activity > hide_time:
                    del self._hidden_dirs[directory]
                    changed = True
                    logger.info(f"[/project] 自动恢复隐藏项目: {directory}")
            if changed:
                self._save_hidden_dirs()

        projects = [
            p for p in all_projects if self._project_dir(p) not in self._hidden_dirs
        ]
        current_dir = self._conv_dirs.get(conv_id) or self.directory

        # /project hide n
        if arg.startswith("hide "):
            del_arg = arg[5:].strip()
            if not del_arg.isdigit() or not all_projects:
                return "❌ 用法：/project hide n"
            idx = int(del_arg) - 1
            if idx < 0 or idx >= len(all_projects):
                return f"❌ 请输入 1~{len(all_projects)} 之间的数字。"
            target = all_projects[idx]
            directory = self._project_dir(target)
            self._hidden_dirs[directory] = int(datetime.now().timestamp() * 1000)
            self._save_hidden_dirs()
            name = self._project_name(target)
            return f"✅ 已隐藏：{name}\n（在桌面端或微信端重新使用后自动恢复）"

        if arg == "list":
            lines = ["📂 项目列表：", ""]
            for idx, item in enumerate(all_projects, 1):
                directory = self._project_dir(item)
                tag = " ◀" if directory == current_dir else ""
                mark = " [已隐藏]" if directory in self._hidden_dirs else ""
                lines.append(f"{idx}. {self._project_name(item)}{tag}{mark}")
                lines.append(f"   {directory}")
            return chr(10).join(lines)

        # /project n
        if arg:
            try:
                idx = int(arg) - 1
            except ValueError:
                return "❌ 请输入项目编号，例如：/project 2"
            if not all_projects or idx < 0 or idx >= len(all_projects):
                return f"❌ 请输入 1~{len(all_projects)} 之间的数字。"
            chosen = all_projects[idx]
            new_dir = self._project_dir(chosen)
            self._conv_dirs[conv_id] = new_dir
            session_id, created = await self._ensure_session(new_dir)
            self._sessions[conv_id] = session_id
            self._session_list.pop(conv_id, None)
            self._fresh.discard(conv_id)
            self._conv_models.pop(conv_id, None)
            if new_dir in self._hidden_dirs:
                del self._hidden_dirs[new_dir]
                self._save_hidden_dirs()
            name = self._project_name(chosen)
            logger.info(f"[/project] {conv_id} -> {new_dir}")
            note = "已创建新会话"
            if not created:
                items = await self._list_sessions(new_dir)
                item = next((row for row in items if row.get("id") == session_id), None)
                title = (item or {}).get("title") or session_id[:8]
                note = f"已进入该项目最新会话：{title}"
            return f"✅ 已切换到：{name}\n   {new_dir}\n（{note}）"

        # /project（列表）
        if not projects:
            hint = (
                f"（有 {len(self._hidden_dirs)} 个项目已隐藏）"
                if self._hidden_dirs
                else ""
            )
            return f"❌ 未找到任何项目。{hint}"

        lines = ["📂 项目列表：", ""]
        for idx, item in self._pick(all_projects, 10, set(self._hidden_dirs)):
            directory = self._project_dir(item)
            tag = " ◀" if directory == current_dir else ""
            lines.append(f"{idx}. {self._project_name(item)}{tag}")
            lines.append(f"   {directory}")
        lines.append("")
        lines.append(
            "💡 /project n 切换 | /project list 查看全部 | /project hide n 隐藏"
        )
        if self._hidden_dirs:
            lines.append(
                f"ℹ️ 已隐藏 {len(self._hidden_dirs)} 个项目（重新使用后自动恢复）"
            )
        return chr(10).join(lines)

    async def _cmd_set_model(self, conv_id: str, model_str: str) -> str:
        if "/" not in model_str:
            return "❌ 格式错误，请使用 provider/model 格式。\n例如：/model anthropic/claude-sonnet-4-5"
        self._conv_models[conv_id] = model_str
        session_id = self._sessions.get(conv_id)
        if session_id:
            directory = self._conv_dirs.get(conv_id) or self.directory
            provider, mdl = model_str.split("/", 1)
            await self._patch_preference(
                session_id,
                directory,
                model={"providerID": provider, "modelID": mdl},
            )
        logger.info(f"[/model] {conv_id} -> {model_str}")
        return f"✅ 已切换模型：{model_str}\n（仅对当前对话生效，/new 后将重置）"

    async def _cmd_mode(self, conv_id: str, arg: str) -> str:
        session_id = self._sessions.get(conv_id)
        directory = self._conv_dirs.get(conv_id) or self.directory
        if not arg:
            pref = (
                await self._get_preference(session_id, directory) if session_id else {}
            )
            agent = (pref or {}).get("agent") or self.default_agent or "—"
            return f"🔧 当前模式：{agent}\n💡 /mode plan 或 /mode build 切换模式"
        mode = arg.strip().lower()
        if mode not in ("plan", "build"):
            return "❌ 可用模式：plan、build\n例如：/mode plan"
        if session_id:
            await self._patch_preference(session_id, directory, agent=mode)
        return f"✅ 已切换模式：{mode}"

    async def _cmd_approval(self, conv_id: str, arg: str) -> str:
        session_id = self._sessions.get(conv_id)
        directory = self._conv_dirs.get(conv_id) or self.directory
        if not arg:
            pref = (
                await self._get_preference(session_id, directory) if session_id else {}
            )
            auto = (pref or {}).get("autoAccept")
            if auto is None:
                return "🔔 当前审批模式：手动审批\n💡 /approval auto 自动批准 | /approval ask 手动审批"
            return f"🔔 当前审批模式：{'自动批准' if auto else '手动审批'}\n💡 /approval auto 自动批准 | /approval ask 手动审批"
        mode = arg.strip().lower()
        if mode == "auto":
            if session_id:
                await self._patch_preference(session_id, directory, autoAccept=True)
            return "✅ 已切换为自动批准模式"
        if mode == "ask":
            if session_id:
                await self._patch_preference(session_id, directory, autoAccept=False)
            return "✅ 已切换为手动审批模式"
        return "❌ 可用选项：auto（自动批准）、ask（手动审批）\n例如：/approval auto"

    def _clear_runtime(self, conv_id: str) -> None:
        pending = self._pending_questions.pop(conv_id, None)
        if pending:
            task = pending.get("task")
            if task and not task.done():
                task.cancel()
        pending = self._pending_permissions.pop(conv_id, None)
        if pending:
            task = pending.get("task")
            if task and not task.done():
                task.cancel()
        task = self._tasks.pop(conv_id, None)
        if task and not task.done():
            task.cancel()
        sse = self._sse_tasks.pop(conv_id, None)
        if sse and not sse.done():
            sse.cancel()
        self._question_queues.pop(conv_id, None)
        self._accumulated_text.pop(conv_id, None)

    async def _send_to_conv(self, conv_id: str, text: str) -> None:
        """直接通过微信客户端向指定会话发送消息（不依赖 _active_chat_id）"""
        if not text:
            return
        if self._wechat_client:
            from wechat_agent_sdk.messaging.send import send_response as wechat_send

            ctx = self._wechat_ctx.get(conv_id, "")
            await wechat_send(
                self._wechat_client, conv_id, ChatResponse(text=text), ctx
            )
        elif self._message_sender:
            await self._message_sender(text)

    async def _background_dispatch(
        self, conv_id: str, session_id: str, directory: str, task, q
    ) -> None:
        """后台等待 AI 响应，完成后通过微信客户端投递结果"""
        try:
            if q is not None:
                response = await self._wait_for_response(
                    conv_id, session_id, directory, task, q
                )
            else:
                response = await self._wait_for_response_polling(
                    conv_id, session_id, directory, task
                )
            await self._send_to_conv(conv_id, response.text)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[background] 消息处理失败: {e}")
            try:
                await self._send_to_conv(conv_id, f"处理消息时出错: {e}")
            except Exception:
                pass

    async def _cmd_stop(self, conv_id: str) -> str:
        directory = self._conv_dirs.get(conv_id) or self.directory
        session_id = self._sessions.get(conv_id)
        if not session_id:
            return "当前没有可停止的会话。"

        task = self._tasks.get(conv_id)
        local = any(
            [
                conv_id in self._pending_questions,
                conv_id in self._pending_permissions,
                task is not None and not task.done(),
            ]
        )
        busy = await self._is_session_busy(session_id, directory)
        if not local and not busy:
            return "当前没有正在执行的任务。"

        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        resp = await self._client.post(
            f"{self.base_url}/session/{session_id}/abort",
            headers=headers,
        )
        resp.raise_for_status()
        self._clear_runtime(conv_id)
        logger.info(f"[/stop] 已停止会话 {session_id[:8]}... for {conv_id}")
        return "已停止当前执行。"

    async def chat(self, request: ChatRequest) -> ChatResponse:
        """处理微信消息"""
        if not self._client:
            return ChatResponse(text="错误: 客户端未初始化")

        conv_id = request.conversation_id
        user_text = request.text

        # 缓存 context_token，供后台投递消息时使用
        ctx_token = (request.raw or {}).get("context_token", "")
        if ctx_token:
            self._wechat_ctx[conv_id] = ctx_token

        if request.group_id and request.is_at_bot:
            logger.info(f"[群聊] {request.sender_name}: {user_text}")
        else:
            logger.info(f"[私聊] {conv_id}: {user_text}")

        slash_reply = await self._handle_slash_command(conv_id, user_text)
        if slash_reply is not None:
            directory = self._conv_dirs.get(conv_id) or self.directory
            session_id = self._sessions.get(conv_id)
            if session_id:
                slash_reply = await self._wrap_message(
                    slash_reply, session_id, directory, conv_id
                )
            return ChatResponse(text=slash_reply)

        if conv_id in self._pending_questions:
            return await self._handle_question_reply(conv_id, user_text)

        if conv_id in self._pending_permissions:
            return await self._handle_permission_reply(conv_id, user_text)

        try:
            directory = self._conv_dirs.get(conv_id) or self.directory
            session_id = self._sessions.get(conv_id)
            if not session_id:
                session_id, created = await self._ensure_session(
                    directory, conv_id in self._fresh
                )
                self._sessions[conv_id] = session_id
                self._fresh.discard(conv_id)
                logger.info(
                    f"{'创建' if created else '选择'}会话: {session_id[:8]}... dir={directory}"
                )

            pending = await self._sync_pending(conv_id, session_id, directory)
            if pending:
                return ChatResponse(text=pending)

            if await self._is_session_busy(session_id, directory):
                return ChatResponse(
                    text=await self._format_busy_reply(conv_id, session_id, directory)
                )

            task = self._tasks.get(conv_id)
            if task and not task.done():
                return ChatResponse(
                    text=await self._format_busy_reply(conv_id, session_id, directory)
                )

            model = self._conv_models.get(conv_id) or self.default_model

            q: asyncio.Queue = asyncio.Queue()
            self._question_queues[conv_id] = q
            self._accumulated_text[conv_id] = ""

            task = asyncio.create_task(
                self._send_message(
                    session_id, user_text, model=model, directory=directory
                )
            )
            self._tasks[conv_id] = task
            sse_task = asyncio.create_task(
                self._monitor_sse(conv_id, session_id, directory, task, q)
            )
            self._sse_tasks[conv_id] = sse_task

            # 立即返回空响应（不发送微信消息），释放 SDK 轮询循环；
            # AI 结果由后台任务通过 _send_to_conv 投递。
            asyncio.create_task(
                self._background_dispatch(conv_id, session_id, directory, task, q)
            )
            return ChatResponse(text="")

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP 错误: {e.response.status_code}")
            return ChatResponse(text="服务暂时不可用，请稍后重试")
        except httpx.RequestError as e:
            logger.error(f"连接错误: {e}")
            return ChatResponse(text="无法连接到 Aether 服务")
        except Exception as e:
            logger.error(f"处理错误: {e}")
            return ChatResponse(text=f"处理消息时出错: {e}")

    async def _monitor_sse(
        self, conv_id: str, session_id: str, directory: str, task, q: asyncio.Queue
    ) -> None:
        """订阅 SSE 事件流，实时捕获文本和问题"""
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        try:
            async with self._client.stream(
                "GET",
                f"{self.base_url}/event",
                headers=headers,
                timeout=httpx.Timeout(connect=30.0, read=None, write=None, pool=None),
            ) as sse:
                async for line in sse.aiter_lines():
                    if task.done():
                        break
                    if not line.startswith("data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                    except Exception:
                        continue

                    event_type = event.get("type", "")
                    props = event.get("properties", {})

                    if event_type == "message.part.delta":
                        if (
                            props.get("sessionID") == session_id
                            and props.get("field") == "text"
                        ):
                            delta = props.get("delta", "")
                            if delta:
                                self._accumulated_text[conv_id] = (
                                    self._accumulated_text.get(conv_id, "") + delta
                                )

                    elif event_type == "question.asked":
                        if props.get("sessionID") == session_id:
                            logger.info(f"[SSE] question.asked -> {conv_id}")
                            await q.put(("question", props))

                    elif event_type == "permission.asked":
                        if props.get("sessionID") == session_id:
                            logger.info(f"[SSE] permission.asked -> {conv_id}")
                            await q.put(("permission", props))

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"[SSE] 监听结束: {e}")
        finally:
            await q.put(("done", None))

    async def _wait_for_response(
        self, conv_id: str, session_id: str, directory: str, task, q: asyncio.Queue
    ) -> ChatResponse:
        """等待消息完成：通过 SSE 队列接收事件"""
        while True:
            if task.done():
                break
            try:
                kind, data = await asyncio.wait_for(q.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            if kind == "done":
                logger.warning("[SSE] 连接中断，轮询 /question")
                return await self._wait_for_response_polling(
                    conv_id, session_id, directory, task
                )

            if kind == "question":
                text_so_far = self._accumulated_text.pop(conv_id, "").strip()
                if text_so_far:
                    try:
                        await self._send_to_conv(
                            conv_id,
                            await self._wrap_message(
                                text_so_far, session_id, directory, conv_id
                            ),
                        )
                    except Exception as e:
                        logger.warning(f"推送中间文本失败: {e}")
                self._pending_questions[conv_id] = {
                    "id": data["id"],
                    "questions": data.get("questions", []),
                    "task": task,
                    "session_id": session_id,
                    "directory": directory,
                    "queue": q,
                }
                logger.info(f"[question] 推送问题到微信 {conv_id}")
                return ChatResponse(
                    text=await self._wrap_message(
                        self._format_question_request(data),
                        session_id,
                        directory,
                        conv_id,
                    )
                )

            if kind == "permission":
                text_so_far = self._accumulated_text.pop(conv_id, "").strip()
                if text_so_far:
                    try:
                        await self._send_to_conv(
                            conv_id,
                            await self._wrap_message(
                                text_so_far, session_id, directory, conv_id
                            ),
                        )
                    except Exception as e:
                        logger.warning(f"推送中间文本失败: {e}")
                self._pending_permissions[conv_id] = {
                    "id": data["id"],
                    "permission": data,
                    "task": task,
                    "session_id": session_id,
                    "directory": directory,
                    "queue": q,
                }
                logger.info(f"[permission] 推送授权到微信 {conv_id}")
                return ChatResponse(
                    text=await self._wrap_message(
                        self._format_permission_request(data),
                        session_id,
                        directory,
                        conv_id,
                    )
                )

        sse_task = self._sse_tasks.pop(conv_id, None)
        if sse_task and not sse_task.done():
            sse_task.cancel()
        self._tasks.pop(conv_id, None)
        self._question_queues.pop(conv_id, None)
        self._accumulated_text.pop(conv_id, None)
        self._pending_permissions.pop(conv_id, None)

        try:
            result = await task
            return ChatResponse(
                text=await self._wrap_message(
                    result.get("formatted", "操作已完成"),
                    session_id,
                    directory,
                    conv_id,
                )
            )
        except asyncio.CancelledError:
            return ChatResponse(text="已取消。")
        except httpx.HTTPStatusError as e:
            return ChatResponse(text="服务暂时不可用，请稍后重试")
        except Exception as e:
            logger.error(f"消息任务失败: {e}")
            return ChatResponse(text=f"处理消息时出错: {e}")

    async def _wait_for_response_polling(
        self, conv_id: str, session_id: str, directory: str, task
    ) -> ChatResponse:
        """回退方案：轮询 /question 接口"""
        poll_interval = 2.0
        while not task.done():
            await asyncio.sleep(poll_interval)
            if task.done():
                break
            try:
                question = await self._poll_question_for_session(session_id, directory)
                if question:
                    self._pending_questions[conv_id] = {
                        "id": question["id"],
                        "questions": question.get("questions", []),
                        "task": task,
                        "session_id": session_id,
                        "directory": directory,
                        "queue": None,
                    }
                    return ChatResponse(
                        text=await self._wrap_message(
                            self._format_question_request(question),
                            session_id,
                            directory,
                            conv_id,
                        )
                    )
                permission = await self._poll_permission_for_session(
                    session_id, directory
                )
                if permission:
                    self._pending_permissions[conv_id] = {
                        "id": permission["id"],
                        "permission": permission,
                        "task": task,
                        "session_id": session_id,
                        "directory": directory,
                        "queue": None,
                    }
                    return ChatResponse(
                        text=await self._wrap_message(
                            self._format_permission_request(permission),
                            session_id,
                            directory,
                            conv_id,
                        )
                    )
            except Exception as e:
                logger.warning(f"轮询问题失败: {e}")
        self._tasks.pop(conv_id, None)
        self._pending_permissions.pop(conv_id, None)
        try:
            result = await task
            return ChatResponse(
                text=await self._wrap_message(
                    result.get("formatted", "操作已完成"),
                    session_id,
                    directory,
                    conv_id,
                )
            )
        except asyncio.CancelledError:
            return ChatResponse(text="已取消。")
        except Exception as e:
            return ChatResponse(text=f"处理消息时出错: {e}")

    async def _poll_question_for_session(
        self, session_id: str, directory: str = ""
    ) -> Optional[dict]:
        """查询指定 session 下是否有待回答的 agent 问题"""
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        resp = await self._client.get(f"{self.base_url}/question", headers=headers)
        resp.raise_for_status()
        for q in resp.json():
            if q.get("sessionID") == session_id:
                return q
        return None

    async def _poll_permission_for_session(
        self, session_id: str, directory: str = ""
    ) -> Optional[dict]:
        """查询指定 session 下是否有待授权的请求"""
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        resp = await self._client.get(f"{self.base_url}/permission", headers=headers)
        resp.raise_for_status()
        for item in resp.json():
            if item.get("sessionID") == session_id:
                return item
        return None

    async def _is_session_busy(self, session_id: str, directory: str = "") -> bool:
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        resp = await self._client.get(
            f"{self.base_url}/session/status", headers=headers
        )
        resp.raise_for_status()
        info = resp.json().get(session_id)
        return isinstance(info, dict) and info.get("type") == "busy"

    async def _sync_pending(
        self, conv_id: str, session_id: str, directory: str
    ) -> Optional[str]:
        question = await self._poll_question_for_session(session_id, directory)
        if question:
            self._pending_questions[conv_id] = {
                "id": question["id"],
                "questions": question.get("questions", []),
                "task": None,
                "session_id": session_id,
                "directory": directory,
                "queue": None,
            }
            return await self._wrap_message(
                self._format_question_request(question), session_id, directory, conv_id
            )

        permission = await self._poll_permission_for_session(session_id, directory)
        if permission:
            self._pending_permissions[conv_id] = {
                "id": permission["id"],
                "permission": permission,
                "task": None,
                "session_id": session_id,
                "directory": directory,
                "queue": None,
            }
            return await self._wrap_message(
                self._format_permission_request(permission),
                session_id,
                directory,
                conv_id,
            )

        return None

    async def _format_busy_reply(
        self, conv_id: str, session_id: str, directory: str
    ) -> str:
        if conv_id in self._pending_questions:
            state = "等待你的回答"
        elif conv_id in self._pending_permissions:
            state = "等待你的授权"
        else:
            state = "正在生成回复"
        return await self._wrap_message(
            f"当前会话{state}，请等待当前对话结束后再发送；"
            "如需立即开始新问题，请先 /new 或切换 /session n。"
            "如需停止本会话请输入/stop",
            session_id,
            directory,
            conv_id,
        )

    def _format_question_request(self, question: dict) -> str:
        """将 agent 问题格式化为微信消息"""
        infos = question.get("questions", [])
        parts = ["🤔 Agent 需要您回答：", ""]
        for i, info in enumerate(infos, 1):
            if len(infos) > 1:
                q_text = info.get("question", "")
                parts.append(f"【问题 {i}】{q_text}")
            else:
                parts.append(info.get("question", ""))
            options = info.get("options", [])
            if options:
                parts.append("可选答案：")
                for j, opt in enumerate(options, 1):
                    desc = opt.get("description", "")
                    label = opt.get("label", "")
                    suffix = "：" + desc if desc else ""
                    parts.append(f"  {j}. {label}{suffix}")
        parts.append("")
        parts.append(
            "请直接回复答案（可输入数字编号；若题目允许自定义，也可直接输入文本）。"
        )
        parts.append("如需立即开始新问题，请先 /new 或切换 /session n。")
        return chr(10).join(parts)

    def _format_permission_request(self, permission: dict) -> str:
        """将授权请求格式化为微信消息"""
        parts = ["🔐 当前操作需要你的授权：", ""]
        name = permission.get("permission", "未知权限")
        parts.append(f"权限：{name}")
        patterns = permission.get("patterns", [])
        if patterns:
            parts.append("范围：")
            for item in patterns:
                parts.append(f"  - {item}")
        parts.append("")
        parts.append("请直接回复：")
        parts.append("1. 允许一次（仅这次）")
        parts.append("2. 始终允许（后续同类操作自动通过）")
        parts.append("3. 拒绝（本次不允许执行）")
        parts.append("如需立即开始新问题，请先 /new 或切换 /session n。")
        return chr(10).join(parts)

    async def _handle_question_reply(
        self, conv_id: str, user_text: str
    ) -> ChatResponse:
        """处理用户对 agent 问题的回答"""
        pending = self._pending_questions.pop(conv_id)
        question_id = pending["id"]
        questions = pending["questions"]
        task = pending["task"]
        session_id = pending["session_id"]
        directory = pending.get("directory", "")
        q = pending.get("queue")

        answers = self._parse_question_answers(user_text, questions)
        if answers is None:
            self._pending_questions[conv_id] = pending
            return ChatResponse(
                text=await self._wrap_message(
                    "未识别，请回复答案或数字编号。\n\n"
                    + self._format_question_request({"questions": questions}),
                    session_id,
                    directory,
                    conv_id,
                )
            )
        try:
            headers = (
                {"x-opencode-directory": quote(directory, safe="")} if directory else {}
            )
            resp = await self._client.post(
                f"{self.base_url}/question/{question_id}/reply",
                json={"answers": answers},
                headers=headers,
            )
            resp.raise_for_status()
            logger.info(f"[question] 已回复 {question_id}: {answers}")
        except Exception as e:
            logger.error(f"回复问题失败: {e}")
            self._pending_questions[conv_id] = pending
            err_msg = f"❌ 提交答案失败: {e}"
            return ChatResponse(
                text=await self._wrap_message(
                    err_msg + chr(10) + "请重新发送您的答案。",
                    session_id,
                    directory,
                    conv_id,
                )
            )

        if task is None:
            return ChatResponse(
                text=await self._wrap_message(
                    "已提交回答，请等待当前对话继续处理。",
                    session_id,
                    directory,
                    conv_id,
                )
            )

        asyncio.create_task(
            self._background_dispatch(conv_id, session_id, directory, task, q)
        )
        return ChatResponse(text="")

    async def _handle_permission_reply(
        self, conv_id: str, user_text: str
    ) -> ChatResponse:
        """处理用户对授权请求的回答"""
        pending = self._pending_permissions.pop(conv_id)
        request_id = pending["id"]
        task = pending["task"]
        session_id = pending["session_id"]
        directory = pending.get("directory", "")
        q = pending.get("queue")

        reply = self._parse_permission_reply(user_text)
        if not reply:
            self._pending_permissions[conv_id] = pending
            return ChatResponse(
                text=await self._wrap_message(
                    "未识别，请回复数字编号。\n\n"
                    + self._format_permission_request(pending["permission"]),
                    session_id,
                    directory,
                    conv_id,
                )
            )

        try:
            headers = (
                {"x-opencode-directory": quote(directory, safe="")} if directory else {}
            )
            resp = await self._client.post(
                f"{self.base_url}/permission/{request_id}/reply",
                json={"reply": reply},
                headers=headers,
            )
            resp.raise_for_status()
            logger.info(f"[permission] 已回复 {request_id}: {reply}")
        except Exception as e:
            logger.error(f"回复授权失败: {e}")
            self._pending_permissions[conv_id] = pending
            return ChatResponse(
                text=await self._wrap_message(
                    f"❌ 提交授权失败: {e}\n请重新发送您的选择。",
                    session_id,
                    directory,
                    conv_id,
                )
            )

        if task is None:
            return ChatResponse(
                text=await self._wrap_message(
                    {
                        "once": "已收到授权：允许一次，请等待当前对话继续处理。",
                        "always": "已收到授权：始终允许，请等待当前对话继续处理。",
                        "reject": "已提交拒绝，请等待当前对话继续处理。",
                    }[reply],
                    session_id,
                    directory,
                    conv_id,
                )
            )

        try:
            notice = {
                "once": "已收到授权：允许一次，继续处理中。",
                "always": "已收到授权：始终允许，继续处理中。",
                "reject": "已收到你的选择：拒绝，正在继续处理。",
            }[reply]
            await self._send_to_conv(
                conv_id,
                await self._wrap_message(notice, session_id, directory, conv_id),
            )
        except Exception as e:
            logger.warning(f"推送授权确认失败: {e}")

        asyncio.create_task(
            self._background_dispatch(conv_id, session_id, directory, task, q)
        )
        return ChatResponse(text="")

    def _parse_question_answers(
        self, user_text: str, questions: list
    ) -> Optional[list]:
        """解析用户答案（每个问题一个答案数组）"""
        text = user_text.strip()
        if not text:
            return None
        answers = []
        for info in questions:
            options = info.get("options", [])
            if text.isdigit() and options:
                idx = int(text) - 1
                if 0 <= idx < len(options):
                    answers.append([options[idx]["label"]])
                    continue
                if not info.get("custom", True):
                    return None
            elif options and not info.get("custom", True):
                return None
            answers.append([text])
        return answers

    def _parse_permission_reply(self, user_text: str) -> Optional[str]:
        text = user_text.strip()
        if text == "1":
            return "once"
        if text == "2":
            return "always"
        if text == "3":
            return "reject"
        return None

    async def _create_session(self, directory: str = "") -> str:
        headers = (
            {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        )
        resp = await self._client.post(
            f"{self.base_url}/session", json={}, headers=headers
        )
        resp.raise_for_status()
        return resp.json()["id"]

    async def _send_message(
        self, session_id: str, text: str, model=None, directory=""
    ) -> dict:
        payload = {
            "parts": [{"type": "text", "text": text}],
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
            headers={"x-opencode-directory": quote(directory, safe="")}
            if directory
            else {},
        )
        resp.raise_for_status()
        body = resp.text.strip()
        if not body:
            # 服务端错误（如模型不存在）导致流式响应为空
            model_hint = f"（当前模型：{effective_model}）" if effective_model else ""
            return {
                "formatted": f"❌ 服务端返回空响应，请检查模型是否有效 {model_hint}"
            }
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
            err_msg = error.get("data", {}).get("message") or error.get(
                "name", "未知错误"
            )
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
        if text:
            formatted_parts.append(text)

        return {
            "reasoning": reasoning,
            "text": text,
            "formatted": "\n\n─────────\n\n".join(formatted_parts)
            if formatted_parts
            else "操作已完成",
        }


async def custom_login(client: ILinkBotClient, log=print) -> str:
    """自定义登录流程，输出 base64 二维码"""
    qr_info = None
    for attempt in range(5):
        try:
            qr_info = await client.request_qrcode()
            break
        except httpx.ConnectTimeout:
            if attempt >= 4:
                raise
            log(f"[weixin] 连接超时，重试 ({attempt + 1}/5)...")
            await asyncio.sleep(3.0)
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
            msg = result.get("message") or ""
            if not msg:
                # 网络暂时超时，继续等待
                log("[weixin] 状态查询暂时失败，重试...")
                continue
            raise RuntimeError(f"登录失败: {msg}")

    raise RuntimeError("登录超时")


class CustomWeChatBot(WeChatBot):
    """自定义 Bot，覆盖登录方法"""

    async def login(self, log=print) -> str:
        transport = self._transport
        stored_token = await transport._storage.load_token(transport.account_id)
        if stored_token:
            transport._client.token = stored_token
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

        token = await custom_login(transport._client, log=log)
        await transport._storage.save_token(transport.account_id, token)
        return token


async def _resolve_default_directory(base_url: str) -> str:
    try:
        async with make_httpx(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/project/recent")
            resp.raise_for_status()
            for item in resp.json():
                d = item.get("directory")
                if d:
                    return d
    except Exception as e:
        logger.warning(f"获取最近项目失败，fallback 到 home 目录: {e}")
    return str(Path.home())


async def main():
    base_url = os.getenv("AETHER_URL", "http://127.0.0.1:4096")
    directory = os.getenv("AETHER_WORK_DIR")
    default_model = os.getenv("AETHER_MODEL")
    default_agent = os.getenv("AETHER_AGENT", "build")

    if not directory:
        directory = await _resolve_default_directory(base_url)

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
    # 把微信客户端传给 agent，让后台任务能直接投递消息
    agent._wechat_client = bot._transport._client

    try:
        await bot.run(log=print)
    except KeyboardInterrupt:
        print("\n[Aether] 正在关闭...")


if __name__ == "__main__":
    asyncio.run(main())
