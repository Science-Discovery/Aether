"""
Aether WeChat Bridge - 将 Aether AI 接入微信
使用 wechat-agent-sdk 通过 HTTP API 调用 Aether 服务

使用方法:
1. 启动 Aether 服务: ./aether serve --port 4096
2. 运行此脚本: python aether_wechat_agent.py
3. 扫描终端显示的二维码登录微信
"""

import asyncio
import os
import sys
from pathlib import Path
from typing import Optional
import httpx
from wechat_agent_sdk import Agent, ChatRequest, ChatResponse, WeChatBot


class AetherAgent(Agent):
    """
    Aether 微信 Agent
    通过 HTTP API 连接到运行中的 Aether 服务
    """

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
        self._sessions: dict[str, str] = {}  # conversation_id -> session_id

    async def on_start(self) -> None:
        """初始化 HTTP 客户端"""
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(300.0, connect=30.0),
            headers={"Content-Type": "application/json"},
        )
        print(f"[Aether] 已连接到 {self.base_url}")
        print(f"[Aether] 工作目录: {self.directory}")
        if self.default_model:
            print(f"[Aether] 默认模型: {self.default_model}")
        print(f"[Aether] 默认 Agent: {self.default_agent}")

    async def on_stop(self) -> None:
        """清理资源"""
        if self._client:
            await self._client.aclose()
        print("[Aether] 已断开连接")

    async def chat(self, request: ChatRequest) -> ChatResponse:
        """处理微信消息"""
        if not self._client:
            return ChatResponse(text="错误: 客户端未初始化")

        conv_id = request.conversation_id
        user_text = request.text

        # 处理群聊 @ 消息
        if request.group_id and request.is_at_bot:
            print(f"[群聊] {request.sender_name}: {user_text}")
        else:
            print(f"[私聊] {conv_id}: {user_text}")

        try:
            session_id = self._sessions.get(conv_id)

            if not session_id:
                session_id = await self._create_session()
                self._sessions[conv_id] = session_id
                print(f"[Aether] 创建新会话: {session_id[:8]}...")

            response = await self._send_message(session_id, user_text)

            # 打印 AI 思考和回复到终端
            if response.get("reasoning"):
                print(
                    f"[思考] {response['reasoning'][:200]}{'...' if len(response['reasoning']) > 200 else ''}"
                )
            if response.get("text"):
                print(
                    f"[回复] {response['text'][:200]}{'...' if len(response['text']) > 200 else ''}"
                )

            # 构建微信回复消息
            return ChatResponse(text=response.get("formatted", "操作已完成"))

        except httpx.HTTPStatusError as e:
            error_body = e.response.text
            error_msg = f"HTTP 错误: {e.response.status_code} - {error_body}"
            print(f"[错误] {error_msg}")
            return ChatResponse(text=f"服务暂时不可用，请稍后重试")

        except httpx.RequestError as e:
            error_msg = f"连接错误: {str(e)}"
            print(f"[错误] {error_msg}")
            return ChatResponse(text="无法连接到 Aether 服务，请确认服务已启动")

        except Exception as e:
            error_msg = f"未知错误: {str(e)}"
            print(f"[错误] {error_msg}")
            return ChatResponse(text=f"处理消息时出错: {str(e)}")

    async def _create_session(self) -> str:
        """创建新的 Aether 会话"""
        resp = await self._client.post(
            f"{self.base_url}/session",
            json={},
        )
        resp.raise_for_status()
        return resp.json()["id"]

    async def _send_message(self, session_id: str, text: str) -> dict:
        """发送消息到 Aether 并获取响应"""
        payload: dict = {
            "parts": [{"type": "text", "text": text}],
            "agent": self.default_agent,
        }

        if self.default_model:
            if "/" in self.default_model:
                provider, model = self.default_model.split("/", 1)
                payload["model"] = {
                    "providerID": provider,
                    "modelID": model,
                }
            else:
                payload["model"] = self.default_model

        resp = await self._client.post(
            f"{self.base_url}/session/{session_id}/message",
            json=payload,
        )
        resp.raise_for_status()
        result = resp.json()

        return self._extract_response(result)

    def _extract_response(self, result: dict) -> dict:
        """从 Aether 响应中提取思考和回复内容"""
        parts = result.get("parts", [])

        reasoning_parts = []
        text_parts = []
        tool_parts = []

        for part in parts:
            part_type = part.get("type")

            if part_type == "reasoning" and part.get("text"):
                reasoning_parts.append(part["text"])

            elif part_type == "text" and part.get("text"):
                text_parts.append(part["text"])

            elif part_type == "tool":
                tool_name = part.get("tool", "unknown")
                state = part.get("state", {})
                status = state.get("status", "unknown")

                if status == "completed":
                    output = state.get("output", "")
                    if output and len(output) < 500:
                        tool_parts.append(f"[{tool_name}] {output}")
                elif status == "error":
                    error = state.get("error", "未知错误")
                    tool_parts.append(f"[{tool_name} 错误] {error}")

        # 构建结果
        reasoning = "\n".join(reasoning_parts) if reasoning_parts else ""
        text = "\n\n".join(text_parts + tool_parts) if text_parts or tool_parts else ""

        # 构建微信格式化消息
        formatted_parts = []
        if text:
            formatted_parts.append(text)

        formatted = (
            "\n\n─────────\n\n".join(formatted_parts)
            if formatted_parts
            else "操作已完成"
        )

        return {
            "reasoning": reasoning,
            "text": text,
            "formatted": formatted,
        }


async def main():
    """主函数"""
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

    bot = WeChatBot(agent=agent)

    try:
        await bot.run()
    except KeyboardInterrupt:
        print("\n[Aether] 正在关闭...")


if __name__ == "__main__":
    asyncio.run(main())
