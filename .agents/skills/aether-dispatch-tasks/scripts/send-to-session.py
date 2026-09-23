#!/usr/bin/env python
"""把消息（异常介入指令/叫停/补充信息）发回某个子会话，不新开会话。
用法：python -X utf8 send-to-session.py <task编号> <消息文件路径>

依赖 dispatch.py 落盘的映射 JSON；SERVER/HOME/RESULTS 按本次任务实际路径改。
正常 review/返工流程不需要本脚本——那是子会话自己的职责；仅异常介入时用。
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
    target, msg_file = sys.argv[1], sys.argv[2]
    text = open(msg_file, encoding="utf-8").read()
    results = json.load(open(RESULTS, encoding="utf-8"))
    for r in results:
        if str(r["task"]) != target or "session" not in r:
            continue
        q = urllib.parse.quote(HOME, safe="")
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
