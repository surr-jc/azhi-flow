"""Turns what the probe step did into one result per attack scenario, with plain rules and no model.

Reads JSON on stdin: {surface, probe}. `surface` is the attack planner's output (scenarios, executable);
`probe` is the prober's output, which the worker extended with `workspace` (the files it wrote and the result of
running the test command, i.e. the trusted probe runner). The prober only says how it meant to test each scenario;
what happened comes from the runner's lines:

  AZHI_PROBE {"id":"P1","state":"reproduced"|"held"|"not_run","exit":0,"observed":"...","reason":"..."}
  AZHI_PROBES_DONE <n>

A scenario ends as
  reproduced   the runner saw the probe print REPRODUCED
  ruled_out    the probe printed HELD (L3 - Executed), or the prober walked the code and showed the path unreachable (L2)
  unproven     anything else: not run, timed out, no runner, probe invalid, or a static walk that could not decide
A change anywhere outside .azhi-probes/ makes every executed probe invalid: the prober was told never to do that.
"""
import json
import re
import sys

PREFIX = ".azhi-probes/"
LEVEL_EXEC = {"cli": "L4 - Reproduced", "http": "L4 - Reproduced"}
SEVERITY = {"high": "blocker", "medium": "major", "low": "minor"}  # the refuter regrades; P findings use the same scale
LOC = re.compile(r"([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)")


def clean(s, n=400):
    """Plain, short, single-line text that cannot mention or ping anyone when it ends up in a PR comment."""
    return re.sub(r"\s+", " ", str(s or "")).replace("`", "'").replace("@", "@​").strip()[:n]


d = json.load(sys.stdin)
surface, probe = d.get("surface") or {}, d.get("probe") or {}
ws = probe.get("workspace") or {}
tests = ws.get("tests") or {}
text = tests.get("output") or ""
files = ws.get("files") or []

runner = {}
for m in re.finditer(r"^AZHI_PROBE (\{.*\})\s*$", text, re.M):
    try:
        r = json.loads(m.group(1))
        runner.setdefault(str(r.get("id")), r)
    except ValueError:
        pass
ran = bool(re.search(r"^AZHI_PROBES_DONE \d+", text, re.M))
dirty = sorted(f["path"] for f in files if not str(f.get("path", "")).startswith(PREFIX))


def probe_files(pid):
    out = []
    for f in files:
        p = str(f.get("path", ""))
        if p.startswith(f"{PREFIX}{pid}/") and f.get("status") != "deleted":
            body = f.get("content", "") if f.get("encoding", "utf-8") == "utf-8" else "(binary file)"
            out.append({"path": p, "content": body[:4000]})
    return out


def command_of(pf):
    for f in pf:
        if f["path"].endswith("/probe.json"):
            try:
                return " ".join(json.loads(f["content"]).get("argv", []))[:300]
            except ValueError:
                return ""
    return ""


claimed = {str(s.get("id")): s for s in (probe.get("scenarios") or [])}
results, findings = [], []
for s in surface.get("scenarios") or []:
    sid = s["id"]
    c = claimed.get(sid)
    pf = probe_files(sid)
    base = {"id": sid, "title": s["title"], "class": s["class"], "impact": s["impact"], "likelihood": s["likelihood"], "decisive": bool(s["decisive"]), "kind": s["probe_kind"], "mechanism": s["mechanism"], "mode": "executed", "state": "unproven", "level": "none", "observed": "", "reason": "", "command": command_of(pf), "probe_files": pf}
    static = s["probe_kind"] == "static" or (c is not None and c.get("mode") == "static")
    if c is None:
        base.update(reason="the prober did not report this scenario")
    elif static:
        base["mode"] = "static"
        if c.get("static_result") == "ruled_out":
            base.update(state="ruled_out", level="L2 - Ruled out", reason=clean(c.get("reason")))
        else:
            base.update(reason=clean(c.get("reason")) or "it could only be walked by reading, and the walk did not settle it")
    elif dirty:
        base.update(reason="probe invalid: the checkout changed outside .azhi-probes/ (" + clean(", ".join(dirty[:5]), 200) + ")")
    elif not ran:
        base.update(reason=f"the probe runner did not run (setup command failed or timed out; test exit code {tests.get('exit_code')})")
    elif sid not in runner:
        base.update(reason="no probe was written for it (no .azhi-probes/%s/probe.json)" % sid)
    else:
        r = runner[sid]
        if r.get("state") == "reproduced":
            base.update(state="reproduced", level=LEVEL_EXEC.get(s["probe_kind"], "L3 - Executed"), observed=clean(r.get("observed")))
        elif r.get("state") == "held":
            base.update(state="ruled_out", level="L3 - Executed", observed=clean(r.get("observed")))
        else:
            base.update(reason=clean(r.get("reason")) or "the probe did not run")
    results.append(base)
    if base["state"] == "reproduced":
        loc = LOC.search(s["mechanism"])
        findings.append({
            "id": sid,
            "severity": SEVERITY.get(s["impact"], "major"),
            "path": loc.group(1) if loc else "",
            "line": int(loc.group(2)) if loc else 0,
            "title": s["title"],
            "detail": clean(s["mechanism"], 600),
            "scenario": clean(f"{s['title']}. Probe observed: {base['observed']}", 500),
            "probe": "\n\n".join(f"{f['path']}:\n{f['content']}" for f in pf)[:6000],
        })

json.dump({"runner_ran": ran, "dirty_paths": dirty, "scenarios": results, "findings": findings}, sys.stdout)
