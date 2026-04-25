"""
Aether WeChat Bridge - Thin transport layer

Relays incoming WeChat messages to the Aether TS HTTP API.
Outputs [TOKEN] and [CTX] on stdout so the TS manager can send via iLink Bot API.

Environment variables:
- AETHER_URL: Aether service URL (default: http://127.0.0.1:4096)
- AETHER_WECHAT_QRCODE_FILE: QR code output file path
- AETHER_WECHAT_SESSION_FILE: Session storage file path
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

import httpx

QRCODE_FILE = os.getenv("AETHER_WECHAT_QRCODE_FILE", "")
SESSION_FILE = os.getenv("AETHER_WECHAT_SESSION_FILE", "")
AETHER_URL = os.getenv("AETHER_URL", "http://127.0.0.1:4096")
AETHER_USERNAME = os.getenv("AETHER_USERNAME", "")
AETHER_PASSWORD = os.getenv("AETHER_PASSWORD", "")

_log_dir = (
    Path(SESSION_FILE).parent
    if SESSION_FILE
    else Path.home() / ".config" / "aether-wechat"
)
_log_dir.mkdir(parents=True, exist_ok=True)
_log_file = _log_dir / "bridge.log"

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)
for _h in logging.root.handlers:
    if hasattr(_h, "stream") and hasattr(_h.stream, "reconfigure"):
        try:
            _h.stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
try:
    _fh = logging.FileHandler(_log_file, encoding="utf-8")
    _fh.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
    logging.root.addHandler(_fh)
except Exception:
    pass

from wechat_agent_sdk import (
    Agent,
    ChatRequest,
    ChatResponse,
    WeChatBot,
    LoginRequiredError,
)
from wechat_agent_sdk.api.client import (
    ILinkBotClient,
    DEFAULT_API_BASE,
    SessionExpiredError,
)
from wechat_agent_sdk.api.auth import login_with_qrcode
from wechat_agent_sdk.account.storage import JsonFileStorage


def make_httpx(**kwargs):
    try:
        return httpx.AsyncClient(**kwargs)
    except ImportError as err:
        if "socksio" not in str(err):
            raise
        logger.warning(
            "[weixin] SOCKS proxy detected but socksio not installed, bypassing proxy"
        )
        cfg = dict(kwargs)
        cfg["trust_env"] = False
        return httpx.AsyncClient(**cfg)


async def _make_ilinkbot_client(trust_env=True):
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


_orig_request_qrcode = ILinkBotClient.request_qrcode


async def _request_qrcode_with_fallback(self):
    if not self._client:
        self._client = await _make_ilinkbot_client(trust_env=True)
    try:
        return await _orig_request_qrcode(self)
    except httpx.ConnectTimeout:
        logger.warning("[weixin] request_qrcode timed out, retry without proxy")
        await self._client.aclose()
        self._client = await _make_ilinkbot_client(trust_env=False)
        return await _orig_request_qrcode(self)


ILinkBotClient.request_qrcode = _request_qrcode_with_fallback

CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"


def output_token(token: str):
    payload = json.dumps(
        {"token": token, "base_url": DEFAULT_API_BASE, "cdn_base_url": CDN_BASE_URL}
    )
    print(f"[TOKEN] {payload}")
    sys.stdout.flush()


class RelayAgent(Agent):
    """Thin agent that relays messages to Aether TS HTTP API."""

    def __init__(self):
        super().__init__()
        self._aether_headers = {}
        if AETHER_USERNAME and AETHER_PASSWORD:
            import base64

            cred = base64.b64encode(
                f"{AETHER_USERNAME}:{AETHER_PASSWORD}".encode()
            ).decode()
            self._aether_headers = {"Authorization": f"Basic {cred}"}

    async def chat(self, request: ChatRequest) -> ChatResponse:
        conv_id = request.conversation_id
        text = request.text
        raw = request.raw or {}

        message_id = (
            getattr(request, "message_id", "")
            or raw.get("msg_id", "")
            or raw.get("message_id", "")
            or ""
        )
        root_id = (
            getattr(request, "root_id", "")
            or getattr(request, "parent_id", "")
            or raw.get("root_id", "")
            or raw.get("parent_id", "")
            or message_id
        )

        ctx_token = raw.get("context_token", "")
        print(f"[CTX] {json.dumps({'conv_id': conv_id, 'context_token': ctx_token})}")
        sys.stdout.flush()

        if ctx_token:
            logger.info(f"[relay] cached context_token for conv={conv_id}")
        else:
            logger.warning(
                f"[relay] no context_token in raw for conv={conv_id}, raw keys: {list(raw.keys()) if raw else 'none'}"
            )

        logger.info(
            f"[relay] conv={conv_id} msg={message_id} text={text[:50]} ctx={ctx_token[:8] if ctx_token else 'none'}"
        )

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{AETHER_URL.rstrip('/')}/mobile/wechat/message",
                    headers={
                        **self._aether_headers,
                        "Content-Type": "application/json",
                    },
                    json={
                        "chatId": conv_id,
                        "messageId": message_id,
                        "text": text,
                        "rootId": root_id,
                    },
                )
                if resp.status_code != 200:
                    logger.warning(
                        f"[relay] POST /mobile/wechat/message failed: {resp.status_code} {resp.text[:200]}"
                    )
                else:
                    logger.info(f"[relay] forwarded ok: {resp.json()}")
        except Exception as e:
            logger.warning(f"[relay] failed to forward message: {e}")

        return ChatResponse(text="")


async def custom_login(client: ILinkBotClient, log=print) -> str:
    qr_info = None
    for attempt in range(5):
        try:
            qr_info = await client.request_qrcode()
            break
        except httpx.ConnectTimeout:
            if attempt >= 4:
                raise
            log(f"[weixin] connection timeout, retry ({attempt + 1}/5)...")
            await asyncio.sleep(3.0)

    qrcode_url = qr_info["qrcode_url"]
    qr_uuid = qr_info["uuid"]

    import base64

    qr_b64 = base64.b64encode(qrcode_url.encode()).decode()
    print(f"[QR] data:image/png;base64,{qr_b64}")
    sys.stdout.flush()

    if QRCODE_FILE:
        try:
            Path(QRCODE_FILE).parent.mkdir(parents=True, exist_ok=True)
            Path(QRCODE_FILE).write_text(qrcode_url)
        except Exception as e:
            logger.warning(f"QR code file write failed: {e}")

    log("waiting for QR scan...")
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
            output_token(token)

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
                    logger.warning(f"session save failed: {e}")

            return token
        elif status == "scanned":
            log("scanned, confirm on phone...")
        elif status == "expired":
            raise RuntimeError("QR code expired")
        elif status == "error":
            msg = result.get("message") or ""
            if not msg:
                log("[weixin] status query temporarily failed, retry...")
                continue
            raise RuntimeError(f"login failed: {msg}")

    raise RuntimeError("login timeout")


class CustomWeChatBot(WeChatBot):
    def _setup_message_sender(self):
        self._message_sender = lambda text: asyncio.sleep(0)

    async def login(self, log=print) -> str:
        transport = self._transport
        stored_token = await transport._storage.load_token(transport.account_id)
        if stored_token:
            transport._client.token = stored_token
            log("[weixin] using saved token")
            print("[登录成功] user: unknown (saved account)")
            sys.stdout.flush()
            output_token(stored_token)

            if SESSION_FILE:
                try:
                    session_data = {
                        "connected": True,
                        "user": {"id": "unknown", "name": "saved account"},
                        "createdAt": datetime.now().isoformat(),
                    }
                    Path(SESSION_FILE).parent.mkdir(parents=True, exist_ok=True)
                    Path(SESSION_FILE).write_text(
                        json.dumps(session_data, ensure_ascii=False)
                    )
                except Exception as e:
                    logger.warning(f"session save failed: {e}")
            return stored_token

        token = await custom_login(transport._client, log=log)
        await transport._storage.save_token(transport.account_id, token)
        return token

    async def run(self, log=print, auto_login=True) -> None:
        if self._transport.needs_login:
            if auto_login:
                await self.login(log=log)
            else:
                raise LoginRequiredError("No token.")

        while True:
            await self._transport.connect()
            await self._agent.on_start()
            self._running = True
            self._semaphore = asyncio.Semaphore(self._max_concurrent)
            self._setup_message_sender()
            log(f"[weixin] Bot started (account={self._transport.account_id})")

            try:
                async for raw_msg in self._transport.messages():
                    if not self._running:
                        return
                    task = asyncio.create_task(self._handle_message_guarded(raw_msg))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
            except SessionExpiredError:
                log("[weixin] session expired, re-login...")
                if self._tasks:
                    await asyncio.gather(*self._tasks, return_exceptions=True)
                self._tasks.clear()
                await self._agent.on_stop()
                self._running = False
                if SESSION_FILE:
                    try:
                        Path(SESSION_FILE).write_text(
                            json.dumps(
                                {"connected": False, "reason": "session_expired"},
                                ensure_ascii=False,
                            )
                        )
                    except Exception:
                        pass
                self._transport._client.token = ""
                await self._transport._storage.save_token(
                    self._transport.account_id, ""
                )
                await self._transport.disconnect()
                log("[weixin] re-login...")
                await self.login(log=log)
                continue
            except asyncio.CancelledError:
                return
            finally:
                if self._running:
                    if self._tasks:
                        await asyncio.gather(*self._tasks, return_exceptions=True)
                    self._tasks.clear()
                    await self.stop()


async def main():
    print("=" * 50)
    print("Aether WeChat Bridge (thin transport)")
    print("=" * 50)
    print()

    agent = RelayAgent()
    bot = CustomWeChatBot(
        agent=agent,
        account_id="aether",
        storage=JsonFileStorage(Path(SESSION_FILE).parent)
        if SESSION_FILE
        else JsonFileStorage(),
    )

    try:
        await bot.run(log=print)
    except KeyboardInterrupt:
        print("\n[Aether] shutting down...")


if __name__ == "__main__":
    asyncio.run(main())
