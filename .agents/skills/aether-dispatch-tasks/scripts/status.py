#!/usr/bin/env python
"""轮询子会话状态 + 读完成会话的最终汇报。
用法：python -X utf8 status.py [status|report <task编号>]

依赖 dispatch.py 落盘的映射 JSON；SERVER/HOME/RESULTS 按本次任务实际路径改。
子会话全在主工作区 directory 下，一次 status 查全部。
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
MODE = sys.argv[1] if len(sys.argv) > 1 else "status"  # status | report <task编号>

q = urllib.parse.quote(HOME, safe="")


def api(path):
    req = urllib.request.Request(SERVER + path)
    token = base64.b64encode(
        f"opencode:{os.environ['OPENCODE_SERVER_PASSWORD']}".encode()
    ).decode()
    req.add_header("Authorization", "Basic " + token)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


results = json.load(open(RESULTS, encoding="utf-8"))

if MODE == "status":
    try:
        st = api(f"/session/status?directory={q}")
    except Exception as err:
        st = {}
        print(f"status error: {err}")
    for r in results:
        if "session" not in r:
            print(f"task{r['task']}: dispatch FAILED")
            continue
        state = st.get(r["session"], {}).get("type", "not-found")
        print(f"task{r['task']} {r['session']}: {state}")
elif MODE == "report":
    target = sys.argv[2]
    for r in results:
        if str(r["task"]) != target or "session" not in r:
            continue
        msgs = api(f"/session/{r['session']}/message?directory={q}")
        texts = []
        for m in msgs:
            for p in m.get("parts", []):
                t = p.get("text", "")
                if t and any(k in t for k in ("Issue", "PR", "github.com", "完成")):
                    texts.append(t)
        print(texts[-1][:2000] if texts else "NO_FINAL_REPORT")
        break
    else:
        print(f"task{target} not found in {RESULTS}")
