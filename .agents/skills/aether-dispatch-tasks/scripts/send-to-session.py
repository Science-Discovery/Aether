#!/usr/bin/env python
"""把消息（review 结果/返工指令/PASS 放行通知）发回原始会话，不新开会话。
用法：python -X utf8 send-to-session.py <task编号> <消息文件路径>

依赖 dispatch.py 落盘的映射 JSON；SERVER/WT/RESULTS 按本次任务实际路径改。
"""

import base64
import json
import os
import sys
import urllib.parse
import urllib.request

SERVER = "http://127.0.0.1:19527"
RESULTS = "E:/work/AI/Aether/dispatch-results.json"
WT = "C:/Users/yqma/.local/share/aether/worktree/<worktree-根>"


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
    target, msg_file = sys.argv[1], sys.argv[2]
    text = open(msg_file, encoding="utf-8").read()
    results = json.load(open(RESULTS, encoding="utf-8"))
    for r in results:
        if str(r["task"]) != target:
            continue
        q = urllib.parse.quote(f"{WT}/{r['sandbox']}", safe="")
        api(
            "POST",
            f"/session/{r['session']}/prompt_async?directory={q}",
            {"parts": [{"type": "text", "text": text}]},
        )
        print(f"task{target} -> session {r['session']}: sent")
        return
    print(f"task{target} not found in {RESULTS}")


if __name__ == "__main__":
    main()
