"""向多个目录并行派发自主体任务（通用，与任务内容无关）。

用法:
  1. 修改 ITEMS 列表: (标识, 目录绝对路径, 任务正文)
  2. 修改 TEMPLATE（公共任务书模板，占位符 {ID} {DIR} {EXTRA}）
     模板参考: references/task-brief-template.md
  3. python dispatch.py            # 派发 + 落盘 dispatch-results.json
     python dispatch.py --status   # 检查派发会话的运行状态

环境要求: OPENCODE_SERVER_PASSWORD（本实例注入）; 端口从 netstat 查 OPENCODE_PID 得到,
默认 19527，不对则改 SERVER。
"""

import base64
import json
import os
import sys
import urllib.parse
import urllib.request

SERVER = "http://127.0.0.1:19527"
RESULTS = "dispatch-results.json"

TEMPLATE = """你是任务 agent，负责第 {ID} 项。你在独立目录 {DIR} 中工作，可放心读写文件。

## 准备步骤（必做，按序）
1. 读输入材料，确认目标；若与描述不符，停止并汇报原因。

## 执行要求
- 优雅、健壮、最小侵入。
- 尽量用 subagents（Task 工具）并行处理独立子问题，你负责汇总与关键决策。

## 验证要求
- 运行适用的检查命令并在汇报中给出结果。

## 边界
- 只处理第 {ID} 项，不要顺手处理其他项。
- 最终汇报：改动摘要、验证结果、产出链接、未解决项。

## 任务内容
"""

ITEMS = [
    # ("id-1", "C:/path/to/dir-1", "任务 1 的正文"),
    # ("id-2", "C:/path/to/dir-2", "任务 2 的正文"),
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
        if not raw:
            return None
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"value": parsed}


def dispatch():
    out = []
    for item_id, directory, extra in ITEMS:
        q = urllib.parse.quote(directory, safe="")
        sess = api("POST", f"/session?directory={q}", {"title": f"task {item_id}"})
        if not sess:
            raise RuntimeError(f"empty session response for {item_id}")
        sid = sess["id"]
        text = TEMPLATE.replace("{ID}", item_id).replace("{DIR}", directory) + extra
        api(
            "POST",
            f"/session/{sid}/prompt_async?directory={q}",
            {"parts": [{"type": "text", "text": text}]},
        )
        out.append({"id": item_id, "dir": directory, "session": sid})
        print(f"{item_id} -> {directory}: {sid}")
    with open(RESULTS, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def status():
    results = json.load(open(RESULTS, encoding="utf-8"))
    for r in results:
        q = urllib.parse.quote(r["dir"], safe="")
        try:
            status_map = api("GET", f"/session/status?directory={q}") or {}
            st = status_map.get(r["session"], {}).get("type", "not-found")
        except Exception as err:
            st = f"error: {err}"
        print(f"{r['id']} {r['session']}: {st}")


if __name__ == "__main__":
    status() if "--status" in sys.argv else dispatch()
