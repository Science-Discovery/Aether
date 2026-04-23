"""Tests for WeChat file-sending feature in aether_wechat_agent.py.

Run from repo root:
    python Aether-wechat-bridge/test_file_send.py

Tests cover:
- intent detection (positive and negative)
- file path extraction from text (Windows + macOS/Linux)
- read-file extraction from tool parts
- safety validation (workspace scope, size, blocked extensions)
- end-to-end _try_send_files orchestration
- command invulnerability (slash commands untouched)
"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


def _setup_mock_sdk():
    mock_sdk = types.ModuleType("wechat_agent_sdk")
    mock_sdk.Agent = type("Agent", (), {})
    mock_sdk.ChatRequest = type("ChatRequest", (), {})
    mock_sdk.ChatResponse = type(
        "ChatResponse",
        (),
        {"__init__": lambda self, **kw: setattr(self, "__dict__", kw)},
    )
    mock_sdk.WeChatBot = type("WeChatBot", (), {})
    mock_api = types.ModuleType("wechat_agent_sdk.api")
    mock_api_client = (
        types.ModuleModule("wechat_agent_sdk.api.client")
        if hasattr(types, "ModuleModule")
        else types.ModuleType("wechat_agent_sdk.api.client")
    )
    mock_api_client.ILinkBotClient = type(
        "ILinkBotClient", (), {"request_qrcode": None}
    )
    mock_api_client.DEFAULT_API_BASE = "https://example.com"
    mock_api_client.POLL_TIMEOUT = 30
    mock_api_client._make_wechat_uin = lambda: ""
    mock_api_auth = types.ModuleType("wechat_agent_sdk.api.auth")
    mock_api_auth.login_with_qrcode = lambda *a, **kw: None
    mock_account = types.ModuleType("wechat_agent_sdk.account")
    mock_account_storage = types.ModuleType("wechat_agent_sdk.account.storage")
    mock_account_storage.JsonFileStorage = type("JsonFileStorage", (), {})
    mock_messaging = types.ModuleType("wechat_agent_sdk.messaging")
    mock_messaging_send = types.ModuleType("wechat_agent_sdk.messaging.send")
    mock_messaging_send.send_response = AsyncMock()
    sys.modules["wechat_agent_sdk"] = mock_sdk
    sys.modules["wechat_agent_sdk.api"] = mock_api
    sys.modules["wechat_agent_sdk.api.client"] = mock_api_client
    sys.modules["wechat_agent_sdk.api.auth"] = mock_api_auth
    sys.modules["wechat_agent_sdk.account"] = mock_account
    sys.modules["wechat_agent_sdk.account.storage"] = mock_account_storage
    sys.modules["wechat_agent_sdk.messaging"] = mock_messaging
    sys.modules["wechat_agent_sdk.messaging.send"] = mock_messaging_send


_setup_mock_sdk()

from aether_wechat_agent import AetherAgent, HELP_TEXT


class _AgentFixture:
    def __init__(self, tmpdir: str):
        self.agent = AetherAgent.__new__(AetherAgent)
        self.agent.directory = tmpdir
        self.agent._last_user_text = {}
        self.agent._last_result = {}
        self.agent._bot_transport = None
        self.agent._wechat_ctx = {}
        self.agent._wechat_client = None
        self.agent._message_sender = None
        self.agent._sender_script = os.path.join(tmpdir, "send_file.ts")
        self.tmpdir = tmpdir


class TestFileIntentDetection(unittest.TestCase):
    def setUp(self):
        self.fix = _AgentFixture(tempfile.mkdtemp())

    def test_positive_chinese(self):
        for text in [
            "把这个文件发给我",
            "请把源文件发来",
            "我要原文件",
            "把那个文件发过来",
            "给我原始文件",
            "帮我发文件",
        ]:
            with self.subTest(text=text):
                self.assertTrue(self.fix.agent._detect_file_intent(text))

    def test_positive_english(self):
        for text in [
            "please send me the file",
            "Send File to me",
            "can you send me the result?",
        ]:
            with self.subTest(text=text):
                self.assertTrue(self.fix.agent._detect_file_intent(text))

    def test_negative(self):
        for text in [
            "帮我读一下这个文件",
            "这个文件写了什么",
            "/model",
            "/help",
            "你好",
            "请解释这段代码",
            "发送消息给小明",
            "查看文件内容",
        ]:
            with self.subTest(text=text):
                self.assertFalse(self.fix.agent._detect_file_intent(text))

    def test_file_prompt_injects_absolute_path_hint(self):
        text = "把那个.jpg文件发给我"
        out = self.fix.agent._file_prompt(text)
        self.assertIn(text, out)
        self.assertIn("完整绝对路径", out)
        self.assertIn("E:\\\\work\\\\demo\\\\file.jpg", out)
        self.assertIn("/Users/demo/file.jpg", out)
        self.assertIn("/home/demo/file.jpg", out)

    def test_file_prompt_keeps_normal_message_unchanged(self):
        text = "请解释这张图"
        self.assertEqual(self.fix.agent._file_prompt(text), text)


class TestExtractReadFiles(unittest.TestCase):
    def setUp(self):
        self.fix = _AgentFixture(tempfile.mkdtemp())

    def test_extracts_read_tool_files(self):
        result = {
            "parts": [
                {"type": "text", "text": "Here is the file"},
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/home/user/project/main.py"},
                        "output": "file content",
                    },
                },
            ]
        }
        self.assertEqual(
            self.fix.agent._extract_read_files(result), ["/home/user/project/main.py"]
        )

    def test_extracts_multiple_dedup(self):
        result = {
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/a/b.py"},
                        "output": "x",
                    },
                },
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/a/b.py"},
                        "output": "y",
                    },
                },
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/a/c.py"},
                        "output": "z",
                    },
                },
            ]
        }
        self.assertEqual(
            self.fix.agent._extract_read_files(result), ["/a/b.py", "/a/c.py"]
        )

    def test_ignores_non_read_tools(self):
        result = {
            "parts": [
                {
                    "type": "tool",
                    "tool": "write",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/a/output.py"},
                        "output": "wrote",
                    },
                },
            ]
        }
        self.assertEqual(self.fix.agent._extract_read_files(result), [])

    def test_ignores_incomplete_status(self):
        result = {
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "running",
                        "input": {"filePath": "/a/reading.py"},
                    },
                },
            ]
        }
        self.assertEqual(self.fix.agent._extract_read_files(result), [])

    def test_empty(self):
        self.assertEqual(self.fix.agent._extract_read_files({}), [])
        self.assertEqual(self.fix.agent._extract_read_files({"parts": []}), [])


class TestExtractPathsFromText(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.fix = _AgentFixture(self.tmpdir)

    def _create(self, name: str) -> str:
        p = Path(self.tmpdir) / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("test", encoding="utf-8")
        return str(p)

    def test_windows_path(self):
        fp = self._create("readme.md")
        text = f"文件内容在 `{fp}` 中"
        files = self.fix.agent._extract_paths_from_text(text)
        self.assertTrue(
            any(Path(f).samefile(Path(fp)) for f in files), f"Expected {fp} in {files}"
        )

    def test_windows_path_with_spaces(self):
        fp = self._create("26 GF long/Long-Paper-V1.pdf")
        text = f"完整路径是：{fp}"
        files = self.fix.agent._extract_paths_from_text(text)
        self.assertTrue(
            any(Path(f).samefile(Path(fp)) for f in files), f"Expected {fp} in {files}"
        )

    def test_unix_style_path(self):
        fp = self._create("config.json")
        text = f"请查看 {fp}"
        files = self.fix.agent._extract_paths_from_text(text)
        self.assertTrue(any(Path(f).samefile(Path(fp)) for f in files))

    def test_backtick_path(self):
        fp = self._create("notes.txt")
        text = f"结果在 `{fp}`"
        files = self.fix.agent._extract_paths_from_text(text)
        self.assertTrue(any(Path(f).samefile(Path(fp)) for f in files))

    def test_nonexistent_ignored(self):
        text = "文件在 `C:\\nonexistent\\file.txt`"
        self.assertEqual(self.fix.agent._extract_paths_from_text(text), [])

    def test_mac_style_path(self):
        fp = self._create("src/main.ts")
        text = f"Created {fp}"
        files = self.fix.agent._extract_paths_from_text(text)
        self.assertTrue(any(Path(f).samefile(Path(fp)) for f in files))

    def test_dedup(self):
        fp = self._create("dup.txt")
        text = f"`{fp}` and also `{fp}`"
        self.assertEqual(len(self.fix.agent._extract_paths_from_text(text)), 1)

    def test_chinese_trailing_punct(self):
        fp = self._create("data.csv")
        text = f"文件：{fp}，请查看"
        files = self.fix.agent._extract_paths_from_text(text)
        self.assertTrue(any(Path(f).samefile(Path(fp)) for f in files))

    def test_slash_path_mac(self):
        tmpdir2 = tempfile.mkdtemp()
        fp = Path(tmpdir2) / "report.md"
        fp.write_text("# Report", encoding="utf-8")
        native_path = str(fp)
        text = f"Generated report at {native_path}"
        files = self.fix.agent._extract_paths_from_text(text)
        self.assertTrue(
            any(Path(f).samefile(fp) for f in files),
            f"Expected {native_path} in {files}",
        )


class TestValidateFile(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.fix = _AgentFixture(self.tmpdir)

    def _create(self, name: str, size: int = 100) -> str:
        p = Path(self.tmpdir) / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * size)
        return str(p)

    def test_valid_file(self):
        self.assertIsNotNone(
            self.fix.agent._validate_file(self._create("good.txt"), self.tmpdir)
        )

    def test_nonexistent(self):
        self.assertIsNone(
            self.fix.agent._validate_file(
                os.path.join(self.tmpdir, "nope.txt"), self.tmpdir
            )
        )

    def test_directory(self):
        sub = os.path.join(self.tmpdir, "subdir")
        os.makedirs(sub, exist_ok=True)
        self.assertIsNone(self.fix.agent._validate_file(sub, self.tmpdir))

    def test_outside_workspace(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            f.write(b"secret")
            external = f.name
        try:
            self.assertIsNone(self.fix.agent._validate_file(external, self.tmpdir))
        finally:
            os.unlink(external)

    def test_blocked_extensions(self):
        for ext in [
            ".env",
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".jks",
            ".keystore",
            ".secret",
            ".credentials",
            ".sqlite",
            ".sqlite3",
            ".db",
            ".ldb",
        ]:
            with self.subTest(ext=ext):
                self.assertIsNone(
                    self.fix.agent._validate_file(
                        self._create(f"bad{ext}"), self.tmpdir
                    )
                )

    def test_allowed_code_files(self):
        for name in [
            "main.py",
            "index.ts",
            "config.json",
            "readme.md",
            "style.css",
            "app.jsx",
            "lib.rs",
        ]:
            with self.subTest(name=name):
                self.assertIsNotNone(
                    self.fix.agent._validate_file(self._create(name), self.tmpdir)
                )

    def test_nested_subdir_file(self):
        nested = Path(self.tmpdir) / "src" / "deep" / "file.py"
        nested.parent.mkdir(parents=True, exist_ok=True)
        nested.write_text("code", encoding="utf-8")
        self.assertIsNotNone(self.fix.agent._validate_file(str(nested), self.tmpdir))


class TestSendFileToConv(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.fix = _AgentFixture(self.tmpdir)

    def test_no_transport_returns_false(self):
        self.fix.agent._bot_transport = None
        ok = asyncio.get_event_loop().run_until_complete(
            self.fix.agent._send_file_to_conv("conv1", "/some/file.txt")
        )
        self.assertFalse(ok)

    @patch("aether_wechat_agent.shutil.which", return_value="bun")
    @patch("aether_wechat_agent.subprocess.run")
    def test_subprocess_exception_returns_false(self, run_mock, _which):
        transport = MagicMock()
        transport._client.token = "tok"
        transport._client._base_url = "https://example.com"
        transport.account_id = "aether"
        self.fix.agent._bot_transport = transport
        self.fix.agent._wechat_ctx = {"conv1": "ctx"}
        fp = str(Path(self.tmpdir) / "test.txt")
        Path(fp).write_text("hello", encoding="utf-8")
        Path(self.fix.agent._sender_script).write_text("", encoding="utf-8")
        run_mock.side_effect = RuntimeError("upload failed")
        ok = asyncio.get_event_loop().run_until_complete(
            self.fix.agent._send_file_to_conv("conv1", fp)
        )
        self.assertFalse(ok)

    @patch("aether_wechat_agent.shutil.which", return_value="bun")
    @patch("aether_wechat_agent.subprocess.run")
    def test_transport_success(self, run_mock, _which):
        transport = MagicMock()
        transport._client.token = "tok123"
        transport._client._base_url = "https://example.com"
        transport.account_id = "aether"
        self.fix.agent._bot_transport = transport
        self.fix.agent._wechat_ctx = {"conv1": "ctx123"}
        fp = str(Path(self.tmpdir) / "test.txt")
        Path(fp).write_text("hello", encoding="utf-8")
        Path(self.fix.agent._sender_script).write_text("", encoding="utf-8")
        run_mock.return_value = types.SimpleNamespace(
            returncode=0, stdout='{"ok":true}', stderr=""
        )
        ok = asyncio.get_event_loop().run_until_complete(
            self.fix.agent._send_file_to_conv("conv1", fp)
        )
        self.assertTrue(ok)
        cmd = run_mock.call_args.args[0]
        self.assertIn("--chat-id", cmd)
        self.assertIn("conv1", cmd)
        self.assertIn("--context-token", cmd)
        self.assertIn("ctx123", cmd)
        self.assertIn("--cdn-base-url", cmd)

    @patch("aether_wechat_agent.shutil.which", return_value="bun")
    def test_missing_context_returns_false(self, _which):
        transport = MagicMock()
        transport._client.token = "tok123"
        transport._client._base_url = "https://example.com"
        transport.account_id = "aether"
        self.fix.agent._bot_transport = transport
        fp = str(Path(self.tmpdir) / "test.txt")
        Path(fp).write_text("hello", encoding="utf-8")
        Path(self.fix.agent._sender_script).write_text("", encoding="utf-8")
        ok = asyncio.get_event_loop().run_until_complete(
            self.fix.agent._send_file_to_conv("conv1", fp)
        )
        self.assertFalse(ok)


class TestTrySendFiles(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.fix = _AgentFixture(self.tmpdir)

    def test_no_candidates_silently_returns(self):
        async def run():
            await self.fix.agent._try_send_files(
                "conv1", "sid", self.tmpdir, "no paths here"
            )

        asyncio.get_event_loop().run_until_complete(run())

    def test_all_blocked_no_send(self):
        env_file = Path(self.tmpdir) / ".env"
        env_file.write_text("SECRET=123", encoding="utf-8")
        self.fix.agent._last_result["conv1"] = {
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": str(env_file)},
                        "output": "env",
                    },
                },
            ]
        }
        self.fix.agent._send_file_to_conv = AsyncMock(return_value=False)

        async def run():
            await self.fix.agent._try_send_files("conv1", "sid", self.tmpdir, "")

        asyncio.get_event_loop().run_until_complete(run())
        self.fix.agent._send_file_to_conv.assert_not_called()

    def test_sends_valid_files(self):
        good = Path(self.tmpdir) / "result.txt"
        good.write_text("data", encoding="utf-8")
        self.fix.agent._last_result["conv1"] = {
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": str(good)},
                        "output": "content",
                    },
                },
            ]
        }
        self.fix.agent._send_file_to_conv = AsyncMock(return_value=True)

        async def run():
            await self.fix.agent._try_send_files("conv1", "sid", self.tmpdir, "")

        asyncio.get_event_loop().run_until_complete(run())
        self.fix.agent._send_file_to_conv.assert_called_once_with("conv1", str(good))

    def test_mixed_valid_and_blocked(self):
        good = Path(self.tmpdir) / "ok.py"
        good.write_text("code", encoding="utf-8")
        bad = Path(self.tmpdir) / "secret.key"
        bad.write_text("key", encoding="utf-8")
        self.fix.agent._last_result["conv1"] = {
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": str(good)},
                        "output": "g",
                    },
                },
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": str(bad)},
                        "output": "b",
                    },
                },
            ]
        }
        sent_files = []
        self.fix.agent._send_file_to_conv = AsyncMock(
            side_effect=lambda cid, fp: sent_files.append(fp)
        )

        async def run():
            await self.fix.agent._try_send_files("conv1", "sid", self.tmpdir, "")

        asyncio.get_event_loop().run_until_complete(run())
        self.assertEqual(len(sent_files), 1)
        self.assertTrue(Path(sent_files[0]).samefile(good))

    def test_fallback_to_text_paths(self):
        good = Path(self.tmpdir) / "from_text.md"
        good.write_text("# doc", encoding="utf-8")
        self.fix.agent._last_result["conv1"] = {"parts": []}
        self.fix.agent._send_file_to_conv = AsyncMock(return_value=True)
        text = f"文件已生成：`{good}`"

        async def run():
            await self.fix.agent._try_send_files("conv1", "sid", self.tmpdir, text)

        asyncio.get_event_loop().run_until_complete(run())
        self.fix.agent._send_file_to_conv.assert_called_once()

    def test_all_send_fail_sends_path_notice(self):
        good = Path(self.tmpdir) / "fail.txt"
        good.write_text("x", encoding="utf-8")
        self.fix.agent._last_result["conv1"] = {
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": str(good)},
                        "output": "x",
                    },
                },
            ]
        }
        self.fix.agent._send_file_to_conv = AsyncMock(return_value=False)
        sent_messages = []
        self.fix.agent._send_to_conv = AsyncMock(
            side_effect=lambda cid, txt: sent_messages.append(txt)
        )

        async def run():
            await self.fix.agent._try_send_files("conv1", "sid", self.tmpdir, "")

        asyncio.get_event_loop().run_until_complete(run())
        self.assertTrue(any("发送失败" in m for m in sent_messages))

    def test_max_5_files(self):
        parts = []
        for i in range(8):
            p = Path(self.tmpdir) / f"f{i}.txt"
            p.write_text(str(i), encoding="utf-8")
            parts.append(
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": str(p)},
                        "output": "x",
                    },
                }
            )
        self.fix.agent._last_result["conv1"] = {"parts": parts}
        sent_files = []
        self.fix.agent._send_file_to_conv = AsyncMock(
            side_effect=lambda cid, fp: sent_files.append(fp)
        )

        async def run():
            await self.fix.agent._try_send_files("conv1", "sid", self.tmpdir, "")

        asyncio.get_event_loop().run_until_complete(run())
        self.assertLessEqual(len(sent_files), 5)


class TestBackgroundDispatchIntegration(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.fix = _AgentFixture(self.tmpdir)

    def test_no_intent_skips_file_send(self):
        self.fix.agent._last_user_text["conv1"] = "请解释这段代码"
        self.fix.agent._send_to_conv = AsyncMock()
        self.fix.agent._try_send_files = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.text = "这段代码是..."
        self.fix.agent._wait_for_response = AsyncMock(return_value=mock_resp)

        async def run():
            await self.fix.agent._background_dispatch(
                "conv1", "sid", self.tmpdir, MagicMock(), MagicMock()
            )

        asyncio.get_event_loop().run_until_complete(run())
        self.fix.agent._try_send_files.assert_not_called()

    def test_with_intent_calls_file_send(self):
        self.fix.agent._last_user_text["conv1"] = "把源文件发给我"
        self.fix.agent._send_to_conv = AsyncMock()
        self.fix.agent._try_send_files = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.text = "文件内容如上"
        self.fix.agent._wait_for_response = AsyncMock(return_value=mock_resp)

        async def run():
            await self.fix.agent._background_dispatch(
                "conv1", "sid", self.tmpdir, MagicMock(), MagicMock()
            )

        asyncio.get_event_loop().run_until_complete(run())
        self.fix.agent._try_send_files.assert_called_once_with(
            "conv1", "sid", self.tmpdir, "文件内容如上"
        )

    def test_file_send_exception_doesnt_crash(self):
        self.fix.agent._last_user_text["conv1"] = "发给我"
        self.fix.agent._send_to_conv = AsyncMock()
        self.fix.agent._try_send_files = AsyncMock(side_effect=RuntimeError("boom"))
        mock_resp = MagicMock()
        mock_resp.text = "结果"
        self.fix.agent._wait_for_response = AsyncMock(return_value=mock_resp)

        async def run():
            await self.fix.agent._background_dispatch(
                "conv1", "sid", self.tmpdir, MagicMock(), MagicMock()
            )

        asyncio.get_event_loop().run_until_complete(run())
        self.fix.agent._send_to_conv.assert_called()


class TestSlashCommandsUntouched(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.fix = _AgentFixture(self.tmpdir)

    def test_help_text_unchanged(self):
        self.assertIn("/help", HELP_TEXT)
        self.assertIn("/new", HELP_TEXT)
        self.assertIn("/model", HELP_TEXT)

    def test_commands_no_file_intent(self):
        for cmd in [
            "/new",
            "/stop",
            "/compact",
            "/model",
            "/model list",
            "/agent build",
            "/variant",
            "/autoaccept auto",
            "/project",
            "/project list",
            "/session",
            "/help",
        ]:
            with self.subTest(cmd=cmd):
                self.assertFalse(self.fix.agent._detect_file_intent(cmd))

    def test_file_prompt_keeps_commands_unchanged(self):
        for cmd in [
            "/new",
            "/stop",
            "/compact",
            "/model",
            "/project",
            "/session",
            "/help",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.fix.agent._file_prompt(cmd), cmd)


if __name__ == "__main__":
    unittest.main()
