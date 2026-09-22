#!/usr/bin/env python
"""把任务派发到子会话（主工作区 directory 下建会话 + prompt_async + 落盘映射）。
用法：python -X utf8 dispatch.py

改 TASKS 表适配新任务；SERVER/HOME/OUT 按本次任务的实际路径改。
worktree 分配（复用或新建）在跑本脚本前由主 agent 用 git 命令完成，路径填进 TASKS。
"""

import base64
import json
import os
import urllib.parse
import urllib.request

SERVER = "http://127.0.0.1:19527"  # netstat -ano | grep $OPENCODE_PID 找 LISTENING 端口
HOME = "E:/work/AI/Aether/aether-dev"  # 主工作区（子会话全部建在这里）
OUT = "E:/work/AI/Aether/dispatch-results.json"

# 权限默认继承派发 agent 的会话：GET /session/<当前sessionID> 读出 permission 字段后填到这里；
# 派发者无显式规则集时给最小 allow 集（headless 无人应答 ask，必须显式 allow）
PERMISSION = [
    {"permission": "bash", "pattern": "*", "action": "allow"},
    {"permission": "edit", "pattern": "*", "action": "allow"},
    {"permission": "write", "pattern": "*", "action": "allow"},
]

# 模型默认不传（子会话用当前默认模型）；需要分模型时在 TASKS 表 per-task 覆盖

# (编号, worktree绝对路径, 分支, 会话标题, 任务书正文,
#  可选 per-task 覆盖: {"model": {...}, "permission": [...]})
TASKS = [
    # ("bug1", "C:/Users/yqma/.local/share/aether/worktree/<root>/sandbox-1",
    #  "fix/bug1", "task bug1", open("prompts/bug1.md", encoding="utf-8").read(),
    #  {"model": {"providerID": "...", "modelID": "..."}}),
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
    q = urllib.parse.quote(HOME, safe="")
    results = []
    for task in TASKS:
        num, worktree, branch, title, text = task[:5]
        extra = task[5] if len(task) > 5 else {}
        permission = extra.get("permission", PERMISSION)
        model = extra.get("model")
        try:
            sess = (
                api(
                    "POST",
                    f"/session?directory={q}",
                    {"title": title, "permission": permission},
                )
                or {}
            )
            sid = sess.get("id")
            if not sid:
                raise RuntimeError(f"no session id in response: {sess}")
            prompt = {"parts": [{"type": "text", "text": text}]}
            if model:
                prompt["model"] = model
            api("POST", f"/session/{sid}/prompt_async?directory={q}", prompt)
            results.append(
                {
                    "task": num,
                    "worktree": worktree,
                    "branch": branch,
                    "session": sid,
                    "title": title,
                }
            )
            print(f"task{num} -> {worktree} ({branch}): {sid}")
        except Exception as err:
            results.append({"task": num, "worktree": worktree, "error": str(err)})
            print(f"task{num} -> {worktree}: FAILED {err}")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
