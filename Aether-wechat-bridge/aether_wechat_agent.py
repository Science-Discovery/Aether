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
# 确保 stdout/stderr 使用 UTF-8（作为 Electron 子进程运行时管道可能默认 ASCII）
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, 'reconfigure'):
        try:
            _s.reconfigure(encoding='utf-8', errors='replace')
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

import sqlite3
import httpx

# 设置日志
logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)
# 确保日志 handler 的输出流也使用 UTF-8（basicConfig 可能绑定了旧的 stderr 引用）
for _h in logging.root.handlers:
    if hasattr(_h, 'stream') and hasattr(_h.stream, 'reconfigure'):
        try:
            _h.stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

# SDK imports
from wechat_agent_sdk import Agent, ChatRequest, ChatResponse, WeChatBot
from wechat_agent_sdk.api.client import ILinkBotClient, DEFAULT_API_BASE
from wechat_agent_sdk.api.auth import login_with_qrcode
from wechat_agent_sdk.account.storage import JsonFileStorage

# Patch ILinkBotClient: fall back to trust_env=False if system proxy causes ConnectTimeout
async def _make_ilinkbot_client(trust_env: bool) -> httpx.AsyncClient:
    from wechat_agent_sdk.api.client import POLL_TIMEOUT, _make_wechat_uin
    async def _inject_uin(request):
        request.headers["X-WECHAT-UIN"] = _make_wechat_uin()
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=POLL_TIMEOUT + 10, write=10.0, pool=10.0),
        headers={"Content-Type": "application/json", "AuthorizationType": "ilink_bot_token"},
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



HELP_TEXT = (
    """📋 可用命令：

/new          开启新对话（清除当前会话上下文）
/model        查看可用模型列表及当前模型
/model id   切换模型，例如：/model opencode/minimax-m2.5-free
/project      查看当前工作项目
/help         显示此帮助信息"""
)


def _read_projects_from_db() -> list[dict]:
    """从所有 opencode SQLite db 读取项目和 session 目录"""
    home = Path.home()
    candidates = [
        home / ".local" / "share" / "opencode",
        home / "Library" / "Application Support" / "opencode",
    ]
    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        candidates.append(Path(local_app) / "opencode")
    override = os.environ.get("AETHER_OPENCODE_DATA_DIR", "")
    if override:
        candidates = [Path(override)]

    _skip = ("/bin", "/dist", chr(92) + "bin", chr(92) + "dist")
    seen: dict[str, dict] = {}
    for data_dir in candidates:
        if not data_dir.exists():
            continue
        for db_path in sorted(data_dir.glob("opencode*.db")):
            for suffix in ("?mode=ro&immutable=1", "?mode=ro"):
                try:
                    con = sqlite3.connect(db_path.as_uri() + suffix, uri=True)
                    cur = con.cursor()
                    cur.execute("SELECT id, worktree, name FROM project")
                    for pid, worktree, name in cur.fetchall():
                        if worktree and worktree != "/" and worktree not in seen:
                            seen[worktree] = {"id": pid, "worktree": worktree, "name": name}
                    cur.execute("SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL")
                    for (directory,) in cur.fetchall():
                        if directory and directory != "/" and directory not in seen:
                            if not any(directory.endswith(s) for s in _skip):
                                seen[directory] = {"id": "", "worktree": directory, "name": None}
                    con.close()
                    break
                except Exception:
                    pass
        break
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
        self._pending_questions: dict[str, dict] = {}
        self._sse_tasks: dict[str, object] = {}
        self._accumulated_text: dict[str, str] = {}
        self._question_queues: dict[str, object] = {}
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
            pending = self._pending_questions.pop(conv_id, None)
            if pending:
                task = pending.get('task')
                if task and not task.done():
                    task.cancel()
            sse = self._sse_tasks.pop(conv_id, None)
            if sse and not sse.done():
                sse.cancel()
            self._question_queues.pop(conv_id, None)
            self._accumulated_text.pop(conv_id, None)
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
            sorted_ids = sorted(models.keys(), key=lambda m: (m != default_mid, m))
            for model_id in sorted_ids:
                tag = ' ★' if model_id == default_mid else ''
                lines.append(f'  {pid}/{model_id}{tag}')
        if len(lines) <= 3:
            lines.append('（暂无已配置的模型，请先在 Aether 中连接 provider）')
        lines.append('')
        lines.append('💡 /model opencode/minimax-m2.5-free')
        return chr(10).join(lines)

    async def _cmd_project(self, conv_id: str, arg: str) -> str:
        # 从所有 SQLite db 读取项目列表（与侧边栏一致）
        # session 仍通过 HTTP API 创建，始终出现在当前 Web UI
        projects = _read_projects_from_db()
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
        lines.append('💡 /project n 切换项目')
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

        if conv_id in self._pending_questions:
            return await self._handle_question_reply(conv_id, user_text)

        try:
            directory = self._conv_dirs.get(conv_id) or self.directory
            session_id = self._sessions.get(conv_id)
            if not session_id:
                session_id = await self._create_session(directory=directory)
                self._sessions[conv_id] = session_id
                logger.info(f"创建新会话: {session_id[:8]}... dir={directory}")

            model = self._conv_models.get(conv_id) or self.default_model

            q: asyncio.Queue = asyncio.Queue()
            self._question_queues[conv_id] = q
            self._accumulated_text[conv_id] = ""

            task = asyncio.create_task(
                self._send_message(session_id, user_text, model=model, directory=directory)
            )
            sse_task = asyncio.create_task(
                self._monitor_sse(conv_id, session_id, directory, task, q)
            )
            self._sse_tasks[conv_id] = sse_task

            return await self._wait_for_response(conv_id, session_id, directory, task, q)

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP 错误: {e.response.status_code}")
            return ChatResponse(text="服务暂时不可用，请稍后重试")
        except httpx.RequestError as e:
            logger.error(f"连接错误: {e}")
            return ChatResponse(text="无法连接到 Aether 服务")
        except Exception as e:
            logger.error(f"处理错误: {e}")
            return ChatResponse(text=f"处理消息时出错: {e}")

    async def _monitor_sse(self, conv_id: str, session_id: str, directory: str, task, q: asyncio.Queue) -> None:
        """订阅 SSE 事件流，实时捕获文本和问题"""
        headers = {"x-opencode-directory": quote(directory, safe="")} if directory else {}
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
                        if props.get("sessionID") == session_id and props.get("field") == "text":
                            delta = props.get("delta", "")
                            if delta:
                                self._accumulated_text[conv_id] = (
                                    self._accumulated_text.get(conv_id, "") + delta
                                )

                    elif event_type == "question.asked":
                        if props.get("sessionID") == session_id:
                            logger.info(f"[SSE] question.asked -> {conv_id}")
                            await q.put(("question", props))

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"[SSE] 监听结束: {e}")
        finally:
            await q.put(("done", None))

    async def _wait_for_response(self, conv_id: str, session_id: str, directory: str, task, q: asyncio.Queue) -> ChatResponse:
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
                return await self._wait_for_response_polling(conv_id, session_id, directory, task)

            if kind == "question":
                text_so_far = self._accumulated_text.pop(conv_id, "").strip()
                if text_so_far and self._message_sender:
                    try:
                        await self._message_sender(text_so_far)
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
                return ChatResponse(text=self._format_question_request(data))

        sse_task = self._sse_tasks.pop(conv_id, None)
        if sse_task and not sse_task.done():
            sse_task.cancel()
        self._question_queues.pop(conv_id, None)
        self._accumulated_text.pop(conv_id, None)

        try:
            result = await task
            return ChatResponse(text=result.get("formatted", "操作已完成"))
        except asyncio.CancelledError:
            return ChatResponse(text="已取消。")
        except httpx.HTTPStatusError as e:
            return ChatResponse(text="服务暂时不可用，请稍后重试")
        except Exception as e:
            logger.error(f"消息任务失败: {e}")
            return ChatResponse(text=f"处理消息时出错: {e}")

    async def _wait_for_response_polling(self, conv_id: str, session_id: str, directory: str, task) -> ChatResponse:
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
                    return ChatResponse(text=self._format_question_request(question))
            except Exception as e:
                logger.warning(f"轮询问题失败: {e}")
        try:
            result = await task
            return ChatResponse(text=result.get("formatted", "操作已完成"))
        except asyncio.CancelledError:
            return ChatResponse(text="已取消。")
        except Exception as e:
            return ChatResponse(text=f"处理消息时出错: {e}")

    async def _poll_question_for_session(self, session_id: str, directory: str = "") -> Optional[dict]:
        """查询指定 session 下是否有待回答的 agent 问题"""
        headers = {"x-opencode-directory": quote(directory, safe="")} if directory else {}
        resp = await self._client.get(f"{self.base_url}/question", headers=headers)
        resp.raise_for_status()
        for q in resp.json():
            if q.get("sessionID") == session_id:
                return q
        return None

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
        parts.append("请直接回复答案（输入数字选择选项，或直接输入自定义答案）")
        return chr(10).join(parts)

    async def _handle_question_reply(self, conv_id: str, user_text: str) -> ChatResponse:
        """处理用户对 agent 问题的回答"""
        pending = self._pending_questions.pop(conv_id)
        question_id = pending["id"]
        questions = pending["questions"]
        task = pending["task"]
        session_id = pending["session_id"]
        directory = pending.get("directory", "")
        q = pending.get("queue")

        answers = self._parse_question_answers(user_text, questions)
        try:
            headers = {"x-opencode-directory": quote(directory, safe="")} if directory else {}
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
            return ChatResponse(text=err_msg + chr(10) + "请重新发送您的答案。")

        if q is not None:
            return await self._wait_for_response(conv_id, session_id, directory, task, q)
        else:
            return await self._wait_for_response_polling(conv_id, session_id, directory, task)

    def _parse_question_answers(self, user_text: str, questions: list) -> list:
        """解析用户答案（每个问题一个答案数组）"""
        text = user_text.strip()
        answers = []
        for info in questions:
            options = info.get("options", [])
            answer = [text]
            if options:
                try:
                    idx = int(text) - 1
                    if 0 <= idx < len(options):
                        answer = [options[idx]["label"]]
                except ValueError:
                    pass
            answers.append(answer)
        return answers
    async def _create_session(self, directory: str = "") -> str:
        headers = {"x-opencode-directory": quote(directory, safe='')} if directory else {}
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
            headers={"x-opencode-directory": quote(directory, safe='')} if directory else {},
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
        # 自动从数据库选择第一个项目作为默认目录
        projects = _read_projects_from_db()
        if projects:
            directory = projects[0]["worktree"]
            name = projects[0].get("name") or directory.replace(chr(92), '/').rstrip('/').split('/')[-1]
            logger.info(f"自动选择默认项目: {name} ({directory})")
        else:
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
