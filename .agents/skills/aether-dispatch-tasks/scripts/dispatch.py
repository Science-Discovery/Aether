#!/usr/bin/env python
"""把任务派发到各沙箱：建会话 + prompt_async + 落盘映射。用法：python -X utf8 dispatch.py

改 TASKS 表适配新任务；SERVER 端口按当前实例 netstat 结果改；WT/OUT 按本次任务的实际路径改。
"""

import base64
import json
import os
import urllib.parse
import urllib.request

SERVER = "http://127.0.0.1:19527"  # netstat -ano | grep $OPENCODE_PID 找 LISTENING 端口
WT = "C:/Users/yqma/.local/share/aether/worktree/<worktree-根>"
REPORT = "E:/work/AI/Aether/<报告>.md"
OUT = "E:/work/AI/Aether/dispatch-results.json"

# 权限默认继承派发 agent 的会话：GET /session/<当前sessionID> 读出 permission 字段后填到这里；
# 派发者无显式规则集时给最小 allow 集（headless 无人应答 ask，必须显式 allow）
PERMISSION = [
    {"permission": "bash", "pattern": "*", "action": "allow"},
    {"permission": "edit", "pattern": "*", "action": "allow"},
    {"permission": "write", "pattern": "*", "action": "allow"},
]

# 可选：MODEL = {"providerID": "...", "modelID": "..."}；不设（None）= 用当前默认模型
MODEL = None

TASKS = [
    # (编号, sandbox, 分支, 会话标题, 任务书正文)
]


def api(method, path, body=None):
    req = urllib.request.Request(SERVER + path, method=method)
    token = base64.b64encode(
        f"opencode:{os.environ['OPENCODE_SERVER_PASSWORD']}".encode()
    ).decode()
    req.add_header("Authorization", "Basic " + token)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def main():
    results = []
    for num, sandbox, branch, title, text in TASKS:
        directory = f"{WT}/{sandbox}"
        q = urllib.parse.quote(directory, safe="")
        try:
            sess = (
                api(
                    "POST",
                    f"/session?directory={q}",
                    {"title": title, "permission": PERMISSION},
                )
                or {}
            )
            sid = sess.get("id")
            if not sid:
                raise RuntimeError(f"no session id in response: {sess}")
            prompt = {"parts": [{"type": "text", "text": text}]}
            if MODEL:
                prompt["model"] = MODEL
            api("POST", f"/session/{sid}/prompt_async?directory={q}", prompt)
            results.append(
                {
                    "task": num,
                    "sandbox": sandbox,
                    "branch": branch,
                    "session": sid,
                    "title": title,
                }
            )
            print(f"task{num} -> {sandbox} ({branch}): {sid}")
        except Exception as err:
            results.append({"task": num, "sandbox": sandbox, "error": str(err)})
            print(f"task{num} -> {sandbox}: FAILED {err}")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
