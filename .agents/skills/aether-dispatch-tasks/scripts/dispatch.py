#!/usr/bin/env python
"""把任务派发到沙箱（每任务两步）：
① POST /session?directory=<沙箱> 建任务会话 + prompt_async 任务书 → 任务一定跑在沙箱；
② POST /session?directory=<主工作区> 建监视子会话 + prompt_async 监视任务书（看守①）。
最后落盘 task↔任务会话↔监视会话↔worktree 映射，供 status.py / send-to-session.py 用。
用法：python -X utf8 dispatch.py

改 TASKS 表适配新任务；SERVER/HOME/OUT 按本次任务的实际路径改。
worktree 分配（复用或新建）在跑本脚本前由主 agent 用 git 命令完成，路径填进 TASKS。
监视任务书模板读自 ../references/monitor-prompt.md，占位符在下方填充。
"""

import base64
import json
import os
import urllib.parse
import urllib.request

SERVER = "http://127.0.0.1:19527"  # netstat -ano | grep $OPENCODE_PID 找 LISTENING 端口
HOME = "E:/work/AI/Aether/aether-dev"  # 主工作区（监视子会话建在这里）
OUT = "E:/work/AI/Aether/dispatch-results.json"
MONITOR_TMPL = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "references", "monitor-prompt.md"
)

# 权限默认继承派发 agent 的会话：GET /session/<当前sessionID> 读出 permission 字段后填到这里；
# 派发者无显式规则集时给最小 allow 集（headless 无人应答 ask，必须显式 allow）
PERMISSION = [
    {"permission": "bash", "pattern": "*", "action": "allow"},
    {"permission": "edit", "pattern": "*", "action": "allow"},
    {"permission": "write", "pattern": "*", "action": "allow"},
]

# (编号, worktree绝对路径, 分支, 会话标题, 任务书正文, 参考报告路径,
#  可选 per-task 覆盖: {"model": {...}, "permission": [...]})
TASKS = [
    # ("bug1", "C:/Users/yqma/.local/share/aether/worktree/<root>/sandbox-1",
    #  "fix/bug1", "task bug1", open("prompts/bug1.md", encoding="utf-8").read(),
    #  "E:/work/AI/Aether/reports/bug1.md",
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


def fill(tmpl, values):
    for key, val in values.items():
        tmpl = tmpl.replace("{" + key + "}", val)
    return tmpl


def main():
    home_q = urllib.parse.quote(HOME, safe="")
    tmpl = open(MONITOR_TMPL, encoding="utf-8").read()
    results = []
    for task in TASKS:
        num, worktree, branch, title, text, report = task[:6]
        extra = task[6] if len(task) > 6 else {}
        permission = extra.get("permission", PERMISSION)
        model = extra.get("model")
        sandbox_q = urllib.parse.quote(worktree, safe="")
        sid = None
        mid = None
        try:
            sess = (
                api(
                    "POST",
                    f"/session?directory={sandbox_q}",
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
            api("POST", f"/session/{sid}/prompt_async?directory={sandbox_q}", prompt)

            mon_title = f"monitor {title}"
            mon = (
                api(
                    "POST",
                    f"/session?directory={home_q}",
                    {"title": mon_title, "permission": permission},
                )
                or {}
            )
            mid = mon.get("id")
            if not mid:
                raise RuntimeError(f"no monitor session id in response: {mon}")
            mon_text = fill(
                tmpl,
                {
                    "NUM": str(num),
                    "TITLE": title,
                    "BRANCH": branch,
                    "REPORT": report,
                    "SANDBOX": worktree,
                    "SANDBOX_Q": sandbox_q,
                    "TASK_SESSION": sid,
                },
            )
            api(
                "POST",
                f"/session/{mid}/prompt_async?directory={home_q}",
                {"parts": [{"type": "text", "text": mon_text}]},
            )

            results.append(
                {
                    "task": num,
                    "worktree": worktree,
                    "branch": branch,
                    "session": sid,
                    "monitor": mid,
                    "title": title,
                }
            )
            print(f"task{num} -> {worktree} ({branch}): task={sid} monitor={mid}")
        except Exception as err:
            row = {"task": num, "worktree": worktree, "error": str(err)}
            if sid:
                row["session"] = sid  # 任务会话可能已在沙箱起跑，必须留痕供监控接管
            if mid:
                row["monitor"] = mid
            results.append(row)
            print(f"task{num} -> {worktree}: FAILED {err}")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
