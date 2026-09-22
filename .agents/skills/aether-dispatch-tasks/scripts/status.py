#!/usr/bin/env python
"""轮询各沙箱会话状态 + 读完成会话的最终汇报。
用法：python -X utf8 status.py [status|report <task编号>]

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
MODE = sys.argv[1] if len(sys.argv) > 1 else "status"  # status | report <task编号>


def api(path):
    req = urllib.request.Request(SERVER + path)
    token = base64.b64encode(
        f"opencode:{os.environ['OPENCODE_SERVER_PASSWORD']}".encode()
    ).decode()
    req.add_header("Authorization", "Basic " + token)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


results = json.load(open(RESULTS, encoding="utf-8"))
WT = "C:/Users/yqma/.local/share/aether/worktree/<worktree-根>"

if MODE == "status":
    for r in results:
        q = urllib.parse.quote(f"{WT}/{r['sandbox']}", safe="")
        try:
            st = (
                api(f"/session/status?directory={q}")
                .get(r["session"], {})
                .get("type", "not-found")
            )
        except Exception as err:
            st = f"error: {err}"
        print(f"task{r['task']} {r['session']}: {st}")
elif MODE == "report":
    target = sys.argv[2]
    for r in results:
        if str(r["task"]) != target:
            continue
        q = urllib.parse.quote(f"{WT}/{r['sandbox']}", safe="")
        msgs = api(f"/session/{r['session']}/message?directory={q}")
        texts = []
        for m in msgs:
            for p in m.get("parts", []):
                t = p.get("text", "")
                if t and any(k in t for k in ("Issue", "PR", "github.com", "完成")):
                    texts.append(t)
        print(texts[-1][:2000] if texts else "NO_FINAL_REPORT")
