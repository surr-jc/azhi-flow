"""Says what could and could not be verified in this environment, project by project.

Reads the output of the two preflight runs (the full gate and, when it ran, the static gate), each of which ends with
an AZHI_GATE_RESULT line: JSON with one entry per project and whether its checks passed. A project is `verified` when
its tests passed (by "tests") or, failing that, when its install, typecheck and build passed (by "compile"); it is
`blocked` when neither passed, with the step that failed. When a run printed no result line (an older gate, a repository
with its own test command), the scope says it is not known instead of guessing.

The output is evidence, not a decision: it tells the approver and the reviewers what a "met" can rest on, and it is
printed in the pull request. It never changes whether the run continues.
"""
import json
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MARK = "AZHI_GATE_RESULT "


def last_result(text):
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if line.startswith(MARK):
            try:
                body = json.loads(line[len(MARK):])
            except ValueError:
                return None
            return body if isinstance(body, dict) and isinstance(body.get("projects"), list) else None
    return None


data = json.load(sys.stdin)
runs = [("tests", last_result(data.get("full_output"))), ("compile", last_result(data.get("static_output")))]
projects = {}
for by, result in runs:
    for p in (result or {}).get("projects", []):
        if not isinstance(p, dict) or not isinstance(p.get("dir"), str):
            continue
        key = p["dir"].replace("\\", "/").removeprefix("./") or "."
        row = projects.setdefault(key, {"dir": key, "stack": str(p.get("stack", "")), "by": None, "step": "", "failed_in": ""})
        if p.get("status") == "passed":
            row["by"] = row["by"] or by
        else:
            row["step"] = str(p.get("step", ""))
            row["failed_in"] = by
known = any(result for _, result in runs)
verified = [{"dir": r["dir"], "stack": r["stack"], "by": r["by"]} for r in projects.values() if r["by"]]
blocked = [{"dir": r["dir"], "stack": r["stack"], "step": r["step"], "failed_in": r["failed_in"]} for r in projects.values() if not r["by"]]
print(json.dumps({"known": known, "verified": sorted(verified, key=lambda r: r["dir"]), "blocked": sorted(blocked, key=lambda r: r["dir"])}))
