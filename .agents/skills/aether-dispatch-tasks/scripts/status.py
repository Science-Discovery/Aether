#!/usr/bin/env python
"""轮询状态 + 读完成会话的汇报。
用法：python -X utf8 status.py [status|report <task编号>|mreport <task编号>]

status：监视会话状态（主工作区一次查全部）+ 各任务会话状态（各自沙箱 directory 单查；
        /session/status 按 directory 实例隔离，沙箱里的任务会话必须用沙箱路径查）。
report <n>：任务会话最新汇报；mreport <n>：监视会话最新汇报。
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
MODE = (
    sys.argv[1] if len(sys.argv) > 1 else "status"
)  # status | report <n> | mreport <n>

home_q = urllib.parse.quote(HOME, safe="")


def api(path):
    req = urllib.request.Request(SERVER + path)
    token = base64.b64encode(
        f"opencode:{os.environ['OPENCODE_SERVER_PASSWORD']}".encode()
    ).decode()
    req.add_header("Authorization", "Basic " + token)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


def state(directory_q, sid):
    try:
        return (
            api(f"/session/status?directory={directory_q}")
            .get(sid, {})
            .get("type", "not-found")
        )
    except Exception as err:
        return f"status-error: {err}"


def report(sid, directory_q, label):
    msgs = api(f"/session/{sid}/message?directory={directory_q}")
    keys = ("commit", "分支", "完成", "PASS", "受阻")
    texts = [
        p.get("text", "")
        for m in msgs
        for p in m.get("parts", [])
        if p.get("text") and any(k in p.get("text") for k in keys)
    ]
    print(texts[-1][:2000] if texts else f"NO_FINAL_REPORT ({label})")


results = json.load(open(RESULTS, encoding="utf-8"))

if MODE == "status":
    try:
        mons = api(f"/session/status?directory={home_q}")
    except Exception as err:
        mons = {}
        print(f"monitor status error: {err}")
    for r in results:
        if "monitor" not in r:
            print(f"task{r['task']}: dispatch FAILED")
            continue
        mon = mons.get(r["monitor"], {}).get("type", "not-found")
        task = state(urllib.parse.quote(r["worktree"], safe=""), r["session"])
        print(
            f"task{r['task']}: monitor {r['monitor']}={mon} | task {r['session']}={task}"
        )
elif MODE in ("report", "mreport"):
    target = sys.argv[2]
    key = "session" if MODE == "report" else "monitor"
    for r in results:
        if str(r["task"]) != target or key not in r:
            continue
        q = home_q if MODE == "mreport" else urllib.parse.quote(r["worktree"], safe="")
        report(r[key], q, MODE)
        break
    else:
        print(f"task{target} ({key}) not found in {RESULTS}")
else:
    print(f"bad mode: {MODE}")
