"""Judges a resolved merge from three test runs and the files, with plain rules and no model.

Reads JSON on stdin: `base`, `head` and `candidate` (each the `tests` of a step: status, exit_code, output), the
checkout commit of the base run and the tip that was merged (`base_run_sha`, `merge_base_sha`), the
`triage` files the resolver started from, and the `files` the resolver handed on.

The checks run in this order, and the first that fails decides:
  invalid       conflict markers are left in a file, the resolver changed a file that had no conflict left, or it
                dropped a change the pull request made (a file the pull request changed is back at the base's text)
  pass          the candidate's tests passed
  regression    the candidate fails and both parents pass (by test id when the runs print them, else by status)
  inconclusive  anything else: no tests ran, a parent also fails, or the base run was on another commit.
                Inconclusive is never a pass: the pull request opens as a draft marked unverified.

A run may print one line `AZHI_RESULT {"failed_ids": [...], "failed_truncated": false}` (a test wrapper can add
it). With it on all three runs, a regression is a test that fails on the candidate and on neither parent.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

OPEN, CLOSE = re.compile(r"^<{7}(\s|$)", re.M), re.compile(r"^>{7}(\s|$)", re.M)


def failed_ids(tests):
    """The set of failed test ids a run printed, or None when it printed none or the list was cut."""
    for line in reversed(str((tests or {}).get("output", "")).splitlines()):
        if line.startswith("AZHI_RESULT "):
            try:
                r = json.loads(line[len("AZHI_RESULT "):])
            except ValueError:
                return None
            return None if r.get("failed_truncated") or not isinstance(r.get("failed_ids"), list) else set(map(str, r["failed_ids"]))
    return None


def main():
    d = json.load(sys.stdin)
    base, head, cand = d.get("base") or {}, d.get("head") or {}, d.get("candidate") or {}
    started = {f["path"]: f for f in d.get("triage_files", [])}
    remaining = {r["path"] for r in d.get("remaining", [])}
    notes, markers, out_of_scope, dropped = [], [], [], []

    handed = {f["path"]: f for f in d.get("files", []) if f.get("status") != "deleted"}
    for path, f in handed.items():
        text = f.get("content") or ""
        if f.get("encoding") != "base64" and OPEN.search(text) and CLOSE.search(text):
            markers.append(path)
        if path not in started:
            out_of_scope.append(f"{path} (a file the merge did not touch)")
        elif path not in remaining and text != started[path].get("content"):
            out_of_scope.append(f"{path} (had no conflict left)")
    for path, f in started.items():
        if f.get("status") != "deleted" and path not in handed and path not in remaining:
            dropped.append(path)

    stale = bool(d.get("base_run_sha")) and d.get("base_run_sha") != d.get("merge_base_sha")
    if stale:
        notes.append("the base branch moved during the run, so the base test run is not the tip that was merged")
    regressions = []
    if markers or out_of_scope or dropped:
        verdict = "invalid"
    elif cand.get("status") == "passed":
        verdict = "pass"
    elif cand.get("status") != "failed":
        verdict = "inconclusive"
        notes.append("the candidate's tests did not run")
    else:
        ids = [failed_ids(base), failed_ids(head), failed_ids(cand)]
        if all(i is not None for i in ids) and not stale:
            regressions = sorted(ids[2] - ids[0] - ids[1])
            verdict = "regression" if regressions else "inconclusive"
            if not regressions:
                notes.append("every failing test also fails on a parent")
        elif base.get("status") == "passed" and head.get("status") == "passed" and not stale:
            verdict = "regression"
            regressions = ["the candidate's tests fail where both the base and the pull request pass"]
        else:
            verdict = "inconclusive"
            notes.append("the candidate's tests fail, but a parent run also failed or was not comparable")
    return {
        "verdict": verdict,
        "ok": verdict in ("pass", "inconclusive"),
        "level": "full" if cand.get("status") == "passed" else "none",
        "regressions": regressions,
        "markers_left": sorted(markers),
        "out_of_scope": sorted(out_of_scope),
        "dropped": sorted(dropped),
        "base_stale": stale,
        "notes": notes,
    }


if __name__ == "__main__":
    json.dump(main(), sys.stdout)
