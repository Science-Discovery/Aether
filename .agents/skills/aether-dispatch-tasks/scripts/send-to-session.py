#!/usr/bin/env python
"""把消息发回某个会话，不新开会话。
用法：python -X utf8 send-to-session.py <task编号> <task|monitor> <消息文件路径>

task    → 沙箱里的任务会话（directory=沙箱路径）：续跑指令/返工指令一般由监视会话发，主 agent 异常介入时也可用。
monitor → 主工作区的监视子会话（directory=主工作区路径）：看门续跑指令。
依赖 dispatch.py 落盘的映射 JSON；SERVER/HOME/RESULTS 按本次任务实际路径改。
"""

import base64
import json
import os
import sys
import urllib.parse
import urllib.request

SERVER = "http://127.0.0.1:19527"
HOME = "E:/work/AI/Aether/aether-dev"  # 主工作区（与 dispatch.py 的 HOME 一致）
RESULTS = "E:/work/AI/Aether/dispatch-results.json"


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
    target, role, msg_file = sys.argv[1], sys.argv[2], sys.argv[3]
    if role not in ("task", "monitor"):
        print(f"bad role: {role} (use task|monitor)")
        return
    text = open(msg_file, encoding="utf-8").read()
    results = json.load(open(RESULTS, encoding="utf-8"))
    key = "session" if role == "task" else "monitor"
    for r in results:
        if str(r["task"]) != target or key not in r:
            continue
        q = urllib.parse.quote(HOME if role == "monitor" else r["worktree"], safe="")
        api(
            "POST",
            f"/session/{r[key]}/prompt_async?directory={q}",
            {"parts": [{"type": "text", "text": text}]},
        )
        print(f"task{target} -> {role} session {r[key]}: sent")
        return
    print(f"task{target} ({role}) not found in {RESULTS}")


if __name__ == "__main__":
    main()
